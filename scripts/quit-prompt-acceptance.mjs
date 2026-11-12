import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const automationScript = fileURLToPath(new URL('./windows-quit-prompt.ps1', import.meta.url));

async function ui(action, pid) {
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', automationScript,
      '-Action', action, '-ProcessId', String(pid),
    ], { timeout: 20000, windowsHide: true });
    if (stdout.trim()) console.log(stdout.trim());
  } catch {
    throw new Error(`Windows native quit UI action failed: ${action}`);
  }
}

export async function quitPromptAcceptance(app, page, graphics) {
  const process = app.process();
  assert.ok(process?.pid, 'packaged TUS main process has a PID');
  const pid = process.pid;
  const before = await page.evaluate(async () => {
    const settings = await window.tus.loadSettings();
    const world = await window.tus.request({ ...settings, path: '/state' });
    return {
      workspacePath: settings.workspacePath,
      codexPath: settings.codexPath,
      threadId: settings.threadId,
      worldObjects: world.objects,
    };
  });
  let timer;
  const exited = new Promise((resolve, reject) => {
    process.once('exit', code => resolve(code));
    process.once('error', reject);
  });
  try {
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error('The packaged TUS window is unavailable.'); window.close(); });
    await ui('keep-open', pid);
    assert.equal(process.exitCode, null, 'Keep the game open leaves the packaged process running');
    await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'), null, { timeout: 10000 });
    const afterCancel = await page.evaluate(async () => {
      const settings = await window.tus.loadSettings();
      const world = await window.tus.request({ ...settings, path: '/state' });
      return {
        workspacePath: settings.workspacePath,
        codexPath: settings.codexPath,
        threadId: settings.threadId,
        worldObjects: world.objects,
      };
    });
    assert.deepEqual(afterCancel, before, 'canceling the native prompt leaves settings and world unchanged');
    await graphics.assertHealthy();
    await ui('file-exit', pid);
    await ui('quit-anyway', pid);
    const exitCode = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged TUS did not exit after Quit anyway.')), 15000); }),
    ]);
    assert.equal(exitCode, 0, 'Quit anyway exits the packaged client cleanly');
  } catch (error) {
    if (process.exitCode === null) {
      try { await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true }); } catch {}
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
