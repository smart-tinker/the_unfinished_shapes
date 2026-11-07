import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

// This test intentionally touches the real per-user app directory only on a disposable runner.
if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.RUNNER_OS !== 'Windows') {
  throw new Error('Run installer smoke only on a disposable Windows GitHub Actions runner.');
}
const run = promisify(execFile);
const work = await mkdtemp(path.join(os.tmpdir(), 'tus-installer-'));
const dataDir = path.join(process.env.APPDATA, 'the-unfinished-shapes');
try { await access(dataDir); throw new Error('Refusing to modify a pre-existing app data directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const installerFiles = (await readdir('dist/installer')).filter(name => name.endsWith('.exe'));
assert.equal(installerFiles.length, 1, 'exactly one installer must be built');
const installer = path.resolve('dist/installer', installerFiles[0]);
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'TUS-Installer-Smoke');
try { await access(installDir); throw new Error('Refusing to replace an existing installation.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const settingsFixture = {
  workspacePath: path.join(work, 'player-workspace'), codexPath: path.join(work, 'codex.exe'),
  serverUrl: '', threadId: 'saved-game-thread-fixture', token: 'test-value-that-must-not-be-saved'
};
await mkdir(settingsFixture.workspacePath, { recursive: true });
let instance;
async function launch(executablePath) {
  instance = await electron.launch({ executablePath, args: ['--no-sandbox'], env: { ...process.env, TUS_DATA_DIR: '' }, timeout: 45000 });
  const page = await instance.firstWindow();
  const actualDataDir = await instance.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(path.resolve(actualDataDir).toLowerCase(), path.resolve(dataDir).toLowerCase(), 'stable default user-data path');
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'), null, { timeout: 30000 });
  assert.equal(await page.locator('#scene-error').isVisible(), false, 'WebGL scene must render');
  return page;
}
async function close() { await instance?.close(); instance = null; }
async function uninstall() {
  const uninstaller = (await readdir(installDir)).find(name => /^Uninstall.*\.exe$/i.test(name));
  assert.ok(uninstaller, 'uninstaller exists');
  await run(path.join(installDir, uninstaller), ['/S'], { timeout: 180000 });
  // NSIS may hand off to a temporary copy of itself before the original exits.
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await access(path.join(installDir, 'TheUnfinishedShapes.exe')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Uninstaller did not remove the installed executable.');
}
async function verifyRestored(page) {
  const settings = await page.evaluate(() => window.tus.loadSettings());
  for (const key of ['workspacePath', 'codexPath', 'threadId']) assert.equal(settings[key], settingsFixture[key], `${key} survives install/update`);
  const world = await page.evaluate(async () => { const s = await window.tus.loadSettings(); return window.tus.request({ ...s, path: '/state' }); });
  assert.equal(world.objects.length, 1);
  assert.equal(world.objects[0].type, 'bridge');
  assert.equal(world.objects[0].position.x, 7);
  assert.equal(await page.locator('#send').isDisabled(), true, 'installer must not invoke the model');
  const saved = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal('token' in saved, false, 'session tokens must not be persisted');
}
try {
  // A genuinely clean first install must launch before any profile directory exists.
  await run(installer, ['/S', `/D=${installDir}`], { timeout: 180000 });
  let page = await launch(path.join(installDir, 'TheUnfinishedShapes.exe'));
  const cleanSettings = await page.evaluate(() => window.tus.loadSettings());
  assert.equal(cleanSettings.workspacePath || '', '');
  assert.equal(cleanSettings.codexPath || '', '');
  assert.equal(cleanSettings.threadId || '', '');
  const cleanWorld = await page.evaluate(async () => { const s = await window.tus.loadSettings(); return window.tus.request({ ...s, path: '/state' }); });
  assert.equal(cleanWorld.objects.length, 0);
  await close(); await uninstall();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await rm(installDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

  // The first public portable release provides a real earlier-version migration fixture.
  const archive = path.join(work, 'rc1.zip');
  const response = await fetch('https://github.com/smart-tinker/the_unfinished_shapes/releases/download/v0.1.0-rc1/TheUnfinishedShapes-0.1-rc1-win32-x64.zip');
  if (!response.ok || !response.body) throw new Error(`RC1 download failed: ${response.status}`);
  await pipeline(response.body, createWriteStream(archive));
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), '5ae62bdb9b61ae2a6c4317ec55c9a0aa66cb6621866c41293bdae7d3e633d110', 'released RC1 checksum');
  const extracted = path.join(work, 'portable-rc1');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}'`], { timeout: 120000 });
  page = await launch(path.join(extracted, 'TheUnfinishedShapes-win32-x64', 'TheUnfinishedShapes.exe'));
  await page.evaluate(async fixture => {
    await window.tus.saveSettings(fixture);
    const s = await window.tus.loadSettings();
    await window.tus.request({ ...s, path: '/command', method: 'POST', body: { type: 'build', objectType: 'bridge', position: { x: 7, y: 1, z: 0 } } });
  }, settingsFixture);
  await close();
  // Install the next version elsewhere: it must use the same data rather than copying secrets.
  await run(installer, ['/S', `/D=${installDir}`], { timeout: 180000 });
  const installedExe = path.join(installDir, 'TheUnfinishedShapes.exe');
  page = await launch(installedExe); await verifyRestored(page); await close();
  // Silent reinstall exercises the NSIS update path and must not reset the profile.
  await run(installer, ['/S', `/D=${installDir}`], { timeout: 180000 });
  page = await launch(installedExe); await verifyRestored(page); await close();
  const beforeUninstall = await readFile(path.join(dataDir, 'settings.json'), 'utf8');
  await uninstall();
  assert.equal(await readFile(path.join(dataDir, 'settings.json'), 'utf8'), beforeUninstall, 'uninstall retains settings');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'world.json'), 'utf8')).objects.length, 1, 'uninstall retains world');
  console.log('Windows installer smoke passed: clean first install; RC1 portable → installed RC2, same settings/world/thread ID, packaged WebGL startup, reinstall and uninstall retain data; no credentials saved or model invoked.');
} finally {
  await close();
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  // All paths below were proved absent before the test and are owned by this disposable fixture.
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await rm(installDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
