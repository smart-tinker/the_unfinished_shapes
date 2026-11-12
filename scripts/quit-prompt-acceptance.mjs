import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const automationScript = fileURLToPath(new URL('./windows-quit-prompt.ps1', import.meta.url));

async function ui(action, pid, menuKey) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', automationScript,
    '-Action', action, '-ProcessId', String(pid),
  ];
  if (action === 'file-menu-exit') args.push('-MenuKey', menuKey);
  const { error, stdout, stderr } = await new Promise(resolve => {
    execFile('powershell.exe', args, { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  if (error) {
    const output = [stdout, stderr].map(value => String(value ?? '')).join('\n');
    const markers = output.split(/\r?\n/).map(line => line.trim()).filter(line => /^TUS_UIA: [a-z0-9-]+$/i.test(line));
    const marker = markers.slice(-3).join(' after ');
    const stderrLine = String(stderr ?? '').split(/\r?\n/).map(line => line.trim()).find(line => line && !/^(?:At\s|CategoryInfo|FullyQualifiedErrorId|[+~])/.test(line));
    const processFailure = error.killed
      ? 'timeout-' + String(error.signal ?? 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '')
      : 'exit-' + (String(error.code ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown');
    const detail = marker || stderrLine?.replace(/[A-Z]:\\[^\s'"]+/gi, '<path>').replace(/https?:\/\/\S+/gi, '<url>').slice(0, 160) || processFailure;
    throw new Error('Windows native quit UI action failed: ' + action + (detail ? ' (' + (detail.startsWith('TUS_UIA:') ? detail.slice(8) : detail) + ')' : ''));
  }
  if (stdout.trim()) console.log(stdout.trim());
  return stdout.trim();
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
    const closePrompt = await ui('keep-open', pid);
    assert.match(closePrompt, /^TUS_UIA: exact-foreground-prompt-matched$/m, 'window-close prompt is the exact TUS dialog');
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
    const exitMenuKey = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const file = menu?.items.find(item => item.label.replace(/&/g, '').trim() === 'File');
      const exits = (file?.submenu?.items ?? []).filter(item => item.enabled !== false && item.visible !== false &&
        (item.role === 'quit' || ['Exit', 'Quit'].includes(item.label.replace(/&/g, '').trim())));
      if (exits.length !== 1) return null;
      const label = exits[0].label.replace(/&/g, '').trim();
      return ['Exit', 'Quit'].includes(label) ? label[0].toLowerCase() : null;
    });
    assert.ok(['e', 'q'].includes(exitMenuKey), 'Electron File menu exposes one exact Exit/Quit command');
    const fileMenuOpened = await app.evaluate(({ BrowserWindow, Menu }) => {
      const menu = Menu.getApplicationMenu();
      const file = menu?.items.find(item => item.label.replace(/&/g, '').trim() === 'File');
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === 'The Unfinished Shapes');
      if (!file?.submenu || !window) return false;
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 5000);
        file.submenu.once('menu-will-show', () => { clearTimeout(timer); resolve(true); });
        file.submenu.popup({ window });
      });
    });
    assert.equal(fileMenuOpened, true, 'Electron File submenu opens on the exact TUS window');
    await ui('file-menu-exit', pid, exitMenuKey);
    const exitPrompt = await ui('quit-anyway', pid);
    assert.match(exitPrompt, /^TUS_UIA: exact-foreground-prompt-matched$/m, 'File → Exit prompt is the exact TUS dialog');
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
