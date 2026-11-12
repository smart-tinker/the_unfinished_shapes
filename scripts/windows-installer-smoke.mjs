import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { observeGraphics, closeSmokeApp, withSmokeCleanup } from './graphics-smoke.mjs';
import { waitForUninstall } from './windows-uninstall.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { createGpuDiagnostics } from './gpu-smoke.mjs';

import { manualEditing } from './ui-acceptance.mjs';
import { fullscreenAcceptance } from './fullscreen-acceptance.mjs';
import { quitPromptAcceptance } from './quit-prompt-acceptance.mjs';

// This test intentionally touches the real per-user app directory only on a disposable runner.
if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.RUNNER_OS !== 'Windows') {
  throw new Error('Run installer smoke only on a disposable Windows GitHub Actions runner.');
}
const run = promisify(execFile);
const packageVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const expectedSourceSha=/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||'')?process.env.GITHUB_SHA:null;
const expectedBuildLabel=`v${packageVersion} · ${expectedSourceSha?expectedSourceSha.slice(0,7):'build unknown'}`;
const expectedBuildTitle=expectedSourceSha?`Version ${packageVersion}; source SHA ${expectedSourceSha}`:`Version ${packageVersion}; source SHA unavailable. This build is not release-identified.`;
const work = await mkdtemp(path.join(os.tmpdir(), 'tus-installer-'));
const dataDir = path.join(process.env.APPDATA, 'the-unfinished-shapes');
try { await access(dataDir); throw new Error('Refusing to modify a pre-existing app data directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let installer = process.env.TUS_SMOKE_INSTALLER;
if (!installer) {
  const installerFiles = (await readdir('dist/installer')).filter(name => name.endsWith('.exe'));
  assert.equal(installerFiles.length, 1, 'exactly one installer must be built');
  installer = path.join('dist/installer', installerFiles[0]);
}
installer = path.resolve(installer);
await access(installer);
const portableExecutable = process.env.TUS_SMOKE_PORTABLE_EXECUTABLE && path.resolve(process.env.TUS_SMOKE_PORTABLE_EXECUTABLE);
if (portableExecutable) await access(portableExecutable);
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'TUS-Installer-Smoke');
try { await access(installDir); throw new Error('Refusing to replace an existing installation.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const settingsFixture = {
  workspacePath: path.join(work, 'player-workspace'), codexPath: path.join(work, 'codex.exe'),
  serverUrl: '', threadId: 'saved-game-thread-fixture', agentControlThreadId: 'saved-game-thread-fixture', agentModelId: 'qwen3-local-cpu', agentEffort: 'medium', token: 'test-value-that-must-not-be-saved'
};
await mkdir(settingsFixture.workspacePath, { recursive: true });
let instance, graphics, gpu;
async function launch(executablePath, label, { realQuitPrompt = false } = {}) {
  gpu = await createGpuDiagnostics(label);
  // Use an explicit software renderer on the GPU-less runner, as in Linux CI.
  instance = await electron.launch({ executablePath, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', ...(realQuitPrompt ? [] : ['--tus-smoke-confirm-quit']), ...gpu.args], env: { ...process.env, TUS_DATA_DIR: '' }, timeout: 45000 });
  await gpu.attach(instance);
  const page = await instance.firstWindow();
  graphics = await observeGraphics(page, { label });
  await page.waitForFunction(() => document.querySelector('#build-version')?.getAttribute('title') !== 'Loading build metadata');
  assert.equal(await page.locator('#build-version').innerText(), expectedBuildLabel, 'installed UI version and short source SHA match the candidate');
  assert.equal(await page.locator('#build-version').getAttribute('title'), expectedBuildTitle, 'installed build identifies exact source or marks it unknown');
  graphics.phase('world connection');
  const actualDataDir = await instance.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(path.resolve(actualDataDir).toLowerCase(), path.resolve(dataDir).toLowerCase(), 'stable default user-data path');
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'), null, { timeout: 30000 });
  await graphics.assertHealthy();
  return page;
}
async function close(phase) {
  const closing = instance, observed = graphics, diagnostic = gpu;
  instance = null; graphics = null; gpu = null;
  await withSmokeCleanup(() => closeSmokeApp(closing, observed, phase), () => diagnostic?.finish());
}
async function uninstall() {
  const uninstaller = (await readdir(installDir)).find(name => /^Uninstall.*\.exe$/i.test(name));
  assert.ok(uninstaller, 'uninstaller exists');
  await run(path.join(installDir, uninstaller), ['/S'], { timeout: 180000 });
  await waitForUninstall(() => access(path.join(installDir, 'TheUnfinishedShapes.exe')));
}
async function verifyRestored(page) {
  graphics.phase('verify retained settings and world');
  const settings = await page.evaluate(() => window.tus.loadSettings());
  for (const key of ['workspacePath', 'codexPath', 'threadId', 'agentControlThreadId', 'agentModelId', 'agentEffort']) assert.equal(settings[key], settingsFixture[key], `${key} survives install/update`);
  const world = await page.evaluate(async () => { const s = await window.tus.loadSettings(); return window.tus.request({ ...s, path: '/state' }); });
  assert.equal(world.objects.length, 1);
  assert.equal(world.objects[0].type, 'bridge');
  assert.equal(world.objects[0].position.x, 7);
  assert.equal(await page.locator('#send').isDisabled(), true, 'installer must not invoke the model');
  const saved = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(saved.agentControlThreadId, settingsFixture.agentControlThreadId, 'model preferences stay bound to the saved conversation');
  assert.equal(saved.agentModelId, settingsFixture.agentModelId, 'agent model preference survives restart');
  assert.equal(saved.agentEffort, settingsFixture.agentEffort, 'agent reasoning preference survives restart');
  assert.equal('token' in saved, false, 'session tokens must not be persisted');
}
await withSmokeCleanup(async () => {
  // A genuinely clean first install must launch before any profile directory exists.
  await run(installer, ['/S', `/D=${installDir}`], { timeout: 180000 });
  let page = await launch(path.join(installDir, 'TheUnfinishedShapes.exe'), 'clean install');
  graphics.phase('clean settings and world');
  const cleanSettings = await page.evaluate(() => window.tus.loadSettings());
  assert.equal(cleanSettings.workspacePath || '', '');
  assert.equal(cleanSettings.codexPath || '', '');
  assert.equal(cleanSettings.threadId || '', '');
  const cleanWorld = await page.evaluate(async () => { const s = await window.tus.loadSettings(); return window.tus.request({ ...s, path: '/state' }); });
  assert.equal(cleanWorld.objects.length, 0);
  graphics.phase('native fullscreen controls, keyboard priority and world isolation');
  await fullscreenAcceptance(instance, page);
  graphics.phase('manual UI create, select, edit and remove');
  await manualEditing(page);
  graphics.phase('create current-candidate fixture');
  // Build the persistence fixture through this candidate, with no earlier release or player data.
  await page.evaluate(async fixture => {
    await window.tus.saveSettings(fixture);
    const s = await window.tus.loadSettings();
    await window.tus.request({ ...s, path: '/command', method: 'POST', body: { type: 'build', objectType: 'bridge', position: { x: 7, y: 1, z: 0 } } });
  }, settingsFixture);
  await close();
  const installedExe = path.join(installDir, 'TheUnfinishedShapes.exe');
  page = await launch(installedExe, 'native quit prompt acceptance', { realQuitPrompt: true });
  graphics.phase('native window close and File -> Exit confirmation');
  await graphics.assertHealthy();
  const promptApp = instance, promptProcess = instance.process(), promptGraphics = graphics, promptGpu = gpu;
  try {
    await quitPromptAcceptance(promptApp, page, promptGraphics);
  } finally {
    if (promptProcess.exitCode !== null) {
      if (instance === promptApp) { instance = null; graphics = null; gpu = null; }
      await promptGpu.finish();
    }
  }
  // Restart the installed candidate before testing the same-installer reinstall.
  page = await launch(installedExe, 'installed restart'); await verifyRestored(page); await close();
  if (portableExecutable) {
    page = await launch(portableExecutable, 'portable archive'); await verifyRestored(page); await close();
  }
  // Silent reinstall exercises the NSIS update path and must not reset the profile.
  await run(installer, ['/S', `/D=${installDir}`], { timeout: 180000 });
  page = await launch(installedExe, 'same-installer reinstall'); await verifyRestored(page); await close();
  const beforeUninstall = await readFile(path.join(dataDir, 'settings.json'), 'utf8');
  await uninstall();
  assert.equal(await readFile(path.join(dataDir, 'settings.json'), 'utf8'), beforeUninstall, 'uninstall retains settings');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'world.json'), 'utf8')).objects.length, 1, 'uninstall retains world');
  await run(installer, ['/S', `/D=${installDir}`], { timeout: 180000 });
  page = await launch(installedExe, 'reinstall after uninstall'); await verifyRestored(page); await close();
  await uninstall();
}, () => close('final cleanup'),
  // These paths were proved absent before the test and belong to this disposable fixture.
  () => rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  () => rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  () => rm(installDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
);
console.log(`Windows portable archive smoke: ${portableExecutable ? 'passed with exact supplied executable' : 'not requested; portable archive was not tested'}.`);
console.log('Windows installer smoke passed: current candidate clean install, synthetic settings/world/thread ID persistence after restart, same-installer reinstall, uninstall data retention and reinstall after uninstall; graphics checked throughout each lifecycle; no credentials saved or model invoked.');
