import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import * as updatePackage from '../src/update-package.mjs';
import { safeMainDiagnostics, updaterZipStreamSampleOffsetsMs } from '../scripts/updater-smoke-diagnostics.mjs';

test('TUS main diagnostic preserves only safe verifier setup stages at the log boundary', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const base = {
    bundleIndex: 0,
    bundleSha256: 'b'.repeat(64),
    assetName,
    assetSha256: manifestFile.sha256,
    tag,
    status: 'rejected',
  };
  const diagnostics = safeMainDiagnostics([
    { ...base, stage: 'verifier-setup', verifierSetupStage: 'tuf-get-trusted-root', verifierSetupStep: 'tuf-target-metadata-search' },
    { ...base, stage: 'verifier-setup', verifierSetupStage: 'private/path/token', verifierSetupStep: 'private/path/token' },
    { ...base, stage: 'verifier-verify', verifierSetupStage: 'trust-material' },
  ], manifestFile, assetName, tag);

  assert.equal(diagnostics[0].verifierSetupStage, 'tuf-get-trusted-root');
  assert.equal(diagnostics[0].verifierSetupStep, 'tuf-target-metadata-search');
  assert.equal(diagnostics[1].verifierSetupStage, 'unknown');
  assert.equal(diagnostics[1].verifierSetupStep, 'unknown');
  assert.equal(Object.hasOwn(diagnostics[2], 'verifierSetupStage'), false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private\/path\/token/);
});

test('TUS main diagnostic preserves a bounded tampered-bundle verifier result', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const base = {
    bundleIndex: 0,
    bundleSha256: 'b'.repeat(64),
    assetName,
    assetSha256: manifestFile.sha256,
    tag,
    privateDetails: 'raw verifier exception',
  };
  const [control] = safeMainDiagnostics([{
    ...base,
    stage: 'verifier-tampered-control',
    status: 'tampered-rejected',
  }], manifestFile, assetName, tag);

  assert.equal(control.stage, 'verifier-tampered-control');
  assert.equal(control.status, 'tampered-rejected');
  assert.equal(control.assetMatches, true);
  assert.doesNotMatch(JSON.stringify(control), /raw verifier exception/);
});
test('TUS runtime boundary preserves only fixed import and renderer-invoke outcomes', () => {
  const manifestFile = { sha256: 'a'.repeat(64) };
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const diagnostics = safeMainDiagnostics([
    { stage: 'updater-module-import', status: 'pending' },
    { stage: 'updater-module-import', status: 'fulfilled' },
    { stage: 'updater-module-import', status: 'rejected', moduleFailureCode: 'MODULE_IMPORT_REJECTED', privateDetails: 'C:/private/path' },
    { stage: 'updater-module-import', status: 'rejected', moduleFailureCode: 'ERR_MODULE_NOT_FOUND', moduleFailureName: '@sigstore/tuf', privateDetails: 'private module path' },
    { stage: 'updater-module-import', status: 'rejected', moduleFailureCode: 'SyntaxError', moduleFailureName: 'file:///C:/private/app.asar/secrets/private.mjs', privateDetails: 'private syntax detail' },
    { stage: 'download-verified-asset', status: 'pending' },
    { stage: 'renderer-invoke', status: 'rejected', privateDetails: 'raw IPC exception' },
    { stage: 'private/path', status: 'private/path', moduleFailureCode: 'PRIVATE_CODE' },
  ], manifestFile, assetName, tag);

  assert.deepEqual(diagnostics.map(({ stage, status }) => [stage, status]), [
    ['updater-module-import', 'pending'],
    ['updater-module-import', 'fulfilled'],
    ['updater-module-import', 'rejected'],
    ['updater-module-import', 'rejected'],
    ['updater-module-import', 'rejected'],
    ['download-verified-asset', 'pending'],
    ['renderer-invoke', 'rejected'],
    ['unknown', 'unknown'],
  ]);
  assert.equal(diagnostics[2].moduleFailureCode, 'MODULE_IMPORT_REJECTED');
  assert.equal(diagnostics[3].moduleFailureCode, 'ERR_MODULE_NOT_FOUND');
  assert.equal(diagnostics[3].moduleFailureName, '@sigstore/tuf');
  assert.equal(diagnostics[4].moduleFailureCode, 'SyntaxError');
  assert.equal(diagnostics[4].moduleFailureName, 'unknown');
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes('C:/private/path'), false);
  assert.equal(serialized.includes('raw IPC exception'), false);
  assert.equal(serialized.includes('PRIVATE_CODE'), false);
});

test('TUS extraction diagnostic carries only allowlisted stage and operation', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const [entry, privateStage, filesystemFailure] = safeMainDiagnostics([
    { stage: 'extract-failed', status: 'rejected', failureCode: 'TAR_ENTRY_ERROR', extractStage: 'entry', extractOperation: 'asar-open-invalid-package', privateDetails: 'raw parser message' },
    { stage: 'extract-failed', status: 'rejected', failureCode: 'C:/private/path', extractStage: 'C:/private/path', extractOperation: 'C:/private/app.asar', privateDetails: 'raw parser message' },
    { stage: 'extract-failed', status: 'rejected', failureCode: 'FILESYSTEM_NOT_FOUND', extractStage: 'write' },
  ], manifestFile, assetName, tag);

  assert.equal(entry.stage, 'extract-failed');
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.extractStage, 'entry');
  assert.equal(entry.extractOperation, 'asar-open-invalid-package');
  assert.equal(entry.failureCode, 'TAR_ENTRY_ERROR');
  assert.equal(privateStage.stage, 'extract-failed');
  assert.equal(privateStage.extractStage, 'unknown');
  assert.equal(privateStage.extractOperation, 'unknown');
  assert.equal(privateStage.failureCode, 'OTHER');
  assert.equal(filesystemFailure.failureCode, 'FILESYSTEM_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify([entry, privateStage, filesystemFailure]), /raw parser message|C:\/private\/path/);
});


test('TUS extraction boundary snapshot preserves only allowlisted states and file flags', () => {
  const manifestFile = { sha256: 'a'.repeat(64) };
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const [pending, unsafe, verified, cancelled] = safeMainDiagnostics([
    {
      stage: 'extract-archive',
      status: 'starting',
      rendererStatusText: 'Choose a destination folder…',
      rendererInvokeStatus: 'pending',
      failureCode: 'TAR_ENTRY_ERROR',
      extractStage: 'write',
      extractOperation: 'asar-open-invalid-package',
      extractModuleImport: 'fulfilled',
      extractCall: 'starting',
      visibilityState: 'visible',
      fileFlags: {
        targetExists: true, appAsarExists: false, appAsarFile: false,
        executableExists: false, stagedAsarExists: true,
      },
    },
    {
      stage: 'extract-archive',
      status: 'rejected',
      rendererStatusText: 'C:/private/path raw error',
      rendererInvokeStatus: 'private-status',
      failureCode: 'PRIVATE_CODE',
      extractStage: 'C:/private/path',
      extractOperation: 'C:/private/app.asar',
      visibilityState: 'C:/private/path',
      fileFlags: { targetExists: 1, appAsarExists: 'true', appAsarFile: true, executableExists: false, stagedAsarExists: null },
      extractModuleImport: 'C:/private/path',
      extractCall: 'C:/private/path',
      privateDetails: 'C:/private/path and raw parser text',
    },
    {
      stage: 'extract-archive',
      status: 'fulfilled',
      rendererStatusText: 'Verified archive extracted. You can now launch the new copy.',
      rendererInvokeStatus: 'fulfilled',
      visibilityState: 'hidden',
      fileFlags: { targetExists: true, appAsarExists: true, appAsarFile: true, executableExists: true, stagedAsarExists: false },
    },
    {
      stage: 'extract-archive',
      status: 'fulfilled',
      rendererStatusText: 'Folder selection cancelled.',
      rendererInvokeStatus: 'fulfilled',
      visibilityState: 'visible',
      fileFlags: {},
    },
  ], manifestFile, assetName, tag);

  assert.equal(pending.stage, 'extract-archive');
  assert.equal(pending.status, 'starting');
  assert.equal(pending.rendererStatus, 'pending');
  assert.equal(pending.rendererInvokeStatus, 'pending');
  assert.equal(pending.failureCode, 'TAR_ENTRY_ERROR');
  assert.equal(pending.extractStage, 'write');
  assert.equal(pending.extractOperation, 'asar-open-invalid-package');
  assert.equal(pending.extractModuleImport, 'fulfilled');
  assert.equal(pending.extractCall, 'starting');
  assert.equal(pending.visibilityState, 'visible');
  assert.deepEqual(pending.fileFlags, {
    targetExists: true, appAsarExists: false, appAsarFile: false,
    executableExists: false, stagedAsarExists: true,
  });

  assert.equal(unsafe.rendererStatus, 'other');
  assert.equal(unsafe.rendererInvokeStatus, 'unknown');
  assert.equal(unsafe.failureCode, 'OTHER');
  assert.equal(unsafe.extractStage, 'unknown');
  assert.equal(unsafe.extractOperation, 'unknown');
  assert.equal(unsafe.extractModuleImport, 'unknown');
  assert.equal(unsafe.extractCall, 'unknown');
  assert.equal(unsafe.visibilityState, 'unknown');
  assert.deepEqual(unsafe.fileFlags, {
    targetExists: false, appAsarExists: false, appAsarFile: true,
    executableExists: false, stagedAsarExists: false,
  });
  assert.equal(verified.rendererStatus, 'verified');
  assert.equal(verified.status, 'fulfilled');
  assert.equal(verified.rendererInvokeStatus, 'fulfilled');
  assert.equal(cancelled.rendererStatus, 'cancelled');
  const serialized = JSON.stringify([pending, unsafe, verified, cancelled]);
  assert.equal(serialized.includes('C:/private/path'), false);
  assert.equal(serialized.includes('raw parser text'), false);
  assert.equal(serialized.includes('PRIVATE_CODE'), false);
});

test('TUS extraction phase snapshot preserves only fixed live phases', () => {
  const phases = ['preflight', 'digest', 'zip-open', 'zip-read', 'write', 'executable', 'cleanup', 'fulfilled', 'rejected'];
  const manifestFile = { sha256: 'a'.repeat(64) };
  const diagnostics = safeMainDiagnostics([
    ...phases.map(extractPhase => ({ stage: 'extract-archive', status: 'starting', extractPhase })),
    { stage: 'extract-archive', status: 'starting', extractPhase: 'C:/private/path' },
  ], manifestFile, 'candidate.zip', 'v0.1.0-rc11');

  assert.deepEqual(diagnostics.map(item => item.extractPhase), [...phases, 'unknown']);
  assert.equal(JSON.stringify(diagnostics).includes('C:/private/path'), false);
});

test('TUS extraction snapshot preserves only fixed ZIP write substages and exact app.asar flag', () => {
  const substages = ['none', 'directory-mkdir', 'parent-mkdir', 'read-stream-open', 'pipeline'];
  const manifestFile = { sha256: 'a'.repeat(64) };
  const diagnostics = safeMainDiagnostics([
    ...substages.map((extractSubstage, index) => ({
      stage: 'extract-archive',
      status: 'starting',
      extractSubstage,
      extractAppAsarEntry: index === 3,
    })),
    {
      stage: 'extract-archive',
      status: 'starting',
      extractSubstage: 'C:/private/path',
      extractAppAsarEntry: 'true',
    },
  ], manifestFile, 'candidate.zip', 'v0.1.0-rc11');

  assert.deepEqual(diagnostics.map(item => item.extractSubstage), [...substages, 'unknown']);
  assert.deepEqual(diagnostics.map(item => item.extractAppAsarEntry), [false, false, false, true, false, false]);
  assert.equal(JSON.stringify(diagnostics).includes('C:/private/path'), false);
});


test('TUS extraction snapshots localize bounded read, decode and write throughput per ZIP entry', () => {
  const manifestFile = { sha256: 'a'.repeat(64) };
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const first = safeMainDiagnostics([{
    stage: 'extract-archive',
    status: 'starting',
    extractStreamSnapshot: {
      entrySequence: 12, compression: 'deflate',
      entryCompressedSize: 111_522_616, entryUncompressedSize: 249_832_448,
      compressedBytesRead: 100, decodedBytes: 1_000,
      sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false,
      sinkBytesWritten: 900, sinkWritableLength: 100,
      sourcePath: 'C:/private/archive.zip', entryName: 'private-entry',
    },
  }], manifestFile, assetName, tag)[0].streamSnapshot;

  assert.deepEqual(first, {
    entrySequence: 12, compression: 'deflate',
    entryCompressedSize: 111_522_616, entryUncompressedSize: 249_832_448,
    compressedBytesRead: 100, decodedBytes: 1_000,
    sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false,
    sinkBytesWritten: 900, sinkWritableLength: 100,
    writeCallbackState: 'unknown', writeCallbackAgeMs: null, byteProgress: 'baseline',
    intervalMs: null, compressedReadBytesPerSecond: null,
    decodedBytesPerSecond: null, writtenBytesPerSecond: null,
  });

  const second = safeMainDiagnostics([{
    stage: 'extract-archive',
    status: 'starting',
    previousStreamSnapshot: first,
    streamIntervalMs: 20_000,
    extractStreamSnapshot: {
      entrySequence: 12, compression: 'deflate',
      entryCompressedSize: 111_522_616, entryUncompressedSize: 249_832_448,
      compressedBytesRead: 500, decodedBytes: 5_000,
      sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false,
      sinkBytesWritten: 4_500, sinkWritableLength: 0,
    },
  }], manifestFile, assetName, tag)[0].streamSnapshot;

  assert.equal(second.intervalMs, 20_000);
  assert.equal(second.compressedReadBytesPerSecond, 20);
  assert.equal(second.decodedBytesPerSecond, 200);
  assert.equal(second.writtenBytesPerSecond, 180);
  assert.equal(second.byteProgress, 'advanced');

  const nextEntry = safeMainDiagnostics([{
    stage: 'extract-archive', status: 'starting',
    previousStreamSnapshot: second, streamIntervalMs: 20_000,
    extractStreamSnapshot: {
      entrySequence: 13, compression: 'stored',
      entryCompressedSize: 100, entryUncompressedSize: 100,
      compressedBytesRead: 50, decodedBytes: 50,
      sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false,
      sinkBytesWritten: 50, sinkWritableLength: 0,
    },
  }], manifestFile, assetName, tag)[0].streamSnapshot;
  assert.equal(nextEntry.byteProgress, 'baseline');
  assert.equal(nextEntry.intervalMs, null);
  assert.equal(nextEntry.compressedReadBytesPerSecond, null);

  const bounded = safeMainDiagnostics([{
    stage: 'extract-archive', status: 'starting',
    previousStreamSnapshot: second, streamIntervalMs: 120_001,
    extractStreamSnapshot: {
      entrySequence: 12, compression: 'private',
      entryCompressedSize: Number.MAX_SAFE_INTEGER, entryUncompressedSize: -1,
      compressedBytesRead: 'C:/private/path', decodedBytes: 'private',
      sinkBytesWritten: 900_000_000, sinkWritableLength: 0,
      sourcePath: 'C:/private/archive.zip',
    },
  }], manifestFile, assetName, tag)[0].streamSnapshot;
  assert.equal(bounded.compression, 'unknown');
  assert.equal(bounded.entryCompressedSize, 4_294_967_295);
  assert.equal(bounded.entryUncompressedSize, null);
  assert.equal(bounded.compressedBytesRead, null);
  assert.equal(bounded.decodedBytes, null);
  assert.equal(bounded.intervalMs, null);
  assert.equal(JSON.stringify([first, second, nextEntry, bounded]).includes('private'), false);
  assert.equal(JSON.stringify([first, second, nextEntry, bounded]).includes('C:/private'), false);
});


test('TUS ZIP stream sampler takes one late sample before the unchanged extraction deadline', () => {
  assert.ok(updaterZipStreamSampleOffsetsMs.at(-1) < 120_000);
  assert.deepEqual(updaterZipStreamSampleOffsetsMs, [
    15_000, 35_000, 55_000, 75_000, 95_000, 110_000,
  ]);
});

test('TUS live ZIP sink callback snapshot reports bounded pending writes without private data', async () => {
  const trackWriteCallback = updatePackage.trackZipWriteCallback;
  assert.equal(typeof trackWriteCallback, 'function', 'the ZIP extraction smoke snapshot tracks its sink callback');

  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const exercise = async expectedState => {
    let completeWrite;
    const options = {
      write(_chunk, _encoding, callback) {
        if (expectedState === 'write') completeWrite = callback;
        else callback();
      },
    };
    if (expectedState === 'writev') options.writev = (_chunks, callback) => { completeWrite = callback; };
    const sink = new Writable(options);
    const readWriteCallback = trackWriteCallback(sink);
    if (expectedState === 'write') sink.write(Buffer.from('fixture'));
    else {
      sink.cork();
      sink.write(Buffer.from('first'));
      sink.write(Buffer.from('second'));
      sink.uncork();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof completeWrite, 'function', 'the writable reached the selected callback');
    const snapshot = updatePackage.safeZipExtractionStreamSnapshot(
      { readableEnded: false, actualByteCount: 7 },
      sink,
      12,
      { compressionMethod: 8, compressedSize: 3, uncompressedSize: 7 },
      null,
      readWriteCallback(),
    );
    const [diagnostic] = safeMainDiagnostics([{
      stage: 'extract-archive',
      extractStreamSnapshot: snapshot,
    }], manifestFile, assetName, tag);
    assert.equal(diagnostic.streamSnapshot.writeCallbackState, expectedState);
    assert.ok(Number.isSafeInteger(diagnostic.streamSnapshot.writeCallbackAgeMs));
    assert.ok(diagnostic.streamSnapshot.writeCallbackAgeMs >= 0);
    assert.ok(diagnostic.streamSnapshot.writeCallbackAgeMs <= 120_000);
    completeWrite();
    await new Promise(resolve => sink.end(resolve));
    assert.deepEqual(readWriteCallback(), { state: 'idle', ageMs: null });
  };

  await exercise('write');
  await exercise('writev');
  assert.deepEqual(trackWriteCallback({})(), { state: 'unknown', ageMs: null });

  const [unsafe] = safeMainDiagnostics([{
    stage: 'extract-archive',
    extractStreamSnapshot: {
      entrySequence: 12,
      compression: 'deflate',
      entryCompressedSize: 3,
      entryUncompressedSize: 7,
      compressedBytesRead: 2,
      decodedBytes: 5,
      sourceReadableEnded: false,
      sinkWritableFinished: false,
      sinkClosed: false,
      sinkBytesWritten: 4,
      sinkWritableLength: 1,
      writeCallbackState: 'C:/private/path',
      writeCallbackAgeMs: 120_001,
      privateError: 'raw filesystem error',
    },
  }], manifestFile, assetName, tag);
  assert.equal(unsafe.streamSnapshot.writeCallbackState, 'unknown');
  assert.equal(unsafe.streamSnapshot.writeCallbackAgeMs, null);
  const serialized = JSON.stringify(unsafe);
  assert.equal(serialized.includes('C:/private/path'), false);
  assert.equal(serialized.includes('raw filesystem error'), false);
});
