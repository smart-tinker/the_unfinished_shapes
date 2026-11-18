import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { compareReleaseVersions } from '../src/update-release.mjs';
import { safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType, verifyReleaseAttestation } from '../src/update-package.mjs';
import { closeSmokeApp, observeGraphics, withSmokeCleanup } from './graphics-smoke.mjs';
import { createGpuDiagnostics } from './gpu-smoke.mjs';
import { safeMainDiagnostics } from './updater-smoke-diagnostics.mjs';

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

async function start(executablePath, label, dataDir, useBaseline = false) {
  const gpu = await createGpuDiagnostics(label);
  let instance;
  let graphics;
  try {
    const env = { ...process.env, TUS_DATA_DIR: dataDir };
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

async function configureUpdateDialogs(instance, { downloadsDir, extractDir, dialogMarker, extractMarker, relaunchMarker }) {
  await instance.evaluate(({ app, dialog }, config) => {
    const { writeFileSync } = process.getBuiltinModule('node:fs');
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
    app.relaunch = ({ execPath, args }) => writeFileSync(config.relaunchMarker, JSON.stringify({ execPath, args }));
  }, { downloadsDir, extractDir, dialogMarker, extractMarker, relaunchMarker });
}

async function updateOnce(distribution) {
  const workDir = await mkdtemp(path.join(testRoot, 'package-'));
  workDirs.push(workDir);
  const dataDir = path.join(workDir, 'data');
  const downloadsDir = path.join(workDir, 'downloads');
  const extractDir = path.join(workDir, 'extracted');
  await Promise.all([mkdir(dataDir), mkdir(downloadsDir), mkdir(extractDir)]);

  let current = await start(executable, 'updater source ' + distribution, dataDir, true);
  await addWorldFixture(current.page);
  await current.page.locator('#settings-open').click();
  await current.page.locator('#update-channel').selectOption('prerelease');
  if (process.platform === 'win32') await current.page.locator('#update-distribution').selectOption(distribution);
  await current.page.locator('#updates-save').click();
  await current.page.waitForFunction(() => document.querySelector('#updates-status')?.textContent === 'Update preference saved.');
  const firstProcess = current.instance.process();
  const firstExit = waitForExit(firstProcess);
  await current.instance.evaluate(({ app }) => app.quit());
  await closeAfterQuit(current, firstExit);

  current = await start(executable, 'updater preference restart ' + distribution, dataDir, true);
  await current.page.locator('#settings-open').click();
  assert.equal(await current.page.locator('#update-channel').inputValue(), 'prerelease', 'the selected update channel survives restart');
  if (process.platform === 'win32') await current.page.locator('#update-distribution').selectOption(distribution);
  await current.page.waitForFunction(() => !document.querySelector('#updates-notice')?.hidden, null, { timeout: 30000 });
  const startupNotice = await current.page.locator('#updates-notice').getAttribute('title');
  const startupErrorCode = await current.page.locator('#updates-notice').getAttribute('data-error-code');
  if (startupErrorCode) {
    const allowedStartupErrorCodes = new Set(['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed']);
    const errorCode = allowedStartupErrorCodes.has(startupErrorCode) ? startupErrorCode : 'check_failed';
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
  });
  await current.page.evaluate(() => {
    window.__tusProvenanceDiagnostics = [];
    window.tus.onUpdateProgress(progress => {
      if (progress?.provenanceDiagnostic && window.__tusProvenanceDiagnostics.length < 40) {
        window.__tusProvenanceDiagnostics.push(progress.provenanceDiagnostic);
      }
    });
  });
  await current.page.locator('#updates-download').click();
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
      try {
        await current.page.waitForFunction(({ pending, prior }) => {
          const status = document.querySelector('#updates-status')?.textContent;
          return Boolean(status && status !== pending && status !== prior);
        }, { pending: pendingStatus, prior: verified }, { timeout: 120000 });
        const status = await current.page.locator('#updates-status').innerText();
        if (status === successStatus) {
          extractDiagnostic.outcome = 'verified';
          extractDiagnostic.reason = 'none';
        } else if (status === 'Folder selection cancelled.') {
          extractDiagnostic.outcome = 'cancelled';
          extractDiagnostic.reason = 'folder-selection-cancelled';
        } else {
          extractDiagnostic.outcome = 'rejected';
          extractDiagnostic.reason = 'renderer-reported-error';
          extractDiagnostic.failureCode = await current.page.evaluate(
            () => document.querySelector('#updates-status')?.dataset.updateExtractFailureCode || 'OTHER',
          );
          const [safeExtraction] = safeMainDiagnostics([{
            stage: 'extract-failed',
            status: 'rejected',
            extractStage: await current.page.evaluate(
              () => document.querySelector('#updates-status')?.dataset.updateExtractStage || 'unknown',
            ),
          }], manifestFile, assetName, tag);
          extractDiagnostic.extractStage = safeExtraction.extractStage;
        }
      } catch (error) {
        if (error?.name !== 'TimeoutError') {
          extractDiagnostic.outcome = 'unobserved';
          extractDiagnostic.reason = 'status-observation-failed';
        }
      }
    }
    console.log('TUS_UPDATE_EXTRACT_DIAGNOSTIC ' + JSON.stringify(extractDiagnostic));
    assert.equal(extractDiagnostic.outcome, 'verified', 'the selected verified archive reaches a terminal extraction success');
  }

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
    extractDir,
    'TheUnfinishedShapes-' + targetVersion + (process.platform === 'darwin' ? '.app' : ''),
    ...(process.platform === 'darwin' ? ['Contents', 'MacOS', 'TheUnfinishedShapes'] : [process.platform === 'win32' ? 'TheUnfinishedShapes.exe' : 'TheUnfinishedShapes']),
  );
  assert.equal(path.resolve(relaunch.execPath), path.resolve(expectedExecutable), 'only the verified installer or extracted executable is passed to relaunch');
  await access(relaunch.execPath);

  let targetExecutable = null;
  if (distribution !== 'installer') {
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

async function verifyWindowsInstaller(installerResult, portableResult) {
  const rootPath = projectPackagePath;
  const original = await readFile(rootPath, 'utf8');
  const rootPackage = JSON.parse(original);
  const targetVersion = installerResult.manifest.version;
  assert.equal(installerResult.manifest.tag, portableResult.manifest.tag);
  assert.equal(installerResult.manifest.sourceSha, portableResult.manifest.sourceSha);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tus-update-installer-'));
  const appData = path.join(temp, 'Roaming');
  const localData = path.join(temp, 'Local');
  await Promise.all([mkdir(appData), mkdir(localData)]);
  try {
    rootPackage.version = targetVersion;
    await writeFile(rootPath, JSON.stringify(rootPackage, null, 2) + '\n');
    const result = await execute(process.execPath, ['scripts/windows-installer-smoke.mjs'], {
      cwd: process.cwd(),
      timeout: 1200000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: localData,
        GITHUB_SHA: installerResult.manifest.sourceSha,
        TUS_DATA_DIR: '',
        TUS_SMOKE_INSTALLER: installerResult.downloadedPath,
        TUS_SMOKE_PORTABLE_EXECUTABLE: portableResult.targetExecutable,
      },
    });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
  } finally {
    await writeFile(rootPath, original);
    await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

try {
  if (process.platform === 'win32') {
    const portable = await updateOnce('portable');
    const installer = await updateOnce('installer');
    await verifyWindowsInstaller(installer, portable);
    console.log('Windows updater acceptance passed for both portable and NSIS packages from the same published release.');
  } else {
    await updateOnce('archive');
  }
} finally {
  await closeActive('updater test cleanup').catch(() => {});
  for (const workDir of workDirs) await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await rm(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
