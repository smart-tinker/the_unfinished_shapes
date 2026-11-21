import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { compareReleaseVersions } from '../src/update-release.mjs';
import { safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType, verifyReleaseAttestation } from '../src/update-package.mjs';
import { closeSmokeApp, observeGraphics, withSmokeCleanup } from './graphics-smoke.mjs';
import { createGpuDiagnostics } from './gpu-smoke.mjs';
import { safeMainDiagnostics } from './updater-smoke-diagnostics.mjs';
import { runWindowsUpdaterScenarios, safeInstallerHandoffEvents, safeNsisWizardEvents, windowsInstallerHandoffInstallDir } from './windows-updater-scenarios.mjs';

const updateProgressPattern = /^Downloading release package: (\d+(?:\.\d+)?) \/ (\d+(?:\.\d+)?) MB\./;
const updateHttpStatusPattern = /\bHTTP (\d{3})\b/;
assert.deepEqual(
  'Downloading release package: 1.5 / 42.0 MB.'.match(updateProgressPattern)?.slice(1),
  ['1.5', '42.0'],
  'the timeout diagnostic parses bounded download progress',
);
assert.equal(
  'GitHub release provenance check failed (HTTP 403).'.match(updateHttpStatusPattern)?.[1],
  '403',
  'the timeout diagnostic keeps only the HTTP status code',
);

const execute = promisify(execFile);
const executable = path.resolve(process.env.TUS_SMOKE_EXECUTABLE || '');
assert.ok(process.env.CI === 'true' && process.env.RUNNER_OS, 'updater package acceptance runs only on a GitHub Actions runner');
assert.ok(process.env.TUS_SMOKE_EXECUTABLE, 'a packaged candidate executable is required');
await access(executable);

const baselineVersion = '0.1.0-rc.1';
const projectPackagePath = new URL('../package.json', import.meta.url);
const projectPackageOriginal = await readFile(projectPackagePath, 'utf8');

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'tus-update-e2e-'));
const workDirs = [];
let active = null;
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const runnerFlags = process.platform === 'linux' || process.platform === 'win32'
  ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : [];

function waitForExit(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error('The packaged updater process did not exit after confirmed launch.')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function withTimeout(promise, label, timeoutMs = 30000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms.')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}


async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(filePath); return true; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

async function start(executablePath, label, dataDir, useBaseline = false, extraEnv = {}) {
  const gpu = await createGpuDiagnostics(label);
  let instance;
  let graphics;
  try {
    const env = { ...process.env, ...extraEnv, TUS_DATA_DIR: dataDir };
    console.log('Updater smoke ' + label + ': launching packaged app.');
    instance = await electron.launch({
      executablePath,
      args: [...runnerFlags, '--tus-smoke-confirm-quit', '--tus-smoke-provenance-diagnostic', ...gpu.args],
      env,
      timeout: 45000,
    });
    console.log('Updater smoke ' + label + ': packaged app launched.');
    await gpu.attach(instance);
    console.log('Updater smoke ' + label + ': GPU diagnostics attached.');
    if (useBaseline) {
      const version = await withTimeout(instance.evaluate(({ app }) => app.getVersion()), 'Updater smoke baseline version query', 15000);
      assert.equal(version, baselineVersion, 'isolated updater test version is active');
      console.log('Updater smoke ' + label + ': baseline version confirmed.');
    }
    const page = await withTimeout(instance.firstWindow(), 'Updater smoke first window', 30000);
    console.log('Updater smoke ' + label + ': first window opened.');
    graphics = await observeGraphics(page, { label });
    active = { instance, page, graphics, gpu };
    graphics.phase('world connection');
    await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'), null, { timeout: 45000 });
    await graphics.assertHealthy();
    return active;
  } catch (error) {
    console.error('Updater smoke ' + label + ' startup failed: ' + error.message);
    await withSmokeCleanup(
      async () => { throw error; },
      async () => {
        if (!instance) return;
        const child = instance.process();
        await Promise.race([
          instance.close().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      },
      () => gpu.finish(),
    );
  }
}

async function closeActive(label) {
  if (!active) return;
  const current = active;
  active = null;
  await withSmokeCleanup(
    () => current.instance.process().exitCode === null
      ? closeSmokeApp(current.instance, current.graphics, label)
      : current.graphics?.assertNoErrors(),
    () => current.gpu.finish(),
  );
}

async function closeAfterQuit(current, wait) {
  await wait;
  await current.graphics.assertNoErrors();
  await current.gpu.finish();
  if (active === current) active = null;
}

async function addWorldFixture(page) {
  await page.locator('[data-kind="bridge"]').click();
  await page.locator('#build-x').fill('7');
  await page.locator('#build-preview').click();
  await page.locator('#build-apply').click();
  await page.waitForFunction(() => document.querySelector('#world-message')?.textContent.includes('Shape added to the shared world.'));
}

async function worldObjects(page) {
  return page.evaluate(async () => {
    const settings = await window.tus.loadSettings();
    return (await window.tus.request({ ...settings, path: '/state' })).objects;
  });
}

async function assertInstalledSourceIdentity(current, profile) {
  if (!profile) return;
  const identity = await current.instance.evaluate(({ app }) => ({
    executable: process.execPath,
    userData: app.getPath('userData'),
  }));
  assert.equal(path.resolve(identity.executable).toLowerCase() === path.resolve(profile.installedExe).toLowerCase(), true, 'the updater process is the installed source executable');
  assert.equal(path.resolve(identity.userData).toLowerCase() === path.resolve(profile.userData).toLowerCase(), true, 'the updater process uses the source profile user-data directory');
}

function windowsScenarioFailureCategory(error) {
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'ERR_SCRIPT_EXECUTION_TIMEOUT'].includes(error?.code)) return 'timeout';
  const childOutput = String(error?.stdout || '') + String(error?.stderr || '');
  if (error?.code === 'ERR_ASSERTION' || childOutput.includes('AssertionError [ERR_ASSERTION]')) return 'assertion';
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO'].includes(error?.code)) return 'filesystem';
  if (['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed'].includes(error?.code)) return error.code;
  const failureCode = safeUpdaterFailureCode(error?.failureCode);
  if (['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed'].includes(failureCode)) return failureCode;
  if (failureCode === 'SIGNATURE_REJECTED') return 'provenance';
  if (Number.isInteger(error?.code)) return 'process-exit';
  return 'other';
}

async function fileDigest(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function updaterRuntimeBoundary(current, manifestFile, assetName, tag) {
  const [main, rendererInvoke] = await Promise.all([
    withTimeout(current.instance.evaluate(() => globalThis.__tusUpdaterSmokeBoundary || null), 'Updater main boundary snapshot', 5000).catch(() => null),
    withTimeout(current.page.evaluate(() => document.querySelector('#updates-status')?.dataset.updateInvokeStatus || 'not-started'), 'Updater renderer invoke snapshot', 5000).catch(() => null),
  ]);
  return safeMainDiagnostics([
    { stage: 'updater-module-import', status: main?.moduleImport, moduleFailureCode: main?.moduleFailureCode, moduleFailureName: main?.moduleFailureName },
    { stage: 'download-verified-asset', status: main?.downloadVerifiedAsset },
    { stage: 'renderer-invoke', status: rendererInvoke },
  ], manifestFile, assetName, tag);
}


async function extractFileFlags(extractDir, version) {
  const empty = { targetExists: false, appAsarExists: false, appAsarFile: false, executableExists: false, stagedAsarExists: false };
  let target;
  try {
    target = path.join(await realpath(extractDir), 'TheUnfinishedShapes-' + version + (process.platform === 'darwin' ? '.app' : ''));
  } catch {
    return empty;
  }
  const resources = path.join(target, ...(process.platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']));
  const appAsar = path.join(resources, 'app.asar');
  const executable = path.join(target, ...(process.platform === 'darwin'
    ? ['Contents', 'MacOS', 'TheUnfinishedShapes']
    : [process.platform === 'win32' ? 'TheUnfinishedShapes.exe' : 'TheUnfinishedShapes']));
  const statOrNull = file => lstat(file).catch(() => null);
  const [targetStat, appAsarStat, executableStat, resourceEntries] = await Promise.all([
    statOrNull(target),
    statOrNull(appAsar),
    statOrNull(executable),
    readdir(resources).catch(() => []),
  ]);
  return {
    targetExists: Boolean(targetStat),
    appAsarExists: Boolean(appAsarStat),
    appAsarFile: appAsarStat?.isFile() === true,
    executableExists: Boolean(executableStat),
    stagedAsarExists: resourceEntries.some(name => name.startsWith('.tus-app-asar-') && name.endsWith('.tmp')),
  };
}

async function extractRuntimeBoundary(current, extractDir, targetVersion, manifestFile, assetName, tag, previousStreamSnapshot = null) {
  assert.equal(typeof targetVersion, 'string', 'published manifest version is required for extraction file snapshot');
  const emptyFileFlags = { targetExists: false, appAsarExists: false, appAsarFile: false, executableExists: false, stagedAsarExists: false };
  const [main, renderer, fileFlags] = await Promise.all([
    withTimeout(current.instance.evaluate(() => {
      const boundary = globalThis.__tusUpdaterSmokeBoundary;
      return boundary ? {
        status: boundary.extractArchive || 'not-started',
        extractModuleImport: boundary.extractModuleImport,
        extractCall: boundary.extractCall,
        extractPhase: boundary.extractPhase,
        extractSubstage: boundary.extractSubstage,
        extractAppAsarEntry: boundary.extractAppAsarEntry,
        extractStreamSnapshot: typeof boundary.extractStreamSnapshot === 'function' ? boundary.extractStreamSnapshot() : null,
      } : null;
    }), 'Updater extraction main snapshot', 5000).catch(() => null),
    withTimeout(current.page.evaluate(() => {
      const status = document.querySelector('#updates-status');
      return {
        statusText: status?.textContent ?? '',
        failureCode: status?.dataset.updateExtractFailureCode || null,
        extractStage: status?.dataset.updateExtractStage || null,
        extractOperation: status?.dataset.updateExtractOperation || null,
        invokeStatus: status?.dataset.updateExtractInvokeStatus || 'not-started',
        visibilityState: document.visibilityState,
      };
    }), 'Updater extraction renderer snapshot', 5000).catch(() => null),
    withTimeout(extractFileFlags(extractDir, targetVersion), 'Updater extraction file snapshot', 5000).catch(() => emptyFileFlags),
  ]);
  const [safe] = safeMainDiagnostics([{
    stage: 'extract-archive',
    status: main?.status ?? 'unknown',
    extractModuleImport: main?.extractModuleImport,
    extractCall: main?.extractCall,
    extractPhase: main?.extractPhase,
    extractSubstage: main?.extractSubstage,
    extractAppAsarEntry: main?.extractAppAsarEntry,
    extractStreamSnapshot: main?.extractStreamSnapshot,
    ...(previousStreamSnapshot ? {
      previousStreamSnapshot: previousStreamSnapshot.snapshot,
      streamIntervalMs: Math.round(performance.now() - previousStreamSnapshot.sampledAtMs),
    } : {}),
    rendererStatusText: renderer?.statusText,
    rendererInvokeStatus: renderer?.invokeStatus,
    failureCode: renderer?.failureCode,
    extractStage: renderer?.extractStage,
    extractOperation: renderer?.extractOperation,
    visibilityState: renderer?.visibilityState,
    fileFlags,
  }], manifestFile, assetName, tag);
  return {
    mainStatus: safe.status,
    extractModuleImport: safe.extractModuleImport,
    extractCall: safe.extractCall,
    extractPhase: safe.extractPhase,
    extractSubstage: safe.extractSubstage,
    extractAppAsarEntry: safe.extractAppAsarEntry,
    streamSnapshot: safe.streamSnapshot,
    rendererStatus: safe.rendererStatus,
    rendererInvokeStatus: safe.rendererInvokeStatus,
    failureCode: safe.failureCode,
    extractStage: safe.extractStage,
    extractOperation: safe.extractOperation,
    visibilityState: safe.visibilityState,
    fileFlags: safe.fileFlags,
  };
}

function sigstoreTrustedRootTargetPath() {
  const home = os.homedir();
  const appData = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'sigstore-js')
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'sigstore-js', 'Data')
      : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'sigstore-js');
  return path.join(appData, encodeURIComponent('tuf-repo-cdn.sigstore.dev'), 'targets', 'trusted_root.json');
}

async function sigstoreTrustedRootInfo(rootPath) {
  try { return { available: true, sha256: await fileDigest(rootPath) }; }
  catch { return { available: false, sha256: null }; }
}

async function comparePinnedAttestation(electronMain, manifestFile, assetName, tag) {
  assert.ok(Array.isArray(electronMain) && electronMain.some(item => item.stage === 'verify-start'), 'the packaged updater reports its live Sigstore attempt');
  const url = 'https://api.github.com/repos/smart-tinker/the_unfinished_shapes/attestations/sha256:' + manifestFile.sha256;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch {
    console.log('TUS_PROVENANCE_CONTROL ' + JSON.stringify({ status: 'bundle-fetch-failed', httpStatus: null, electronMain }));
    return;
  }
  if (!response.ok) {
    const httpStatus = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : null;
    console.log('TUS_PROVENANCE_CONTROL ' + JSON.stringify({ status: 'bundle-fetch-failed', httpStatus, electronMain }));
    return;
  }

  let body;
  try {
    const text = await response.text();
    if (text.length > 2000000) throw new Error('bounded-response');
    body = JSON.parse(text);
  } catch {
    console.log('TUS_PROVENANCE_CONTROL ' + JSON.stringify({ status: 'bundle-response-invalid', httpStatus: null, electronMain }));
    return;
  }
  const candidates = Array.isArray(body.attestations) ? body.attestations.flatMap((item, bundleIndex) => {
    if (!item?.bundle) return [];
    const bundleText = JSON.stringify(item.bundle);
    return bundleText.length <= 2000000 ? [{
      bundle: item.bundle, bundleIndex,
      bundleSha256: createHash('sha256').update(bundleText).digest('hex'),
    }] : [];
  }) : [];
  const mainHashes = new Set(electronMain
    .filter(item => item.stage === 'verify-start' && item.assetMatches)
    .map(item => item.bundleSha256).filter(Boolean));
  const selected = candidates.find(item => mainHashes.has(item.bundleSha256));
  const bundle = selected?.bundle;
  const bundleSha256 = selected?.bundleSha256 || null;
  const asset = { name: assetName, size: manifestFile.size, digest: 'sha256:' + manifestFile.sha256 };
  const rootPath = sigstoreTrustedRootTargetPath();
  const trustedRootBefore = await sigstoreTrustedRootInfo(rootPath);
  let node = { status: 'no-exact-main-bundle-match' };
  if (bundle) {
    try {
      await verifyReleaseAttestation({ bundle, asset, tag });
      node = { status: 'verified' };
    } catch (error) {
      node = {
        status: 'rejected',
        failureCode: safeUpdaterFailureCode(error?.failureCode),
        verifierCode: safeVerifierCode(error?.code, error?.verifierErrorType),
        verifierErrorType: safeVerifierErrorType(error?.verifierErrorType),
      };
    }
  }
  node.trustedRootTarget = { before: trustedRootBefore, after: await sigstoreTrustedRootInfo(rootPath) };
  const safeMain = {
    attempts: electronMain,
    firstFailure: electronMain.find(item => item.stage === 'verify-result' && item.status === 'rejected') || null,
    lastResult: [...electronMain].reverse().find(item => item.stage === 'verify-result') || null,
  };
  console.log('TUS_PROVENANCE_CONTROL ' + JSON.stringify({
    assetSha256: manifestFile.sha256,
    bundleSha256,
    controlBundleIndex: selected?.bundleIndex ?? null,
    matchedMainBundle: !!bundle,
    node,
    electronMain: safeMain,
  }));
  assert.ok(bundle, 'the Node control verifies the exact bundle attempted by the packaged updater');
  const setupEvents = electronMain.filter(item => item.stage === 'verifier-setup');
  const verifyEvents = electronMain.filter(item => item.stage === 'verifier-verify');
  assert.equal(setupEvents.filter(item => item.status === 'starting').length, 1, 'the live verifier reports one setup attempt');
  const setupResult = setupEvents.filter(item => item.status === 'ready' || item.status === 'rejected');
  assert.equal(setupResult.length, 1, 'the live verifier reports the setup outcome');
  if (setupResult[0].status === 'ready') {
    assert.equal(verifyEvents.filter(item => item.status === 'starting').length, 1, 'bundle verification starts only after setup succeeds');
    assert.equal(verifyEvents.filter(item => item.status === 'verified' || item.status === 'rejected').length, 1, 'the live verifier reports the bundle outcome');
  } else {
    assert.equal(verifyEvents.length, 0, 'bundle verification does not start when setup fails');
  }
}
async function getManifest(tag) {
  const filename = 'candidate-' + platform + '.json';
  const url = 'https://github.com/smart-tinker/the_unfinished_shapes/releases/download/' +
    encodeURIComponent(tag) + '/' + encodeURIComponent(filename);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'the published release manifest is available');
  assert.ok(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(new URL(response.url).hostname), 'the manifest redirect remains on GitHub release hosts');
  const body = await response.text();
  assert.ok(body.length <= 16384, 'the public release manifest is bounded');
  const manifest = JSON.parse(body);
  assert.equal(manifest.repository, 'smart-tinker/the_unfinished_shapes');
  assert.equal(manifest.tag, tag);
  assert.equal(manifest.platform, platform);
  assert.match(manifest.sourceSha || '', /^[a-f0-9]{40}$/);
  return manifest;
}

function expectedAssetName(version, distribution) {
  const suffix = process.platform === 'win32'
    ? (distribution === 'installer' ? 'Setup-x64.exe' : 'win32-x64.zip')
    : process.platform === 'darwin' ? 'darwin-arm64.zip' : 'linux-x64.tar.gz';
  return 'TheUnfinishedShapes-' + version + '-' + suffix;
}

async function configureUpdateDialogs(instance, { downloadsDir, extractDir, dialogMarker, extractMarker, relaunchMarker, executeRelaunch = false }) {
  await instance.evaluate(({ app, dialog }, config) => {
    const { writeFileSync } = process.getBuiltinModule('node:fs');
    const productionRelaunch = app.relaunch;
    app.setPath('downloads', config.downloadsDir);
    globalThis.__tusUpdateChoice = 0;
    dialog.showOpenDialog = async () => {
      writeFileSync(config.extractMarker, JSON.stringify({ invoked: true, selected: true }));
      return { canceled: false, filePaths: [config.extractDir] };
    };
    dialog.showMessageBox = async (_window, options) => {
      writeFileSync(config.dialogMarker, JSON.stringify({ title: options.title, buttons: options.buttons }));
      return { response: globalThis.__tusUpdateChoice };
    };
    app.relaunch = options => {
      writeFileSync(config.relaunchMarker, JSON.stringify(options));
      if (config.executeRelaunch) productionRelaunch.call(app, options);
    };
  }, { downloadsDir, extractDir, dialogMarker, extractMarker, relaunchMarker, executeRelaunch });
}

async function runWindowsInstallerMode(mode, profile, { installerPath, expectedVersion, sourceSha }) {
  const original = await readFile(projectPackagePath, 'utf8');
  if (expectedVersion) {
    const packageJson = JSON.parse(original);
    packageJson.version = expectedVersion;
    await writeFile(projectPackagePath, JSON.stringify(packageJson, null, 2) + '\n');
  }
  try {
    let result;
    try {
      result = await execute(process.execPath, ['scripts/windows-installer-smoke.mjs'], {
        cwd: process.cwd(),
        timeout: 600000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          APPDATA: profile.appData,
          LOCALAPPDATA: profile.localData,
          GITHUB_SHA: sourceSha ?? process.env.GITHUB_SHA,
          TUS_DATA_DIR: profile.userData,
          TUS_SMOKE_INSTALLER: installerPath,
          TUS_SMOKE_INSTALL_DIR: profile.installDir,
          TUS_SMOKE_PORTABLE_EXECUTABLE: '',
          TUS_SMOKE_HANDOFF_MODE: mode,
          TUS_SMOKE_HANDOFF_ROOT: profile.root,
        },
      });
    } catch (error) {
      const events = safeInstallerHandoffEvents([error.stdout, error.stderr].filter(Boolean).join('\n'));
      for (const event of events) console.log(event);
      const failedCheck = events.find(line => line.startsWith('TUS_INSTALLER_HANDOFF check=') && /:(mismatch|failed)$/.test(line));
      const check = failedCheck?.match(/^TUS_INSTALLER_HANDOFF check=([a-z-]+):(?:mismatch|failed)$/)?.[1];
      const lastStage = events.filter(line => line.startsWith('TUS_INSTALLER_HANDOFF stage=')).at(-1)?.split(' stage=')[1];
      const stage = check ? (mode === 'verify-target' ? 'target-verify' : 'source-identity')
        : mode === 'verify-target' ? 'target-verify'
          : lastStage === 'source-setup-started' ? 'source-setup'
            : lastStage === 'source-setup-complete' ? 'source-identity'
              : lastStage === 'source-identity-verified' || lastStage === 'source-fixture-verified' ? 'source-prepare' : 'source-setup';
      const failure = new Error('Windows installer smoke failed.');
      failure.tusScenarioDiagnostic = { stage, category: check || windowsScenarioFailureCategory(error) };
      throw failure;
    }
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
  } finally {
    if (expectedVersion) await writeFile(projectPackagePath, original);
  }
}

async function prepareWindowsInstallerSource() {
  const root = await mkdtemp(path.join(testRoot, 'installer-handoff-'));
  const profile = {
    root,
    appData: path.join(root, 'Roaming'),
    localData: path.join(root, 'Local'),
  };
  await Promise.all([mkdir(profile.appData), mkdir(profile.localData)]);
  const installerFiles = (await readdir('dist/installer')).filter(name => name.endsWith('.exe'));
  assert.equal(installerFiles.length, 1, 'exactly one current-CI Setup must be built');
  profile.sourceInstaller = path.resolve('dist/installer', installerFiles[0]);
  profile.installDir = windowsInstallerHandoffInstallDir(profile.localData);
  profile.installedExe = path.join(profile.installDir, 'TheUnfinishedShapes.exe');
  profile.userData = path.join(profile.appData, 'the-unfinished-shapes');
  await runWindowsInstallerMode('prepare-source', profile, {
    installerPath: profile.sourceInstaller,
    sourceSha: process.env.GITHUB_SHA,
  });
  return profile;
}

function logNsisWizardEvents(output) {
  for (const line of safeNsisWizardEvents(output)) console.log(line);
}

async function runWindowsNsisWizard(installerPath, expectedInstallDir) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows-nsis-wizard.ps1',
    '-InstallerPath', path.resolve(installerPath),
    '-ExpectedInstallDir', path.resolve(expectedInstallDir),
  ];
  let output = '';
  try {
    const result = await execute('powershell.exe', args, { timeout: 210000, maxBuffer: 1024 * 1024 });
    output = result.stdout;
    logNsisWizardEvents(output);
  } catch (error) {
    output = error.stdout || '';
    const events = safeNsisWizardEvents(output);
    logNsisWizardEvents(output);
    const pid = events.find(line => line.startsWith('TUS_NSIS_WIZARD event=process-found'))?.split('pid=')[1];
    if (pid) await execute('taskkill.exe', ['/PID', pid, '/T', '/F'], { timeout: 5000 }).catch(() => {});
    const category = events.some(line => line.includes('event=timeout')) || windowsScenarioFailureCategory(error) === 'timeout'
      ? 'timeout' : events.some(line => line.includes('event=uia-unavailable') || line.includes('event=automation-failed'))
        ? 'uia' : 'process-exit';
    const failure = new Error('The exact published installer wizard did not complete.');
    failure.tusScenarioDiagnostic = { stage: 'wizard', category };
    throw failure;
  }
  if (!safeNsisWizardEvents(output).some(line => line.startsWith('TUS_NSIS_WIZARD event=completed'))) {
    const failure = new Error('The exact published installer wizard did not complete.');
    failure.tusScenarioDiagnostic = { stage: 'wizard', category: 'other' };
    throw failure;
  }
}

async function runIndependentWindowsScenario(distribution) {
  let diagnostic = {
    stage: distribution === 'installer' ? 'source-setup' : 'source-identity',
    category: null,
  };
  const setDiagnostic = (stage, category = null) => { diagnostic = { stage, category }; };
  try {
    return await updateOnce(distribution, setDiagnostic);
  } catch (error) {
    await closeActive('failed Windows ' + distribution + ' updater scenario').catch(() => {});
    const detail = error?.tusScenarioDiagnostic;
    const failure = new Error('Windows updater scenario failed.');
    failure.tusScenarioDiagnostic = {
      stage: detail?.stage || diagnostic.stage,
      category: detail?.category || diagnostic.category || windowsScenarioFailureCategory(error),
    };
    throw failure;
  }
}

async function updateOnce(distribution, setDiagnostic = () => {}) {
  const workDir = await mkdtemp(path.join(testRoot, 'package-'));
  workDirs.push(workDir);
  let handoffProfile = null;
  if (process.platform === 'win32' && distribution === 'installer') {
    setDiagnostic('source-setup');
    handoffProfile = await prepareWindowsInstallerSource();
  }
  const dataDir = handoffProfile ? handoffProfile.userData : path.join(workDir, 'data');
  const downloadsDir = path.join(workDir, 'downloads');
  const extractDir = path.join(workDir, 'extracted');
  await Promise.all([
    ...(handoffProfile ? [] : [mkdir(dataDir)]),
    mkdir(downloadsDir), mkdir(extractDir),
  ]);

  const sourceExecutable = handoffProfile?.installedExe || executable;
  const sourceEnv = handoffProfile ? { APPDATA: handoffProfile.appData, LOCALAPPDATA: handoffProfile.localData } : {};
  setDiagnostic('source-identity');
  let current = await start(sourceExecutable, 'updater source ' + distribution, dataDir, true, sourceEnv);
  await assertInstalledSourceIdentity(current, handoffProfile);
  if (handoffProfile) {
    const userData = await current.instance.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(path.resolve(userData).toLowerCase(), path.resolve(handoffProfile.userData).toLowerCase(), 'installed source uses the ordinary isolated profile');
    const settings = await current.page.evaluate(() => window.tus.loadSettings());
    assert.equal(settings.threadId, 'saved-game-thread-fixture');
    const objects = await worldObjects(current.page);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].type, 'bridge');
    assert.equal(objects[0].position.x, 7);
  } else {
    await addWorldFixture(current.page);
  }
  await current.page.locator('#settings-open').click();
  await current.page.locator('#update-channel').selectOption('prerelease');
  if (process.platform === 'win32') await current.page.locator('#update-distribution').selectOption(distribution);
  await current.page.locator('#updates-save').click();
  await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent === 'Update preference saved.');
  const firstProcess = current.instance.process();
  const firstExit = waitForExit(firstProcess);
  await current.instance.evaluate(({ app }) => app.quit());
  await closeAfterQuit(current, firstExit);

  setDiagnostic('source-identity');
  current = await start(sourceExecutable, 'updater preference restart ' + distribution, dataDir, true, sourceEnv);
  await assertInstalledSourceIdentity(current, handoffProfile);
  setDiagnostic('check-download');
  await current.page.locator('#settings-open').click();
  assert.equal(await current.page.locator('#update-channel').inputValue(), 'prerelease', 'the selected update channel survives restart');
  if (process.platform === 'win32') await current.page.locator('#update-distribution').selectOption(distribution);
  await current.page.waitForFunction(() => !document.querySelector('#updates-notice')?.hidden, null, { timeout: 30000 });
  const startupNotice = await current.page.locator('#updates-notice').getAttribute('title');
  const startupErrorCode = await current.page.locator('#updates-notice').getAttribute('data-error-code');
  if (startupErrorCode) {
    const allowedStartupErrorCodes = new Set(['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed']);
    const errorCode = allowedStartupErrorCodes.has(startupErrorCode) ? startupErrorCode : 'check_failed';
    setDiagnostic('check-download', errorCode);
    console.log('Updater startup release diagnostic ' + JSON.stringify({ status: 'error', errorCode }));
  }
  assert.match(startupNotice || '', /available\./, 'startup checks expose a published update without installing it');
  const startupTag = startupNotice?.match(/Prerelease (v\d+\.\d+\.\d+-rc\.?\d+) is available\./)?.[1];
  assert.ok(startupTag, 'startup check identifies the published prerelease');
  assert.ok(compareReleaseVersions(startupTag, baselineVersion) > 0, 'startup check identifies a newer prerelease');

  await current.page.locator('#updates-check').click();
  await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent.includes(' is available.'), null, { timeout: 30000 });
  const availability = await current.page.locator('#updates-status').innerText();
  assert.match(availability, /^Prerelease · may be unstable: /, 'manual check uses the saved prerelease channel');
  const tag = availability.match(/(v\d+\.\d+\.\d+-rc\.?\d+)/)?.[1];
  assert.ok(tag, 'the published candidate tag is shown in the update status');
  assert.ok(compareReleaseVersions(tag, baselineVersion) > 0, 'the published prerelease is newer than the isolated test version');
  assert.equal(tag, startupTag, 'startup and manual checks identify the same latest prerelease');

  const manifest = await getManifest(tag);
  const assetName = expectedAssetName(manifest.version, distribution);
  const manifestFile = manifest.files.find(file => file.name === assetName);
  assert.ok(manifestFile, 'the exact platform and distribution package appears in the published manifest');

  await configureUpdateDialogs(current.instance, {
    downloadsDir, extractDir,
    dialogMarker: path.join(workDir, 'update-dialog.json'),
    extractMarker: path.join(workDir, 'extract-folder-chooser.json'),
    relaunchMarker: path.join(workDir, 'relaunch.json'),
    executeRelaunch: Boolean(handoffProfile),
  });
  await current.page.evaluate(() => {
    window.__tusProvenanceDiagnostics = [];
    window.tus.onUpdateProgress(progress => {
      if (progress?.provenanceDiagnostic && window.__tusProvenanceDiagnostics.length < 40) {
        window.__tusProvenanceDiagnostics.push(progress.provenanceDiagnostic);
      }
    });
  });
  setDiagnostic('check-download');
  await current.page.locator('#updates-download').click({ noWaitAfter: true });
  try {
    await current.page.waitForFunction(() => {
      const status = document.querySelector('#updates-status');
      return status?.textContent.startsWith('Verified ') || status?.dataset.updateFailure === 'true';
    }, null, { timeout: 180000 });
  } catch (error) {
    const diagnostic = await current.page.evaluate(({ progressPattern, httpStatusPattern }) => {
      const status = document.querySelector('#updates-status');
      const text = status?.textContent?.slice(0, 300) || '';
      const progress = text.match(new RegExp(progressPattern));
      const mb = value => { const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 500 ? number : null; };
      const httpStatus = Number(text.match(new RegExp(httpStatusPattern))?.[1]) || null;
      const state = progress ? 'downloading' : status?.dataset.updateFailure === 'true' ? 'failed'
        : text === 'Downloading release package…' ? 'starting' : text.startsWith('Verified ') ? 'verified' : 'other';
      return {
        state,
        receivedMB: progress ? mb(progress[1]) : null,
        totalMB: progress ? mb(progress[2]) : null,
        httpStatus: Number(status?.dataset.updateHttpStatus) || httpStatus,
        phase: status?.dataset.updatePhase || null,
        failureCode: status?.dataset.updateFailureCode || null,
        verifierCode: status?.dataset.verifierCode || null,
        verifierErrorType: status?.dataset.verifierErrorType || null,
        cancelEnabled: !document.querySelector('#updates-cancel')?.disabled,
      };
    }, { progressPattern: updateProgressPattern.source, httpStatusPattern: updateHttpStatusPattern.source }).catch(() => ({ state: 'unavailable', receivedMB: null, totalMB: null, httpStatus: null, phase: null, verifierCode: null, verifierErrorType: null, cancelEnabled: null }));
    const safeDiagnostic = {
      ...diagnostic,
      phase: ['download', 'provenance'].includes(diagnostic.phase) ? diagnostic.phase : 'unknown',
      failureCode: safeUpdaterFailureCode(diagnostic.failureCode),
      verifierCode: safeVerifierCode(diagnostic.verifierCode),
      verifierErrorType: safeVerifierErrorType(diagnostic.verifierErrorType),
      httpStatus: Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 400 && diagnostic.httpStatus <= 599 ? diagnostic.httpStatus : null,
    };
    const mainDiagnostics = safeMainDiagnostics(
      await current.page.evaluate(() => window.__tusProvenanceDiagnostics || []).catch(() => []),
      manifestFile, assetName, tag,
    );
    const runtimeBoundary = await updaterRuntimeBoundary(current, manifestFile, assetName, tag);
    console.log('TUS_UPDATER_RUNTIME_BOUNDARY ' + JSON.stringify(runtimeBoundary));
    assert.ok([diagnostic.receivedMB, diagnostic.totalMB].every(value => value === null || value >= 0 && value <= 500), 'timeout progress diagnostic stays bounded');
    throw new Error(error.message + '; update=' + JSON.stringify(safeDiagnostic) + '; main=' + JSON.stringify(mainDiagnostics) + '; runtime=' + JSON.stringify(runtimeBoundary));
  }
  const terminalFailure = await current.page.evaluate(() => {
    const status = document.querySelector('#updates-status');
    return status?.dataset.updateFailure === 'true'
      ? {
          phase: status.dataset.updatePhase,
          failureCode: status.dataset.updateFailureCode,
          verifierCode: status.dataset.verifierCode,
          verifierErrorType: status.dataset.verifierErrorType,
          httpStatus: Number(status.dataset.updateHttpStatus) || null,
        }
      : null;
  });
  if (terminalFailure) {
    const liveMainDiagnostics = await current.page.evaluate(() => window.__tusProvenanceDiagnostics || []).catch(() => []);
    const mainDiagnostics = safeMainDiagnostics(liveMainDiagnostics, manifestFile, assetName, tag);
    console.log('TUS_UPDATER_MAIN_DIAGNOSTIC ' + JSON.stringify(mainDiagnostics));
    const runtimeBoundary = await updaterRuntimeBoundary(current, manifestFile, assetName, tag);
    console.log('TUS_UPDATER_RUNTIME_BOUNDARY ' + JSON.stringify(runtimeBoundary));
    const diagnostic = {
      phase: ['download', 'provenance'].includes(terminalFailure.phase) ? terminalFailure.phase : 'unknown',
      failureCode: safeUpdaterFailureCode(terminalFailure.failureCode),
      verifierCode: safeVerifierCode(terminalFailure.verifierCode),
      verifierErrorType: safeVerifierErrorType(terminalFailure.verifierErrorType),
      httpStatus: Number.isInteger(terminalFailure.httpStatus) && terminalFailure.httpStatus >= 400 && terminalFailure.httpStatus <= 599 ? terminalFailure.httpStatus : null,
    };
    if (diagnostic.phase === 'provenance' && diagnostic.failureCode === 'SIGNATURE_REJECTED' &&
        diagnostic.verifierCode === 'OTHER' && diagnostic.verifierErrorType === 'OTHER') {
      await comparePinnedAttestation(mainDiagnostics, manifestFile, assetName, tag);
    }
    throw new Error('Updater failed before verification; update=' + JSON.stringify(diagnostic) + '; runtime=' + JSON.stringify(runtimeBoundary));
  }
  const successfulMainDiagnostics = safeMainDiagnostics(
    await current.page.evaluate(() => window.__tusProvenanceDiagnostics || []).catch(() => []),
    manifestFile, assetName, tag,
  );
  console.log('TUS_UPDATER_MAIN_DIAGNOSTIC ' + JSON.stringify(successfulMainDiagnostics));
  const runtimeBoundary = await updaterRuntimeBoundary(current, manifestFile, assetName, tag);
  console.log('TUS_UPDATER_RUNTIME_BOUNDARY ' + JSON.stringify(runtimeBoundary));
  assert.equal(runtimeBoundary.find(item => item.stage === 'updater-module-import')?.status, 'fulfilled', 'the packaged main process completed the normal relative updater import');
  assert.equal(runtimeBoundary.find(item => item.stage === 'download-verified-asset')?.status, 'fulfilled', 'the packaged main process completed the selected asset download');
  assert.equal(runtimeBoundary.find(item => item.stage === 'renderer-invoke')?.status, 'fulfilled', 'the renderer received a fulfilled updater IPC invoke');
  const liveAttempt = successfulMainDiagnostics.find(item => item.stage === 'verify-start' && item.assetMatches && item.bundleSha256);
  assert.ok(liveAttempt, 'packaged Electron verified the exact live release bundle');
  assert.ok(successfulMainDiagnostics.some(item =>
    item.stage === 'verifier-setup' && item.status === 'ready' && item.assetMatches &&
    item.bundleSha256 === liveAttempt.bundleSha256), 'packaged Electron prepared the trust policy for that bundle');
  assert.ok(successfulMainDiagnostics.some(item =>
    item.stage === 'verifier-verify' && item.status === 'verified' && item.assetMatches &&
    item.bundleSha256 === liveAttempt.bundleSha256), 'packaged Electron accepted the valid published bundle');
  assert.ok(successfulMainDiagnostics.some(item =>
    item.stage === 'verifier-tampered-control' && item.status === 'tampered-rejected' && item.assetMatches &&
    item.bundleSha256 === liveAttempt.bundleSha256), 'the same Electron verifier rejected the tampered copy');

  const verified = await current.page.locator('#updates-status').innerText();
  assert.ok(verified.startsWith('Verified ' + assetName + ' (SHA-256 '), 'the UI reports the exact selected package only after digest and provenance verification');
  const updateDir = path.join(downloadsDir, 'TheUnfinishedShapes-Updates');
  const downloadName = (await readdir(updateDir)).find(name => name.endsWith('-' + assetName));
  assert.ok(downloadName, 'the verified package is saved in the isolated Downloads directory');
  const downloadedPath = path.join(updateDir, downloadName);
  assert.equal(await fileDigest(downloadedPath), manifestFile.sha256, 'downloaded bytes match the published release manifest');

  if (distribution !== 'installer') {
    setDiagnostic('extract');
    const pendingStatus = 'Choose a destination folder…';
    const successStatus = 'Verified archive extracted. You can now launch the new copy.';
    await current.page.locator('#updates-extract').click();
    const folderChooserInvoked = await waitForFile(path.join(workDir, 'extract-folder-chooser.json'), 5000);
    const extractDiagnostic = {
      folderChooserInvoked,
      outcome: folderChooserInvoked ? 'pending' : 'chooser-not-invoked',
      reason: folderChooserInvoked ? 'no-terminal-renderer-status' : 'folder-chooser-not-invoked',
    };
    if (folderChooserInvoked) {
      let timedOut = false;
      let observationFailed = false;
      let streamSampling = true;
      let streamSampleTimer;
      let streamSamples = 0;
      let previousStreamSnapshot = null;
      const scheduleStreamSample = delay => {
        streamSampleTimer = setTimeout(() => { void captureStreamSample().catch(() => {}); }, delay);
      };
      const captureStreamSample = async () => {
        streamSampleTimer = null;
        if (!streamSampling || streamSamples >= 5) return;
        const stream = await withTimeout(current.instance.evaluate(() => {
          const snapshot = globalThis.__tusUpdaterSmokeBoundary?.extractStreamSnapshot;
          return typeof snapshot === 'function' ? snapshot() : null;
        }), 'Updater ZIP stream sample', 5000).catch(() => null);
        if (!streamSampling) return;
        const sampledAtMs = performance.now();
        const [safe] = safeMainDiagnostics([{
          stage: 'extract-archive',
          status: 'starting',
          ...(previousStreamSnapshot ? {
            previousStreamSnapshot: previousStreamSnapshot.snapshot,
            streamIntervalMs: Math.round(sampledAtMs - previousStreamSnapshot.sampledAtMs),
          } : {}),
          extractStreamSnapshot: stream,
        }], manifestFile, assetName, tag);
        const snapshot = safe?.streamSnapshot ?? null;
        console.log('TUS_UPDATE_EXTRACT_STREAM ' + JSON.stringify(snapshot));
        previousStreamSnapshot = { snapshot, sampledAtMs };
        streamSamples++;
        if (streamSamples < 5) scheduleStreamSample(20000);
      };
      scheduleStreamSample(15000);
      try {
        await current.page.waitForFunction(({ pending, prior, success }) => {
          const status = document.querySelector('#updates-status');
          const text = status?.textContent || '';
          const invoke = status?.dataset.updateExtractInvokeStatus || 'not-started';
          if (text === success) return invoke === 'fulfilled' || invoke === 'rejected';
          return Boolean(text && text !== pending && text !== prior);
        }, { pending: pendingStatus, prior: verified, success: successStatus }, { timeout: 120000 });
      } catch (error) {
        if (error?.name === 'TimeoutError') timedOut = true;
        else observationFailed = true;
      } finally {
        streamSampling = false;
        clearTimeout(streamSampleTimer);
      }
      const runtime = await extractRuntimeBoundary(current, extractDir, manifest.version, manifestFile, assetName, tag, previousStreamSnapshot);
      extractDiagnostic.runtime = runtime;
      if (timedOut) {
        extractDiagnostic.outcome = 'pending';
        extractDiagnostic.reason = 'renderer-observation-timeout';
      } else if (observationFailed) {
        extractDiagnostic.outcome = 'unobserved';
        extractDiagnostic.reason = 'status-observation-failed';
      } else if (runtime.rendererStatus === 'verified' && runtime.mainStatus === 'fulfilled' && runtime.rendererInvokeStatus === 'fulfilled') {
        extractDiagnostic.outcome = 'verified';
        extractDiagnostic.reason = 'none';
      } else if (runtime.rendererStatus === 'cancelled' && runtime.rendererInvokeStatus === 'fulfilled') {
        extractDiagnostic.outcome = 'cancelled';
        extractDiagnostic.reason = 'folder-selection-cancelled';
      } else {
        extractDiagnostic.outcome = 'rejected';
        extractDiagnostic.reason = 'renderer-reported-error';
      }
    }
    console.log('TUS_UPDATE_EXTRACT_DIAGNOSTIC ' + JSON.stringify(extractDiagnostic));
    assert.equal(extractDiagnostic.outcome, 'verified', 'the selected verified archive reaches a terminal extraction success');
  }

  setDiagnostic('relaunch');
  await current.page.locator('#updates-launch').click();
  await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent === 'Update launch cancelled.');
  assert.equal(current.instance.process().exitCode, null, 'cancel leaves the game open and the verified update available');
  await current.instance.evaluate(() => { globalThis.__tusUpdateChoice = 1; });

  const closing = current;
  const exit = waitForExit(closing.instance.process());
  const click = closing.page.locator('#updates-launch').click({ timeout: 10000 }).catch(error => {
    if (closing.instance.process().exitCode === null) throw error;
  });
  await Promise.all([click, closeAfterQuit(closing, exit)]);

  const prompt = JSON.parse(await readFile(path.join(workDir, 'update-dialog.json'), 'utf8'));
  assert.equal(prompt.title, 'Start verified update');
  assert.deepEqual(prompt.buttons, ['Cancel', 'Quit and launch']);
  const relaunch = JSON.parse(await readFile(path.join(workDir, 'relaunch.json'), 'utf8'));
  assert.deepEqual(relaunch.args, [], 'the update launches without carrying commands or conversation text');
  const targetVersion = manifest.version;
  const expectedExecutable = distribution === 'installer' ? downloadedPath : path.join(
    await realpath(extractDir),
    'TheUnfinishedShapes-' + targetVersion + (process.platform === 'darwin' ? '.app' : ''),
    ...(process.platform === 'darwin' ? ['Contents', 'MacOS', 'TheUnfinishedShapes'] : [process.platform === 'win32' ? 'TheUnfinishedShapes.exe' : 'TheUnfinishedShapes']),
  );
  assert.equal(path.resolve(relaunch.execPath), path.resolve(expectedExecutable), 'only the verified installer or extracted executable is passed to relaunch');
  await access(relaunch.execPath);

  let targetExecutable = null;
  if (distribution === 'installer') {
    assert.ok(handoffProfile, 'the NSIS handoff starts from the installed source profile');
    setDiagnostic('wizard');
    await runWindowsNsisWizard(relaunch.execPath, handoffProfile.installDir);
    setDiagnostic('target-verify');
    await runWindowsInstallerMode('verify-target', handoffProfile, {
      installerPath: downloadedPath,
      expectedVersion: manifest.version,
      sourceSha: manifest.sourceSha,
    });
    targetExecutable = handoffProfile.installedExe;
  } else {
    setDiagnostic('target-verify');
    current = await start(relaunch.execPath, 'published update launch ' + distribution, dataDir);
    targetExecutable = relaunch.execPath;
    assert.equal(await current.instance.evaluate(({ app }) => app.getVersion()), targetVersion, 'the exact downloaded release package starts');
    const objects = await worldObjects(current.page);
    assert.equal(objects.length, 1, 'world data survives package update');
    assert.equal(objects[0].type, 'bridge');
    assert.equal(objects[0].position.x, 7);
    assert.equal(await current.page.locator('#send').isDisabled(), true, 'the updater does not connect Codex or send a model turn');
    await closeActive('updated package close');
  }

  console.log('Updater E2E passed: ' + platform + ' ' + distribution + ' -> ' + tag + ' (' + assetName + '), exact published digest and provenance, explicit cancel/launch, isolated world persistence.');
  return { workDir, downloadedPath, assetName, tag, manifest, targetExecutable };
}

try {
  if (process.platform === 'win32') {
    const outcomes = await runWindowsUpdaterScenarios({
      portable: () => runIndependentWindowsScenario('portable'),
      installer: () => runIndependentWindowsScenario('installer'),
    });
    for (const [scenario, outcome] of Object.entries(outcomes)) {
      console.log('TUS_WINDOWS_UPDATER_RESULT ' + JSON.stringify({
        scenario,
        status: outcome.status === 'fulfilled' ? 'passed' : 'failed',
        stage: outcome.diagnostic.stage,
        category: outcome.diagnostic.category,
      }));
      if (outcome.status === 'rejected') console.error('Windows updater scenario failed: ' + scenario);
    }
    const failure = outcomes.portable.status === 'rejected' ? outcomes.portable.error
      : outcomes.installer.status === 'rejected' ? outcomes.installer.error : null;
    if (failure) throw new Error('A required Windows updater scenario failed.');
    console.log('Windows updater acceptance passed for independent portable and installed-source NSIS outcomes from the same published release.');
  } else {
    await updateOnce('archive');
  }
} finally {
  await closeActive('updater test cleanup').catch(() => {});
  for (const workDir of workDirs) await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await rm(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
