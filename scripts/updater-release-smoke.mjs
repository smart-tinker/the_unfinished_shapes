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
import { closeSmokeApp, observeGraphics, waitForExit, withSmokeCleanup } from './graphics-smoke.mjs';
import { createGpuDiagnostics } from './gpu-smoke.mjs';
import { cleanupUpdaterTemporaryData, withTimeout } from './updater-cleanup.mjs';
import { assertPortableExtractVerified, safeMainDiagnostics, updaterZipStreamSampleOffsetsMs } from './updater-smoke-diagnostics.mjs';
import { runWindowsRelaunch, runWindowsUpdaterScenarios, safeInstallerHandoffEvents, safeNsisWizardEvents, safeWindowsScenarioFailureCategory, windowsInstallerHandoffInstallDir, windowsRelaunchRequestStatus } from './windows-updater-scenarios.mjs';

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
let active = null;
let pendingWindowsInstallerCleanup = null;
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const runnerFlags = process.platform === 'linux' || process.platform === 'win32'
  ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : [];




function updaterMarker(kind, stage, outcome) {
  try { console.log('TUS_UPDATER_' + kind + ' stage=' + stage + ' outcome=' + outcome); } catch {}
}

async function finishGpuLog(gpu) {
  updaterMarker('CLEANUP', 'gpu-log', 'started');
  try {
    await withTimeout(gpu.finish(), 'Updater GPU log cleanup', 10000);
    updaterMarker('CLEANUP', 'gpu-log', 'completed');
  } catch (error) {
    updaterMarker('CLEANUP', 'gpu-log', error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed');
    throw error;
  }
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
        await withTimeout(
          Promise.resolve().then(() => instance.close()).catch(() => {}),
          'Updater smoke startup app close',
          5000,
        ).catch(() => {});
        if (child.exitCode === null) child.kill('SIGKILL');
      },
      () => finishGpuLog(gpu),
    );
  }
}

async function closeActive(label) {
  if (!active) {
    updaterMarker('CLEANUP', 'active-app', 'not-needed');
    return;
  }
  const current = active;
  active = null;
  updaterMarker('CLEANUP', 'active-app', 'started');
  try {
    await withSmokeCleanup(
      () => current.instance.process().exitCode === null
        ? closeSmokeApp(current.instance, current.graphics, label)
        : current.graphics?.assertNoErrors(),
      () => finishGpuLog(current.gpu),
    );
    updaterMarker('CLEANUP', 'active-app', 'completed');
  } catch (error) {
    updaterMarker('CLEANUP', 'active-app', 'failed');
    throw error;
  }
}

async function closeAfterQuit(current, wait) {
  await wait;
  await current.graphics.assertNoErrors();
  await finishGpuLog(current.gpu);
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

async function fixtureFingerprint(current) {
  const settings = await current.page.evaluate(async () => {
    const value = await window.tus.loadSettings();
    return { threadId: value.threadId, updateChannel: value.updateChannel };
  });
  const objects = (await worldObjects(current.page)).map(object => ({
    type: object.type,
    position: [object.position?.x, object.position?.y, object.position?.z],
  }));
  return createHash('sha256').update(JSON.stringify({ settings, objects })).digest('hex');
}

async function focusByKeyboard(page, selector) {
  // shortcut: 64 tab stops, increase if Settings gains more focusable controls.
  const target = page.locator(selector);
  for (let index = 0; index < 64; index++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail('Keyboard tab order did not reach ' + selector);
}

async function observeUpdaterKeyboardActions(page) {
  await page.evaluate(() => {
    window.__tusUpdaterSmokeDiagnostic = true;
    window.__tusUpdaterKeyboardActions = [];
    window.__tusUpdateDialogWaiting = false;
    window.__tusUpdateDialogKey = null;
    document.addEventListener('keydown', event => {
      if (window.__tusUpdateDialogWaiting && ['Escape', 'Enter'].includes(event.key)) {
        window.__tusUpdateDialogWaiting = false;
        window.__tusUpdateDialogKey = event.key;
        event.preventDefault();
        return;
      }
      const id = event.target instanceof HTMLElement ? event.target.id : '';
      if (event.key === 'Enter' && ['updates-check', 'updates-download', 'updates-extract', 'updates-cancel', 'updates-launch'].includes(id) &&
          window.__tusUpdaterKeyboardActions.length < 40) {
        window.__tusUpdaterKeyboardActions.push(id);
      }
    }, true);
  });
}

async function lastUpdaterKeyboardAction(page) {
  return page.evaluate(() => window.__tusUpdaterKeyboardActions?.at(-1) ?? null);
}

async function activateUpdaterButtonByKeyboard(page, id) {
  await focusByKeyboard(page, '#' + id);
  await page.keyboard.press('Enter');
  assert.equal(await lastUpdaterKeyboardAction(page), id, id + ' is activated by keyboard');
}

async function respondToUpdateLaunch(current, dialogMarker, key, manifestFile, assetName, tag, distribution) {
  const diagnostic = {
    button: 'not-started',
    prompt: 'not-started',
    keyboardChoice: 'not-started',
    dialogResponse: 'not-started',
  };
  try {
    await rm(dialogMarker, { force: true });
    await activateUpdaterButtonByKeyboard(current.page, 'updates-launch');
    diagnostic.button = 'keyboard-activated';
    const promptTimeoutMs = distribution === 'installer' ? 30_000 : 5000;
    diagnostic.prompt = await waitForFile(dialogMarker, promptTimeoutMs) ? 'invoked' : 'missing';
    const runtime = await updaterRuntimeBoundary(current, manifestFile, assetName, tag, 1000).catch(() => []);
    diagnostic.launchBoundary = runtime.find(item => item.stage === 'update-launch') ?? null;
    assert.equal(diagnostic.prompt, 'invoked', 'the launch approval prompt was invoked');
    if (distribution === 'installer') {
      assert.ok(diagnostic.launchBoundary, 'the installed-source launch boundary is observable');
      assert.equal(diagnostic.launchBoundary?.status, 'starting', 'launch remains pending for explicit approval');
      assert.equal(diagnostic.launchBoundary?.launchPhase, 'dialog', 'the production approval dialog was reached');
      assert.equal(diagnostic.launchBoundary?.launchSubstage, 'verified', 'the installer rehash completed successfully');
      assert.equal(diagnostic.launchBoundary?.launchReadPhase, 'verified', 'the complete installer file was read and verified');
      assert.equal(diagnostic.launchBoundary?.launchReadBytes, manifestFile.size, 'the full published installer size was rehashed');
      assert.equal(diagnostic.launchBoundary?.launchDialog, 'marker-written', 'the production dialog call reached the smoke observer');
      assert.equal(diagnostic.launchBoundary?.launchDecision, 'not-started', 'approval has not been supplied yet');
    }
    await current.page.evaluate(() => {
      window.__tusUpdateDialogKey = null;
      window.__tusUpdateDialogWaiting = true;
    });
    await current.page.keyboard.press(key);
    const selectedKey = await current.page.evaluate(() => {
      const value = window.__tusUpdateDialogKey;
      window.__tusUpdateDialogKey = null;
      return value;
    });
    diagnostic.keyboardChoice = selectedKey === key ? 'matched' : 'missing';
    assert.equal(selectedKey, key, 'the launch prompt choice comes from keyboard input');
    const resolved = await current.instance.evaluate((_electron, response) => {
      const resolve = globalThis.__tusUpdateDialogResolve;
      if (typeof resolve !== 'function') return false;
      delete globalThis.__tusUpdateDialogResolve;
      resolve({ response });
      return true;
    }, key === 'Enter' ? 1 : 0);
    diagnostic.dialogResponse = resolved ? 'resolved' : 'missing';
    assert.equal(resolved, true, 'the keyboard choice resolves the packaged dialog request');
  } finally {
    console.log('TUS_UPDATE_LAUNCH_KEYBOARD ' + JSON.stringify(diagnostic));
  }
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

async function fileDigest(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function logUpdaterReleaseFetchObservation(current, checkpoint) {
  const live = await withTimeout(
    current.instance.evaluate(() => globalThis.__tusUpdaterSmokeBoundary?.releaseFetches ?? null),
    'Updater release fetch snapshot',
    5000,
  ).catch(() => null);
  const available = Array.isArray(live);
  const requests = safeMainDiagnostics(
    available ? live : [],
    { sha256: '' },
    '',
    '',
  ).map(({ phase, page, count, status, remainingZero, safeFailure }) => ({
    phase, page, count, status, remainingZero, safeFailure,
  }));
  console.log('TUS_UPDATER_RELEASE_FETCH ' + JSON.stringify({
    checkpoint, available, count: requests.length, requests,
  }));
  return { available, requests };
}

async function updaterRuntimeBoundary(current, manifestFile, assetName, tag, snapshotTimeoutMs = 5000) {
  const [main, rendererInvoke, rendererLaunch] = await Promise.all([
    withTimeout(current.instance.evaluate(() => globalThis.__tusUpdaterSmokeBoundary || null), 'Updater main boundary snapshot', snapshotTimeoutMs).catch(() => null),
    withTimeout(current.page.evaluate(() => document.querySelector('#updates-status')?.dataset.updateInvokeStatus || 'not-started'), 'Updater renderer invoke snapshot', snapshotTimeoutMs).catch(() => null),
    withTimeout(current.page.evaluate(() => {
      const status = document.querySelector('#updates-status');
      return {
        clickStatus: status?.dataset.updateLaunchClickStatus || 'not-started',
        invokeStatus: status?.dataset.updateLaunchInvokeStatus || 'not-started',
      };
    }), 'Updater launch invoke snapshot', snapshotTimeoutMs).catch(() => null),
  ]);
  return safeMainDiagnostics([
    { stage: 'updater-module-import', status: main?.moduleImport, moduleFailureCode: main?.moduleFailureCode, moduleFailureName: main?.moduleFailureName },
    { stage: 'download-verified-asset', status: main?.downloadVerifiedAsset },
    { stage: 'renderer-invoke', status: rendererInvoke },
    {
      stage: 'update-launch',
      status: main?.launchStatus,
      launchPhase: main?.launchPhase,
      launchSubstage: main?.launchSubstage,
      launchReadPhase: main?.launchReadPhase,
      launchReadBytes: main?.launchReadBytes,
      launchDialog: main?.launchDialog,
      launchDecision: main?.launchDecision,
      rendererClickStatus: rendererLaunch?.clickStatus,
      rendererInvokeStatus: rendererLaunch?.invokeStatus,
    },
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
async function getManifest(tag, targetPlatform = platform) {
  const filename = 'candidate-' + targetPlatform + '.json';
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
  assert.equal(manifest.platform, targetPlatform);
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
    dialog.showOpenDialog = async () => {
      writeFileSync(config.extractMarker, JSON.stringify({ invoked: true, selected: true }));
      return { canceled: false, filePaths: [config.extractDir] };
    };
    dialog.showMessageBox = async (_window, options) => new Promise((resolve, reject) => {
      const boundary = globalThis.__tusUpdaterSmokeBoundary;
      if (boundary) boundary.launchDialog = 'invoked';
      globalThis.__tusUpdateDialogResolve = resolve;
      try {
        writeFileSync(config.dialogMarker, JSON.stringify({ title: options.title, buttons: options.buttons }));
        if (boundary) boundary.launchDialog = 'marker-written';
      } catch (error) {
        if (boundary) boundary.launchDialog = 'marker-write-failed';
        delete globalThis.__tusUpdateDialogResolve;
        reject(error);
      }
    });
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
      failure.tusScenarioDiagnostic = { stage, category: check || safeWindowsScenarioFailureCategory(error) };
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
    const category = events.some(line => line.includes('event=timeout')) || safeWindowsScenarioFailureCategory(error) === 'timeout'
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

async function cleanupWindowsNsisInstaller(installerPath, expectedInstallDir) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows-nsis-wizard.ps1',
    '-InstallerPath', path.resolve(installerPath),
    '-ExpectedInstallDir', path.resolve(expectedInstallDir),
    '-CleanupOnly',
  ];
  let output = '';
  try {
    output = (await execute('powershell.exe', args, { timeout: 15000, maxBuffer: 65536, windowsHide: true })).stdout || '';
  } catch (error) {
    logNsisWizardEvents(error.stdout || '');
    throw new Error('The exact verified installer cleanup did not complete.');
  }
  const events = safeNsisWizardEvents(output);
  logNsisWizardEvents(output);
  if (events.length === 1 && (
    events[0] === 'TUS_NSIS_WIZARD event=cleanup-not-found' ||
    events[0].startsWith('TUS_NSIS_WIZARD event=cleanup-stopped pid=')
  )) return;
  throw new Error('The exact verified installer cleanup did not complete.');
}

async function cleanupPendingWindowsInstaller() {
  if (!pendingWindowsInstallerCleanup) return true;
  try {
    await cleanupWindowsNsisInstaller(
      pendingWindowsInstallerCleanup.installerPath,
      pendingWindowsInstallerCleanup.installDir,
    );
    pendingWindowsInstallerCleanup = null;
    return true;
  } catch {
    console.log('TUS_NSIS_WIZARD event=cleanup-failed');
    return false;
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
      category: detail?.category || diagnostic.category || safeWindowsScenarioFailureCategory(error),
    };
    throw failure;
  }
}

async function assertDigestMismatchRejected(current, {
  tag, assetName, expectedSize, expectedSha256, downloadsDir, extractDir, relaunchMarker, handoffProfile,
}) {
  const assetUrl = 'https://github.com/smart-tinker/the_unfinished_shapes/releases/download/' +
    encodeURIComponent(tag) + '/' + encodeURIComponent(assetName);
  const attestationUrl = 'https://api.github.com/repos/smart-tinker/the_unfinished_shapes/attestations/sha256:' + expectedSha256;
  const beforeFixture = await fixtureFingerprint(current);
  const beforeVersion = await current.instance.evaluate(({ app }) => app.getVersion());
  const controlInstalled = await current.instance.evaluate((_electron, { assetUrl, attestationUrl, tag, assetName, expectedSha256, expectedSize }) => {
    const boundary = globalThis.__tusUpdaterSmokeBoundary;
    if (!boundary || typeof globalThis.fetch !== 'function') return false;
    const originalFetch = globalThis.fetch;
    const assetUrls = new Set([assetUrl]);
    const control = {
      expectedTag: tag, expectedAssetName: assetName, expectedSha256, expectedSize,
      selectedAssetMatches: null, selectedTagMatches: null, selectedNameMatches: null,
      selectedDigestMatches: null, selectedSizeMatches: null, fetcherCalls: 0,
      assetRequests: 0, bodyResponses: 0, bytesFlipped: 0, bytesRead: 0,
      responseComplete: false, attestationRequests: 0,
    };
    boundary.digestMismatchControl = control;
    boundary.digestMismatchFetch = originalFetch;
    boundary.digestMismatchFetcher = async (input, init) => {
      control.fetcherCalls++;
      const requestUrl = typeof input === 'string' ? input : input?.url;
      const isAssetRequest = control.selectedAssetMatches === true && assetUrls.has(requestUrl);
      if (typeof requestUrl === 'string' &&
          requestUrl.startsWith('https://api.github.com/repos/smart-tinker/the_unfinished_shapes/attestations/sha256:')) {
        control.attestationRequests++;
      }
      const response = await Reflect.apply(originalFetch, globalThis, [input, init]);
      if (!isAssetRequest) return response;
      control.assetRequests++;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (location) {
          try { assetUrls.add(new URL(location, requestUrl).href); } catch {}
        }
        return response;
      }
      if (!response.ok || !response.body || control.bodyResponses > 0) return response;
      control.bodyResponses++;
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          control.bytesRead += bytes.byteLength;
          if (control.bytesFlipped === 0 && bytes.byteLength > 0) {
            const changed = bytes.slice();
            changed[0] ^= 1;
            control.bytesFlipped++;
            controller.enqueue(changed);
          } else controller.enqueue(bytes);
        },
        flush() { control.responseComplete = true; },
      }));
      return new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    };
    return typeof boundary.digestMismatchFetcher === 'function';
  }, { assetUrl, attestationUrl, tag, assetName, expectedSha256, expectedSize });
  assert.equal(controlInstalled, true, 'the packaged main-process asset control is installed');

  let fetchRestored = false;
  try {
    await activateUpdaterButtonByKeyboard(current.page, 'updates-download');
    await current.page.waitForFunction(() => {
      const status = document.querySelector('#updates-status');
      return (status?.dataset.updateFailure === 'true' && status.dataset.updateInvokeStatus === 'rejected') ||
        status?.textContent.startsWith('Verified ');
    }, null, { timeout: 180000 });

    const [renderer, main, control, diagnostics] = await Promise.all([
      current.page.evaluate(() => {
        const status = document.querySelector('#updates-status');
        return {
          state: status?.dataset.updateFailure === 'true' ? 'failed'
            : status?.textContent?.startsWith('Verified ') ? 'verified' : 'other',
          phase: ['download', 'provenance'].includes(status?.dataset.updatePhase) ? status.dataset.updatePhase : 'unknown',
          failureCode: status?.dataset.updateFailureCode || 'OTHER',
          invokeStatus: status?.dataset.updateInvokeStatus || 'not-started',
        };
      }),
      current.instance.evaluate(() => {
        const boundary = globalThis.__tusUpdaterSmokeBoundary;
        return boundary ? {
          moduleImport: boundary.moduleImport,
          download: boundary.downloadVerifiedAsset,
          extractArchive: boundary.extractArchive,
          extractCall: boundary.extractCall,
          extractPhase: boundary.extractPhase,
        } : null;
      }),
      current.instance.evaluate(() => {
        const value = globalThis.__tusUpdaterSmokeBoundary?.digestMismatchControl;
        return value ? {
          assetMatched: value.assetRequests > 0 && value.bodyResponses === 1,
          assetSelectionMatches: value.selectedAssetMatches === true,
          selectedTagMatches: value.selectedTagMatches === true,
          selectedNameMatches: value.selectedNameMatches === true,
          selectedDigestMatches: value.selectedDigestMatches === true,
          selectedSizeMatches: value.selectedSizeMatches === true,
          fetcherCalled: value.fetcherCalls > 0,
          bytesFlipped: value.bytesFlipped,
          bytesRead: value.bytesRead,
          responseComplete: value.responseComplete,
          attestationRequests: value.attestationRequests,
        } : null;
      }),
      current.page.evaluate(() => window.__tusProvenanceDiagnostics || []),
    ]);
    const downloadEntries = await readdir(path.join(downloadsDir, 'TheUnfinishedShapes-Updates')).catch(error => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const extractionEntries = await readdir(extractDir);
    const relaunchRequested = await lstat(relaunchMarker).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    const afterVersion = await current.instance.evaluate(({ app }) => app.getVersion());
    const afterFixture = await fixtureFingerprint(current);
    let sourceIdentityUnchanged = null;
    if (handoffProfile) {
      const identity = await current.instance.evaluate(({ app }) => ({
        executable: process.execPath,
        userData: app.getPath('userData'),
      }));
      sourceIdentityUnchanged =
        path.resolve(identity.executable).toLowerCase() === path.resolve(handoffProfile.installedExe).toLowerCase() &&
        path.resolve(identity.userData).toLowerCase() === path.resolve(handoffProfile.userData).toLowerCase();
    }
    const actual = {
      assetMatched: control?.assetMatched === true,
      assetSelectionMatches: control?.assetSelectionMatches === true,
      selectedTagMatches: control?.selectedTagMatches === true,
      selectedNameMatches: control?.selectedNameMatches === true,
      selectedDigestMatches: control?.selectedDigestMatches === true,
      selectedSizeMatches: control?.selectedSizeMatches === true,
      fetcherCalled: control?.fetcherCalled === true,
      bytesFlipped: control?.bytesFlipped ?? 0,
      bytesRead: control?.bytesRead ?? 0,
      responseComplete: control?.responseComplete === true,
      attestationRequests: control?.attestationRequests ?? 0,
      rendererState: renderer?.state ?? 'unknown',
      rendererPhase: renderer?.phase ?? 'unknown',
      failureCode: safeUpdaterFailureCode(renderer?.failureCode),
      rendererInvoke: renderer?.invokeStatus ?? 'unknown',
      moduleImport: main?.moduleImport ?? 'unknown',
      mainDownload: main?.download ?? 'unknown',
      verifierStarted: diagnostics.some(item => typeof item?.stage === 'string' &&
        (item.stage.startsWith('verify-') || item.stage.startsWith('verifier-'))),
      extractArchive: main?.extractArchive ?? 'unknown',
      extractCall: main?.extractCall ?? 'unknown',
      extractPhase: main?.extractPhase ?? 'unknown',
      downloadDirectoryEmpty: downloadEntries.length === 0,
      extractionDirectoryEmpty: extractionEntries.length === 0,
      relaunchRequested,
      sourceVersionUnchanged: afterVersion === beforeVersion,
      sourceIdentityUnchanged,
      sourceFixtureUnchanged: afterFixture === beforeFixture,
    };
    console.log('TUS_UPDATE_DIGEST_NEGATIVE ' + JSON.stringify(actual));
    assert.deepEqual(actual, {
      assetMatched: true,
      assetSelectionMatches: true,
      selectedTagMatches: true,
      selectedNameMatches: true,
      selectedDigestMatches: true,
      selectedSizeMatches: true,
      fetcherCalled: true,
      bytesFlipped: 1,
      bytesRead: expectedSize,
      responseComplete: true,
      attestationRequests: 0,
      rendererState: 'failed',
      rendererPhase: 'download',
      failureCode: 'DIGEST_MISMATCH',
      rendererInvoke: 'rejected',
      moduleImport: 'fulfilled',
      mainDownload: 'rejected',
      verifierStarted: false,
      extractArchive: 'not-started',
      extractCall: 'not-started',
      extractPhase: 'unknown',
      downloadDirectoryEmpty: true,
      extractionDirectoryEmpty: true,
      relaunchRequested: false,
      sourceVersionUnchanged: true,
      sourceIdentityUnchanged: handoffProfile ? true : null,
      sourceFixtureUnchanged: true,
    }, 'the packaged updater rejects one altered byte before provenance, extraction, or relaunch');
  } finally {
    fetchRestored = await current.instance.evaluate(() => {
      const boundary = globalThis.__tusUpdaterSmokeBoundary;
      const originalFetch = boundary?.digestMismatchFetch;
      if (typeof originalFetch !== 'function') return false;
      const controlRemoved = typeof boundary.digestMismatchFetcher === 'function';
      delete boundary.digestMismatchFetcher;
      delete boundary.digestMismatchFetch;
      delete boundary.digestMismatchControl;
      return controlRemoved && globalThis.fetch === originalFetch;
    }).catch(() => false);
  }
  assert.equal(fetchRestored, true, 'the packaged main process removes its one-shot digest control');
}

async function assertPartialDownloadAbortCleaned(current, {
  tag, assetName, expectedSize, expectedSha256, downloadsDir, extractDir, relaunchMarker, handoffProfile,
}) {
  const assetUrl = 'https://github.com/smart-tinker/the_unfinished_shapes/releases/download/' +
    encodeURIComponent(tag) + '/' + encodeURIComponent(assetName);
  const beforeFixture = await fixtureFingerprint(current);
  const beforeVersion = await current.instance.evaluate(({ app }) => app.getVersion());
  await current.page.evaluate(() => { window.__tusProvenanceDiagnostics = []; });
  const controlInstalled = await current.instance.evaluate((_electron, { assetUrl, tag, assetName, expectedSha256, expectedSize }) => {
    const boundary = globalThis.__tusUpdaterSmokeBoundary;
    if (!boundary || typeof globalThis.fetch !== 'function' ||
        typeof boundary.digestMismatchFetcher === 'function') return false;
    const originalFetch = globalThis.fetch;
    const assetUrls = new Set([assetUrl]);
    const control = {
      expectedTag: tag, expectedAssetName: assetName, expectedSha256, expectedSize,
      selectedAssetMatches: null, selectedTagMatches: null, selectedNameMatches: null,
      selectedDigestMatches: null, selectedSizeMatches: null, fetcherCalls: 0,
      assetRequests: 0, bodyResponses: 0, firstChunkBytes: 0, responseComplete: false,
      abortSignalObserved: false, attestationRequests: 0,
    };
    boundary.digestMismatchControl = control;
    boundary.digestMismatchFetch = originalFetch;
    boundary.digestMismatchFetcher = async (input, init) => {
      control.fetcherCalls++;
      const requestUrl = typeof input === 'string' ? input : input?.url;
      const isAssetRequest = control.selectedAssetMatches === true && assetUrls.has(requestUrl);
      if (typeof requestUrl === 'string' &&
          requestUrl.startsWith('https://api.github.com/repos/smart-tinker/the_unfinished_shapes/attestations/sha256:')) {
        control.attestationRequests++;
      }
      const response = await Reflect.apply(originalFetch, globalThis, [input, init]);
      if (!isAssetRequest) return response;
      control.assetRequests++;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (location) { try { assetUrls.add(new URL(location, requestUrl).href); } catch {} }
        return response;
      }
      if (!response.ok || !response.body || control.bodyResponses > 0) return response;
      control.bodyResponses++;
      const signal = init?.signal;
      if (!signal || typeof signal.addEventListener !== 'function') throw new Error('Missing download signal.');
      const body = response.body.pipeThrough(new TransformStream({
        async transform(chunk, controller) {
          if (control.firstChunkBytes) return;
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          control.firstChunkBytes = bytes.byteLength;
          controller.enqueue(bytes);
          await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
          control.abortSignalObserved = signal.aborted;
          throw new DOMException('Aborted', 'AbortError');
        },
        flush() { control.responseComplete = true; },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    return true;
  }, { assetUrl, tag, assetName, expectedSha256, expectedSize });
  assert.equal(controlInstalled, true, 'the packaged partial-download control is installed');

  let cancelSettled = false;
  let fetchRestored = false;
  try {
    const updateDir = path.join(downloadsDir, 'TheUnfinishedShapes-Updates');
    await activateUpdaterButtonByKeyboard(current.page, 'updates-download');
    let partialFiles = 0, partialBytes = 0;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && partialBytes === 0) {
      const names = await readdir(updateDir).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
      const parts = names.filter(name => name.endsWith('.part'));
      partialFiles = parts.length;
      for (const name of parts) {
        const stat = await lstat(path.join(updateDir, name)).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat?.isFile()) partialBytes = Math.max(partialBytes, stat.size);
      }
      if (partialBytes === 0) await new Promise(resolve => setTimeout(resolve, 25));
    }
    const partialBodyWritten = partialFiles === 1 && partialBytes > 0 && partialBytes < expectedSize;
    await current.page.waitForFunction(() => !document.querySelector('#updates-cancel')?.disabled, null, { timeout: 5000 });
    await activateUpdaterButtonByKeyboard(current.page, 'updates-cancel');
    await current.page.waitForFunction(() => {
      const status = document.querySelector('#updates-status');
      return status?.textContent === 'Download cancelled. You can try again.' &&
        status.dataset.updateInvokeStatus === 'fulfilled';
    }, null, { timeout: 15000 });
    cancelSettled = true;

    const [renderer, main, control, verifierStarted] = await Promise.all([
      current.page.evaluate(() => {
        const status = document.querySelector('#updates-status');
        return {
          cancelled: status?.textContent === 'Download cancelled. You can try again.',
          invoke: status?.dataset.updateInvokeStatus || 'not-started',
          failed: status?.dataset.updateFailure === 'true',
        };
      }),
      current.instance.evaluate(() => {
        const value = globalThis.__tusUpdaterSmokeBoundary;
        return value ? {
          moduleImport: value.moduleImport, download: value.downloadVerifiedAsset,
          extractArchive: value.extractArchive, extractCall: value.extractCall,
        } : null;
      }),
      current.instance.evaluate(() => {
        const value = globalThis.__tusUpdaterSmokeBoundary?.digestMismatchControl;
        return value ? {
          assetMatched: value.assetRequests > 0 && value.bodyResponses === 1,
          selectedAssetMatches: value.selectedAssetMatches === true,
          fetcherCalled: value.fetcherCalls > 0,
          firstChunkDelivered: value.firstChunkBytes > 0,
          abortSignalObserved: value.abortSignalObserved,
          responseComplete: value.responseComplete,
          attestationRequests: value.attestationRequests,
        } : null;
      }),
      current.page.evaluate(() => (window.__tusProvenanceDiagnostics || []).some(item =>
        typeof item?.stage === 'string' && (item.stage.startsWith('verify-') || item.stage.startsWith('verifier-')))),
    ]);
    const downloadEntries = await readdir(updateDir).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    const extractionEntries = await readdir(extractDir);
    const relaunchRequested = await lstat(relaunchMarker).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error));
    const afterVersion = await current.instance.evaluate(({ app }) => app.getVersion());
    const afterFixture = await fixtureFingerprint(current);
    let sourceIdentityUnchanged = null;
    if (handoffProfile) {
      const identity = await current.instance.evaluate(({ app }) => ({ executable: process.execPath, userData: app.getPath('userData') }));
      sourceIdentityUnchanged =
        path.resolve(identity.executable).toLowerCase() === path.resolve(handoffProfile.installedExe).toLowerCase() &&
        path.resolve(identity.userData).toLowerCase() === path.resolve(handoffProfile.userData).toLowerCase();
    }
    const actual = {
      assetMatched: control?.assetMatched === true,
      selectedAssetMatches: control?.selectedAssetMatches === true,
      fetcherCalled: control?.fetcherCalled === true,
      firstChunkDelivered: control?.firstChunkDelivered === true,
      partialBodyWritten,
      abortSignalObserved: control?.abortSignalObserved === true,
      responseComplete: control?.responseComplete === true,
      attestationRequests: control?.attestationRequests ?? null,
      rendererCancelled: renderer?.cancelled === true && renderer?.failed !== true,
      rendererInvoke: renderer?.invoke ?? 'unknown',
      moduleImport: main?.moduleImport ?? 'unknown',
      mainDownload: main?.download ?? 'unknown',
      verifierStarted,
      extractArchive: main?.extractArchive ?? 'unknown',
      extractCall: main?.extractCall ?? 'unknown',
      downloadDirectoryEmpty: downloadEntries.length === 0,
      extractionDirectoryEmpty: extractionEntries.length === 0,
      relaunchRequested,
      sourceVersionUnchanged: afterVersion === beforeVersion,
      sourceIdentityUnchanged,
      sourceFixtureUnchanged: afterFixture === beforeFixture,
    };
    console.log('TUS_UPDATE_PARTIAL_ABORT ' + JSON.stringify(actual));
    assert.deepEqual(actual, {
      assetMatched: true, selectedAssetMatches: true, fetcherCalled: true,
      firstChunkDelivered: true, partialBodyWritten: true, abortSignalObserved: true,
      responseComplete: false, attestationRequests: 0, rendererCancelled: true,
      rendererInvoke: 'fulfilled', moduleImport: 'fulfilled', mainDownload: 'fulfilled',
      verifierStarted: false, extractArchive: 'not-started', extractCall: 'not-started',
      downloadDirectoryEmpty: true, extractionDirectoryEmpty: true, relaunchRequested: false,
      sourceVersionUnchanged: true, sourceIdentityUnchanged: handoffProfile ? true : null,
      sourceFixtureUnchanged: true,
    }, 'a mid-body cancel removes the partial package and preserves the source for retry');
  } finally {
    if (!cancelSettled) {
      await activateUpdaterButtonByKeyboard(current.page, 'updates-cancel').catch(() => {});
      await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent === 'Download cancelled. You can try again.', null, { timeout: 5000 }).catch(() => {});
    }
    fetchRestored = await current.instance.evaluate(() => {
      const boundary = globalThis.__tusUpdaterSmokeBoundary;
      const originalFetch = boundary?.digestMismatchFetch;
      if (typeof originalFetch !== 'function') return false;
      const controlRemoved = typeof boundary.digestMismatchFetcher === 'function';
      delete boundary.digestMismatchFetcher;
      delete boundary.digestMismatchFetch;
      delete boundary.digestMismatchControl;
      return controlRemoved && globalThis.fetch === originalFetch;
    }).catch(() => false);
  }
  assert.equal(fetchRestored, true, 'the packaged process removes its one-shot partial-download control');
}

async function assertArchiveWriteFailureCleaned(current, {
  downloadedPath, manifestFile, manifestVersion, assetName, tag, downloadsDir, extractDir, relaunchMarker,
}) {
  const beforeFixture = await fixtureFingerprint(current);
  const beforeIdentity = await current.instance.evaluate(({ app }) => ({
    version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'),
  }));
  assert.equal(await fileDigest(downloadedPath), manifestFile.sha256, 'the official asset digest is valid before extraction');

  const controlInstalled = await current.instance.evaluate(() => {
    const boundary = globalThis.__tusUpdaterSmokeBoundary;
    if (!boundary || boundary.downloadVerifiedAsset !== 'fulfilled' || boundary.writeFailureControl) return false;
    boundary.writeFailureControl = { state: 'armed', firstChunkWritten: false, errorCode: 'EACCES' };
    return true;
  });
  assert.equal(controlInstalled, true, 'the write failure is armed only after the packaged verifier accepted the download');

  try {
    await current.page.locator('#updates-extract').click({ noWaitAfter: true });
    const observedFailureHandle = await current.page.waitForFunction(() => {
      const status = document.querySelector('#updates-status');
      if (status?.dataset.updateExtractInvokeStatus === 'rejected' &&
          status.dataset.updateExtractStage === 'write') {
        return {
          rendererInvokeStatus: status.dataset.updateExtractInvokeStatus,
          failureCode: status.dataset.updateExtractFailureCode,
          extractStage: status.dataset.updateExtractStage,
        };
      }
      return false;
    }, null, { timeout: 120000 });
    let observedFailure;
    try { observedFailure = await observedFailureHandle.jsonValue(); }
    finally { await observedFailureHandle.dispose(); }

    const [safeObservedFailure] = safeMainDiagnostics([{
      stage: 'extract-archive',
      status: 'rejected',
      rendererInvokeStatus: observedFailure?.rendererInvokeStatus,
      failureCode: observedFailure?.failureCode,
      extractStage: observedFailure?.extractStage,
    }], manifestFile, assetName, tag);
    const runtime = await extractRuntimeBoundary(current, extractDir, manifestVersion, manifestFile, assetName, tag);
    const control = await current.instance.evaluate(() => {
      const value = globalThis.__tusUpdaterSmokeBoundary?.writeFailureControl;
      return value ? { state: value.state, firstChunkWritten: value.firstChunkWritten === true } : null;
    });
    const [downloadEntries, extractionEntries] = await Promise.all([
      readdir(downloadsDir),
      readdir(extractDir),
    ]);
    const [assetSha256, afterFixture, afterIdentity] = await Promise.all([
      fileDigest(downloadedPath),
      fixtureFingerprint(current),
      current.instance.evaluate(({ app }) => ({
        version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'),
      })),
    ]);
    const relaunchRequested = await lstat(relaunchMarker).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    const appAsarRemoved = runtime.fileFlags?.appAsarExists === false &&
      runtime.fileFlags?.appAsarFile === false && runtime.fileFlags?.stagedAsarExists === false;
    const targetRemoved = runtime.fileFlags?.targetExists === false &&
      runtime.fileFlags?.executableExists === false && appAsarRemoved && extractionEntries.length === 0;
    const sourceIdentityUnchanged = beforeIdentity.version === afterIdentity.version &&
      path.resolve(beforeIdentity.executable).toLowerCase() === path.resolve(afterIdentity.executable).toLowerCase() &&
      path.resolve(beforeIdentity.userData).toLowerCase() === path.resolve(afterIdentity.userData).toLowerCase();
    const actual = {
      mainStatus: runtime.mainStatus,
      extractModuleImport: runtime.extractModuleImport,
      extractCall: runtime.extractCall,
      rendererInvokeStatus: safeObservedFailure.rendererInvokeStatus,
      failureCode: safeObservedFailure.failureCode,
      extractStage: safeObservedFailure.extractStage,
      injection: 'synthetic-eacces-after-first-write',
      controlState: control?.state ?? 'missing',
      firstChunkWritten: control?.firstChunkWritten === true,
      targetRemoved,
      downloadRetained: downloadEntries.length === 1 && downloadEntries[0] === path.basename(downloadedPath),
      downloadDigestMatches: assetSha256 === manifestFile.sha256,
      relaunchRequested,
      sourceProcessAlive: current.instance.process().exitCode === null,
      sourceVersionUnchanged: beforeIdentity.version === afterIdentity.version,
      sourceIdentityUnchanged,
      sourceFixtureUnchanged: afterFixture === beforeFixture,
    };
    console.log('TUS_UPDATE_WRITE_FAILURE ' + JSON.stringify(actual));
    assert.deepEqual(actual, {
      mainStatus: 'rejected',
      extractModuleImport: 'fulfilled',
      extractCall: 'rejected',
      rendererInvokeStatus: 'rejected',
      failureCode: 'FILESYSTEM_PERMISSION',
      extractStage: 'write',
      injection: 'synthetic-eacces-after-first-write',
      controlState: 'injected',
      firstChunkWritten: true,
      targetRemoved: true,
      downloadRetained: true,
      downloadDigestMatches: true,
      relaunchRequested: false,
      sourceProcessAlive: true,
      sourceVersionUnchanged: true,
      sourceIdentityUnchanged: true,
      sourceFixtureUnchanged: true,
    }, 'synthetic post-write EACCES removes the partial target without relaunch and preserves the source for a same-asset retry');
  } finally {
    await current.instance.evaluate(() => {
      const boundary = globalThis.__tusUpdaterSmokeBoundary;
      if (boundary?.writeFailureControl) {
        boundary.writeFailureControl.state = 'disabled';
        delete boundary.writeFailureControl;
      }
    }).catch(() => {});
  }
}

async function updateOnce(distribution, setDiagnostic = () => {}) {
  const workDir = await mkdtemp(path.join(testRoot, 'package-'));
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
  await focusByKeyboard(current.page, '#settings-open');
  await current.page.keyboard.press('Enter');
  await current.page.locator('#settings').waitFor({ state: 'visible', timeout: 5000 });
  await focusByKeyboard(current.page, '#update-channel');
  await current.page.keyboard.press('p');
  assert.equal(await current.page.locator('#update-channel').inputValue(), 'prerelease', 'keyboard selection changes the channel');
  await focusByKeyboard(current.page, '#settings-close');
  await current.page.keyboard.press('Enter');
  await current.page.locator('#settings').waitFor({ state: 'hidden', timeout: 5000 });
  await current.page.waitForFunction(() => document.querySelector('#update-channel')?.value === 'stable', null, { timeout: 5000 });
  assert.equal(
    await current.page.evaluate(async () => (await window.tus.loadSettings()).updateChannel),
    'stable',
    'keyboard cancel discards the unsaved channel selection',
  );

  await focusByKeyboard(current.page, '#settings-open');
  await current.page.keyboard.press('Enter');
  await current.page.locator('#settings').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await current.page.locator('#update-channel').inputValue(), 'stable', 'reopening restores the saved channel');
  await focusByKeyboard(current.page, '#update-channel');
  await current.page.keyboard.press('p');
  assert.equal(await current.page.locator('#update-channel').inputValue(), 'prerelease', 'keyboard can select the prerelease channel again');
  if (process.platform === 'win32') await current.page.locator('#update-distribution').selectOption(distribution);
  await focusByKeyboard(current.page, '#updates-save');
  await current.page.keyboard.press('Enter');
  await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent === 'Update preference saved.');
  assert.equal(
    await current.page.evaluate(async () => (await window.tus.loadSettings()).updateChannel),
    'prerelease',
    'keyboard activation saves the selected channel',
  );
  await logUpdaterReleaseFetchObservation(current, 'before-first-exit');
  const firstProcess = current.instance.process();
  const firstExit = waitForExit(firstProcess);
  await current.instance.evaluate(({ app }) => app.quit());
  await closeAfterQuit(current, firstExit);

  setDiagnostic('source-identity');
  current = await start(sourceExecutable, 'updater preference restart ' + distribution, dataDir, true, sourceEnv);
  await assertInstalledSourceIdentity(current, handoffProfile);
  setDiagnostic('check-download');
  await focusByKeyboard(current.page, '#settings-open');
  await current.page.keyboard.press('Enter');
  await current.page.locator('#settings').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await current.page.locator('#update-channel').inputValue(), 'prerelease', 'the keyboard-selected channel survives restart and reopening');
  if (process.platform === 'win32') await current.page.locator('#update-distribution').selectOption(distribution);
  let restartStartupFetches;
  try {
    await current.page.waitForFunction(() => !document.querySelector('#updates-notice')?.hidden, null, { timeout: 30000 });
  } finally {
    restartStartupFetches = await logUpdaterReleaseFetchObservation(current, 'restart-startup');
  }
  const startupNotice = await current.page.locator('#updates-notice').getAttribute('title');
  const startupErrorCode = (await current.page.locator('#updates-notice').getAttribute('data-error-code')) || null;
  if (startupErrorCode) {
    const allowedStartupErrorCodes = new Set(['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed']);
    const errorCode = allowedStartupErrorCodes.has(startupErrorCode) ? startupErrorCode : 'check_failed';
    setDiagnostic('check-download', errorCode);
    console.log('Updater startup release diagnostic ' + JSON.stringify({ status: 'error', errorCode }));
  }
  const startupAvailable = !startupErrorCode && /available\./.test(startupNotice || '');
  const manualRequestsBeforeDispatch = restartStartupFetches?.available
    ? restartStartupFetches.requests.filter(item => item.phase === 'manual').length : null;
  if (!startupAvailable) {
    console.log('TUS_UPDATER_MANUAL_CHECK ' + JSON.stringify({
      startup: 'unavailable',
      uiAction: 'not-dispatched',
      manualGetObservation: manualRequestsBeforeDispatch === 0 ? 'not-observed'
        : manualRequestsBeforeDispatch === null ? 'unknown' : 'observed',
      manualGetCount: manualRequestsBeforeDispatch,
    }));
  }
  assert.equal(restartStartupFetches?.available, true, 'the packaged main release-fetch observer is available');
  assert.ok(restartStartupFetches.requests.some(item => item.phase === 'startup'), 'startup selection uses an observed release GET');
  if (startupAvailable) {
    assert.ok(restartStartupFetches.requests.filter(item => item.phase === 'startup')
      .every(item => item.status !== null && item.safeFailure === 'none'), 'available startup check completed its observed HTTP pages');
  }
  if (!startupAvailable) assert.equal(manualRequestsBeforeDispatch, 0, 'failed startup is not followed by a manual release GET');
  assert.equal(startupErrorCode, null, 'manual update check is not dispatched after startup failure');
  assert.match(startupNotice || '', /available\./, 'startup checks expose a published update without installing it');
  const startupTag = startupNotice?.match(/Prerelease (v\d+\.\d+\.\d+-rc\.?\d+) is available\./)?.[1];
  assert.ok(startupTag, 'startup check identifies the published prerelease');
  assert.ok(compareReleaseVersions(startupTag, baselineVersion) > 0, 'startup check identifies a newer prerelease');

  await observeUpdaterKeyboardActions(current.page);
  await activateUpdaterButtonByKeyboard(current.page, 'updates-check');
  let manualFetches;
  try {
    await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent.includes(' is available.'), null, { timeout: 30000 });
  } finally {
    const manualSnapshot = await logUpdaterReleaseFetchObservation(current, 'restart-manual');
    manualFetches = manualSnapshot.available ? manualSnapshot.requests.filter(item => item.phase === 'manual') : null;
    console.log('TUS_UPDATER_MANUAL_CHECK ' + JSON.stringify({
      startup: 'available',
      uiAction: 'dispatched',
      manualGetObservation: manualFetches === null ? 'unknown' : manualFetches.length ? 'observed' : 'not-observed',
      manualGetCount: manualFetches?.length ?? null,
    }));
  }
  assert.ok(manualFetches?.length > 0, 'keyboard manual check performs a real release GET');
  assert.ok(manualFetches.every(item => item.status !== null && item.safeFailure === 'none'), 'manual release GET pages returned successful HTTP responses');
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

  const relaunchMarker = path.join(workDir, 'relaunch.json');
  const dialogMarker = path.join(workDir, 'update-dialog.json');
  await configureUpdateDialogs(current.instance, {
    downloadsDir, extractDir,
    dialogMarker,
    extractMarker: path.join(workDir, 'extract-folder-chooser.json'),
    relaunchMarker,
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

  if (distribution !== 'installer') {
    const incompatiblePlatform = process.platform === 'win32' ? 'linux' : 'windows';
    const incompatibleManifest = await getManifest(tag, incompatiblePlatform);
    assert.equal(incompatibleManifest.sourceSha, manifest.sourceSha, 'the incompatible package comes from the same selected release source');
    const incompatibleSuffix = incompatiblePlatform === 'windows' ? 'win32-x64.zip' : 'linux-x64.tar.gz';
    const incompatibleAssetName = 'TheUnfinishedShapes-' + incompatibleManifest.version + '-' + incompatibleSuffix;
    const incompatibleFile = incompatibleManifest.files.find(file => file.name === incompatibleAssetName);
    assert.ok(incompatibleFile, 'the exact cross-platform asset has a published digest');
    const incompatibleResult = await current.page.evaluate(async () =>
      typeof window.tus.smokeVerifyIncompatiblePackage === 'function'
        ? window.tus.smokeVerifyIncompatiblePackage()
        : null);
    const relaunchRequested = await lstat(relaunchMarker).then(() => true, () => false);
    const incompatibleDiagnostic = {
      verifierSetupReady: incompatibleResult?.verifierSetupReady === true,
      verifierVerified: incompatibleResult?.verifierVerified === true,
      status: incompatibleResult?.status === 'verified-incompatible-rejected' ? incompatibleResult.status : 'control-unavailable',
      tagMatches: incompatibleResult?.tag === tag,
      assetMatches: incompatibleResult?.assetName === incompatibleAssetName,
      digestMatches: incompatibleResult?.sha256 === incompatibleFile.sha256,
      sizeMatches: incompatibleResult?.size === incompatibleFile.size,
      sourceShaMatches: incompatibleResult?.sourceSha === incompatibleManifest.sourceSha,
      failureCode: incompatibleResult?.failureCode || 'OTHER',
      extractStage: ['preflight', 'digest', 'zip-open', 'zip-read', 'write', 'executable', 'cleanup', 'unknown'].includes(incompatibleResult?.extractStage)
        ? incompatibleResult.extractStage : 'unknown',
      targetCreated: incompatibleResult?.targetCreated === true,
      relaunchRequested,
    };
    console.log('TUS_UPDATE_INCOMPATIBLE ' + JSON.stringify(incompatibleDiagnostic));
    assert.deepEqual(incompatibleDiagnostic, {
      verifierSetupReady: true,
      verifierVerified: true,
      status: 'verified-incompatible-rejected',
      tagMatches: true,
      assetMatches: true,
      digestMatches: true,
      sizeMatches: true,
      sourceShaMatches: true,
      failureCode: 'UNSUPPORTED_PACKAGE',
      extractStage: 'preflight',
      targetCreated: false,
      relaunchRequested: false,
    }, 'the normal packaged verifier accepts the exact official asset before extraction fails closed for this device');
  }

  setDiagnostic('check-download');
  await assertDigestMismatchRejected(current, {
    tag, assetName, expectedSize: manifestFile.size, expectedSha256: manifestFile.sha256,
    downloadsDir, extractDir, relaunchMarker, handoffProfile,
  });
  await assertPartialDownloadAbortCleaned(current, {
    tag, assetName, expectedSize: manifestFile.size, expectedSha256: manifestFile.sha256,
    downloadsDir, extractDir, relaunchMarker, handoffProfile,
  });
  await activateUpdaterButtonByKeyboard(current.page, 'updates-download');
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
  console.log('TUS_UPDATE_ABORT_RETRY status=verified package=' + distribution);
  if (distribution === 'installer') {
    assert.ok(handoffProfile, 'the exact installer handoff has an isolated source profile');
    pendingWindowsInstallerCleanup = {
      installerPath: downloadedPath,
      installDir: handoffProfile.installDir,
    };
  }

  if (distribution !== 'installer') {
    setDiagnostic('extract');
    await assertArchiveWriteFailureCleaned(current, {
      downloadedPath, manifestFile, manifestVersion: manifest.version, assetName, tag,
      downloadsDir: path.join(downloadsDir, 'TheUnfinishedShapes-Updates'),
      extractDir, relaunchMarker,
    });
    await assertPortableExtractVerified(async () => {
      const pendingStatus = 'Choose a destination folder…';
      const successStatus = 'Verified archive extracted. You can now launch the new copy.';
      const extractChooserMarker = path.join(workDir, 'extract-folder-chooser.json');
      await rm(extractChooserMarker, { force: true });
      await activateUpdaterButtonByKeyboard(current.page, 'updates-extract');
      const folderChooserInvoked = await waitForFile(extractChooserMarker, 5000);
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
        const streamSamplingStartedAtMs = performance.now();
        const scheduleStreamSample = () => {
          const offsetMs = updaterZipStreamSampleOffsetsMs[streamSamples];
          if (!streamSampling || offsetMs === undefined) return;
          const targetAtMs = streamSamplingStartedAtMs + offsetMs;
          streamSampleTimer = setTimeout(() => { void captureStreamSample().catch(() => {}); },
            Math.max(0, targetAtMs - performance.now()));
        };
        const captureStreamSample = async () => {
          streamSampleTimer = null;
          if (!streamSampling || streamSamples >= updaterZipStreamSampleOffsetsMs.length) return;
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
          scheduleStreamSample();
        };
        scheduleStreamSample();
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
      return extractDiagnostic.outcome;
    });
    assert.equal(await fileDigest(downloadedPath), manifestFile.sha256, 'the same published asset remains intact for the positive retry');
    assert.deepEqual(await readdir(path.dirname(downloadedPath)), [path.basename(downloadedPath)], 'the retry reuses the retained download');
    console.log('TUS_UPDATE_WRITE_FAILURE_RETRY outcome=verified injection=synthetic-eacces-after-first-write');
  }

  setDiagnostic(distribution === 'installer' ? 'relaunch-cancel' : 'relaunch');
  await respondToUpdateLaunch(current, dialogMarker, 'Escape', manifestFile, assetName, tag, distribution);
  let cancelStatus = 'cancelled';
  try {
    await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent === 'Update launch cancelled.');
    const runtime = await updaterRuntimeBoundary(current, manifestFile, assetName, tag, 1000).catch(() => []);
    const responseBoundary = runtime.find(item => item.stage === 'update-launch') ?? null;
    console.log('TUS_UPDATE_LAUNCH_RESPONSE ' + JSON.stringify(responseBoundary));
  } catch (error) {
    cancelStatus = error?.name === 'TimeoutError' ? 'timeout' : 'unavailable';
    console.log('TUS_UPDATE_LAUNCH_CANCEL ' + JSON.stringify({ status: cancelStatus }));
    throw error;
  }
  const relaunchAfterCancel = await lstat(relaunchMarker).then(() => true, error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const sourceProcessAlive = current.instance.process().exitCode === null;
  console.log('TUS_UPDATE_LAUNCH_CANCEL ' + JSON.stringify({
    status: cancelStatus,
    relaunchRequested: relaunchAfterCancel,
    sourceProcessAlive,
  }));
  assert.equal(relaunchAfterCancel, false, 'cancel never requests an update relaunch');
  assert.equal(sourceProcessAlive, true, 'cancel leaves the game open and the verified update available');
  setDiagnostic(distribution === 'installer' ? 'relaunch-approve' : 'relaunch');

  const closing = current;
  if (distribution === 'installer') {
    const child = closing.instance.process();
    setDiagnostic('relaunch-click');
    let relaunchFailure;
    try {
      await runWindowsRelaunch({
      child,
      click: () => respondToUpdateLaunch(closing, dialogMarker, 'Enter', manifestFile, assetName, tag, distribution).catch(error => {
        if (child.exitCode === null) throw error;
      }),
      waitForExit,
      cleanup: async (startedChild, failure) => {
        assert.equal(startedChild, child, 'relaunch cleanup uses the exact started updater child');
        if (failure) {
          let closeFailure;
          try { await closeActive('failed installer relaunch'); } catch (error) { closeFailure = error; }
          await cleanupPendingWindowsInstaller();
          if (closeFailure) throw closeFailure;
        } else {
          await closeAfterQuit(closing, Promise.resolve());
        }
      },
      validateRequest: async () => {
        setDiagnostic('relaunch-request');
        const relaunchStatus = windowsRelaunchRequestStatus(
          await readFile(relaunchMarker, 'utf8').catch(() => ''),
          downloadedPath,
        );
        console.log(safeInstallerHandoffEvents(
          'TUS_INSTALLER_HANDOFF check=relaunch-request:' + relaunchStatus,
        ).join(String.fromCharCode(10)));
        assert.equal(relaunchStatus, 'match', 'production relaunch requests the exact verified Setup with no arguments');
      },
      });
    } catch (error) { relaunchFailure = error; }
    if (relaunchFailure) throw relaunchFailure;
  } else {
    const exit = waitForExit(closing.instance.process());
    const approval = respondToUpdateLaunch(closing, dialogMarker, 'Enter', manifestFile, assetName, tag, distribution).catch(error => {
      if (closing.instance.process().exitCode === null) throw error;
    });
    setDiagnostic('relaunch');
    await Promise.all([approval, closeAfterQuit(closing, exit)]);
  }

  setDiagnostic(distribution === 'installer' ? 'relaunch-prompt' : 'relaunch');
  const prompt = JSON.parse(await readFile(path.join(workDir, 'update-dialog.json'), 'utf8'));
  assert.equal(prompt.title, 'Start verified update');
  assert.deepEqual(prompt.buttons, ['Cancel', 'Quit and launch']);
  setDiagnostic(distribution === 'installer' ? 'relaunch-request' : 'relaunch');
  const relaunch = JSON.parse(await readFile(path.join(workDir, 'relaunch.json'), 'utf8'));
  assert.deepEqual(relaunch.args, [], 'the update launches without carrying commands or conversation text');
  setDiagnostic(distribution === 'installer' ? 'relaunch-target' : 'relaunch');
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
    assert.equal(await cleanupPendingWindowsInstaller(), true, 'the exact verified Setup exits after target verification');
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

const resultStage = process.platform === 'win32' ? 'windows-scenarios' : 'archive-update';
await withSmokeCleanup(async () => {
  try {
    if (process.platform === 'win32') {
      const outcomes = await runWindowsUpdaterScenarios({
        portable: () => runIndependentWindowsScenario('portable'),
        installer: () => runIndependentWindowsScenario('installer'),
        cleanupInstaller: cleanupPendingWindowsInstaller,
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
    updaterMarker('RESULT', resultStage, 'passed');
  } catch (error) {
    updaterMarker('RESULT', resultStage, 'failed');
    throw error;
  }
}, async () => {
  await closeActive('updater test cleanup');
}, () => cleanupUpdaterTemporaryData({
  testRoot,
  canRemove: cleanupPendingWindowsInstaller,
  remove: rm,
  onOutcome: outcome => updaterMarker('CLEANUP', 'temporary-data', outcome),
}));
