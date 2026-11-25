import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('installed-source restart reuses the source executable and profile configuration', async () => {
  const smoke = await readFile(new URL('../scripts/updater-release-smoke.mjs', import.meta.url), 'utf8');
  const sourceLaunch = "start(sourceExecutable, 'updater source ' + distribution, dataDir, true, sourceEnv)";
  const restartLaunch = "start(sourceExecutable, 'updater preference restart ' + distribution, dataDir, true, sourceEnv)";

  assert.ok(smoke.includes(sourceLaunch), 'the first launch uses the installed source identity');
  assert.ok(smoke.includes(restartLaunch), 'the preference restart keeps the executable, data directory and environment');
});


test('Windows installed-source handoff pins one user-data profile before fixture writes', async () => {
  const smoke = await readFile(new URL('../scripts/updater-release-smoke.mjs', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../scripts/windows-installer-smoke.mjs', import.meta.url), 'utf8');

  assert.ok(smoke.includes("const dataDir = handoffProfile ? handoffProfile.userData : path.join(workDir, 'data')"));
  assert.ok(smoke.includes('TUS_DATA_DIR: profile.userData'));
  assert.ok(helper.includes("const dataDir = path.resolve(process.env.TUS_DATA_DIR || path.join(process.env.APPDATA, 'the-unfinished-shapes'))"));
  assert.ok(helper.includes("TUS_DATA_DIR: handoffMode ? dataDir : ''"), 'only the isolated handoff overrides the native default path');

  const identity = helper.indexOf("console.log('TUS_INSTALLER_HANDOFF stage=source-identity-verified')");
  const fixture = helper.indexOf('await mkdir(settingsFixture.workspacePath', identity);
  assert.ok(identity >= 0 && fixture > identity, 'settings/world fixture writes follow the complete identity gate');
});

test('handoff identity events expose only separate safe checks', async () => {
  const { safeInstallerHandoffEvents, runWindowsUpdaterScenarios } = await import('../scripts/windows-updater-scenarios.mjs');
  const events = safeInstallerHandoffEvents([
    'TUS_INSTALLER_HANDOFF check=build-label:match',
    'TUS_INSTALLER_HANDOFF check=build-title-sha:match',
    'TUS_INSTALLER_HANDOFF check=app-version:match',
    'TUS_INSTALLER_HANDOFF check=user-data:mismatch',
    'TUS_INSTALLER_HANDOFF check=startup-health:failed',
    'TUS_INSTALLER_HANDOFF check=build-title-sha:mismatch C:/private/app.exe',
    'raw error /private/profile',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [
    'TUS_INSTALLER_HANDOFF check=build-label:match',
    'TUS_INSTALLER_HANDOFF check=build-title-sha:match',
    'TUS_INSTALLER_HANDOFF check=app-version:match',
    'TUS_INSTALLER_HANDOFF check=user-data:mismatch',
    'TUS_INSTALLER_HANDOFF check=startup-health:failed',
  ]);
  assert.equal(JSON.stringify(events).includes('C:/private/app.exe'), false);
  assert.equal(JSON.stringify(events).includes('/private/profile'), false);

  const error = new Error('raw profile path');
  error.tusScenarioDiagnostic = { stage: 'source-identity', category: 'user-data', path: 'C:/private/profile' };
  const outcome = (await runWindowsUpdaterScenarios({ portable: async () => {}, installer: async () => { throw error; } })).installer;
  assert.deepEqual(outcome.diagnostic, { stage: 'source-identity', category: 'user-data' });
});

test('pending ZIP extraction exposes per-entry read, decode and write state without entry data', async () => {
  const updatePackage = await import('../src/update-package.mjs');
  assert.equal(typeof updatePackage.safeZipExtractionStreamSnapshot, 'function');
  const source = { readableEnded: false, actualByteCount: 999, path: 'C:/private/archive.zip' };
  const compressedSource = { start: 50, pos: 300, path: 'C:/private/archive.zip', entryName: 'private-entry' };
  const entry = { compressionMethod: 8, compressedSize: 111_522_616, uncompressedSize: 249_832_448, fileName: 'private-entry' };
  const sink = {
    writableFinished: false,
    closed: false,
    bytesWritten: 3_000_000_000,
    writableLength: Number.MAX_SAFE_INTEGER,
    path: 'C:/private/app.asar',
    entryName: 'private-entry',
  };
  assert.deepEqual(updatePackage.safeZipExtractionStreamSnapshot(source, sink, 12, entry, compressedSource), {
    entrySequence: 12,
    compression: 'deflate',
    entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448,
    compressedBytesRead: 250,
    decodedBytes: 999,
    sourceReadableEnded: false,
    sinkWritableFinished: false,
    sinkClosed: false,
    sinkBytesWritten: 1_073_741_824,
    sinkWritableLength: 1_073_741_824,
  });

  const sourceText = await readFile(new URL('../src/update-package.mjs', import.meta.url), 'utf8');
  const smoke = await readFile(new URL('../scripts/updater-release-smoke.mjs', import.meta.url), 'utf8');
  assert.ok(sourceText.includes("platform === 'win32' && extraction.trackDiagnostics && !isAppAsar"));
  assert.ok(sourceText.includes('trackZipWriteCallback(writeStream)'));
  assert.ok(sourceText.includes('writeCallbackSnapshot?.()'));
  assert.ok(sourceText.includes("typeof zip.reader?.createReadStream !== 'function'"));
  assert.ok(smoke.includes('streamIntervalMs'));
  assert.ok(smoke.includes('previousStreamSnapshot: previousStreamSnapshot.snapshot'));
  assert.ok(sourceText.includes('extraction.streamSnapshot = null;'));
  assert.ok(sourceText.includes("if (smokeBoundary) smokeBoundary.extractStreamSnapshot = typeof value === 'function' ? value : null;"));
});

test('incompatible package verifier IPC is forwarded only to the packaged smoke process', async () => {
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  assert.ok(main.includes("additionalArguments:updaterSmokeBoundary?['--tus-smoke-provenance-diagnostic']:[]"), 'the packaged smoke flag reaches the sandboxed preload');
  const load = argv => {
    let exposedName, exposedApi;
    const calls = [];
    runInNewContext(preload, {
      process: { platform: 'linux', argv },
      require: id => {
        assert.equal(id, 'electron');
        return {
          contextBridge: { exposeInMainWorld: (name, api) => { exposedName = name; exposedApi = api; } },
          ipcRenderer: {
            invoke: (...args) => { calls.push(args); return Promise.resolve('verified'); },
            on() {}, removeListener() {},
          },
        };
      },
    });
    return { exposedName, exposedApi, calls };
  };
  const regular = load([]);
  assert.equal(regular.exposedName, 'tus');
  assert.equal('smokeVerifyIncompatiblePackage' in regular.exposedApi, false);

  const smoke = load(['--tus-smoke-provenance-diagnostic']);
  assert.equal(typeof smoke.exposedApi.smokeVerifyIncompatiblePackage, 'function');
  assert.equal(await smoke.exposedApi.smokeVerifyIncompatiblePackage(), 'verified');
  assert.equal(smoke.calls.length, 1);
  assert.equal(smoke.calls[0][0], 'updates:smoke-verify-incompatible-package');
});


test('Windows ZIP comparison labels its own timeout stage before awaiting the bounded call', async () => {
  const smoke = await readFile(new URL('../scripts/updater-release-smoke.mjs', import.meta.url), 'utf8');
  const stage = smoke.indexOf("setDiagnostic('zip-batcher-comparison')");
  const comparison = smoke.indexOf('const rawComparison = await withTimeout(current.instance.evaluate');

  assert.ok(stage >= 0 && comparison > stage, 'the timeout stage is recorded before the comparison can time out');
});


test('installed-source launch observes complete rehash before keyboard approval', async () => {
  const smoke = await readFile(new URL('../scripts/updater-release-smoke.mjs', import.meta.url), 'utf8');
  const start = smoke.indexOf('async function respondToUpdateLaunch(');
  const end = smoke.indexOf('\nasync function assertInstalledSourceIdentity', start);
  const launch = smoke.slice(start, end);

  assert.ok(start >= 0 && end > start, 'the installed-source launch observer is present');
  assert.ok(launch.includes('waitForFile(dialogMarker, 30_000)'), 'the prompt observer allows a bounded full-file rehash');

  const beforeKeyboard = launch.indexOf('await current.page.keyboard.press(key)');
  assert.ok(beforeKeyboard >= 0, 'keyboard approval remains explicit');
  for (const assertion of [
    'assert.ok(diagnostic.launchBoundary,',
    "assert.equal(diagnostic.launchBoundary?.status, 'starting',",
    "assert.equal(diagnostic.launchBoundary?.launchPhase, 'dialog',",
    "assert.equal(diagnostic.launchBoundary?.launchSubstage, 'verified',",
    "assert.equal(diagnostic.launchBoundary?.launchReadPhase, 'verified',",
    'assert.equal(diagnostic.launchBoundary?.launchReadBytes, manifestFile.size,',
    "assert.equal(diagnostic.launchBoundary?.launchDialog, 'marker-written',",
    "assert.equal(diagnostic.launchBoundary?.launchDecision, 'not-started',",
  ]) {
    const index = launch.indexOf(assertion);
    assert.ok(index >= 0 && index < beforeKeyboard, assertion + ' is required before keyboard approval');
  }
  assert.ok(launch.indexOf("assert.equal(diagnostic.prompt, 'invoked'") < beforeKeyboard);
});
