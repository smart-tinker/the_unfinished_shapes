import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import * as updatePackage from '../src/update-package.mjs';
import { assertPortableExtractVerified, safeMainDiagnostics, safeZipBatcherComparison, updaterZipStreamSampleOffsetsMs } from '../scripts/updater-smoke-diagnostics.mjs';

test('TUS Windows ZIP writer reports bounded finish-to-close time at the safe log boundary', async () => {
  const sink = new EventEmitter();
  sink._write = (_chunk, _encoding, callback) => callback();
  const readSnapshot = updatePackage.trackZipWriteCallback(sink);
  sink.emit('finish');
  await new Promise(resolve => setTimeout(resolve, 20));
  const pending = readSnapshot();
  assert.ok(pending.writeFinishToCloseMs >= 10);

  const manifestFile = { sha256: 'a'.repeat(64) };
  const safeSnapshot = (closed, writerSnapshot) => {
    const raw = updatePackage.safeZipExtractionStreamSnapshot(
      { readableEnded: true, actualByteCount: 1 },
      { writableFinished: true, closed, bytesWritten: 1, writableLength: 0 },
      10,
      { compressionMethod: 8, compressedSize: 1, uncompressedSize: 1 },
      null,
      writerSnapshot,
    );
    const [diagnostic] = safeMainDiagnostics([{
      stage: 'extract-archive',
      status: 'starting',
      extractStreamSnapshot: { ...raw, privatePath: 'C:/private/path' },
    }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
    return diagnostic.streamSnapshot;
  };
  const pendingSafe = safeSnapshot(false, pending);
  assert.equal(pendingSafe.writeFinishToCloseMs, pending.writeFinishToCloseMs);

  sink.emit('close');
  const closed = readSnapshot();
  assert.ok(closed.writeFinishToCloseMs >= pending.writeFinishToCloseMs);
  const closedSafe = safeSnapshot(true, closed);
  assert.equal(closedSafe.writeFinishToCloseMs, closed.writeFinishToCloseMs);

  const [bounded] = safeMainDiagnostics([{
    stage: 'extract-archive',
    status: 'starting',
    extractStreamSnapshot: {
      ...updatePackage.safeZipExtractionStreamSnapshot(
        { readableEnded: true, actualByteCount: 1 },
        { writableFinished: true, closed: true, bytesWritten: 1, writableLength: 0 },
        10,
        { compressionMethod: 8, compressedSize: 1, uncompressedSize: 1 },
        null,
        { state: 'idle', writeFinishToCloseMs: Number.MAX_SAFE_INTEGER },
      ),
      privatePath: 'C:/private/path',
    },
  }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
  assert.equal(bounded.streamSnapshot.writeFinishToCloseMs, 120_000);
  assert.equal(JSON.stringify([pendingSafe, closedSafe, bounded]).includes('C:/private/path'), false);
});

test('TUS Windows ZIP samples report capped main-process CPU deltas at the safe log boundary', async () => {
  const sink = new EventEmitter();
  sink._write = (_chunk, _encoding, callback) => callback();
  const readSample = updatePackage.trackZipWriteCallback(sink);
  readSample();
  await new Promise(resolve => setTimeout(resolve, 20));
  const sample = readSample();

  for (const field of ['mainCpuUserMsDelta', 'mainCpuSystemMsDelta']) {
    assert.ok(Number.isSafeInteger(sample[field]) && sample[field] >= 0 && sample[field] <= 120_000);
  }

  const manifestFile = { sha256: 'a'.repeat(64) };
  const raw = updatePackage.safeZipExtractionStreamSnapshot(
    { readableEnded: false, actualByteCount: 1 },
    { writableFinished: false, closed: false, bytesWritten: 1, writableLength: 0 },
    12,
    { compressionMethod: 8, compressedSize: 4, uncompressedSize: 8 },
    null,
    sample,
  );
  const [diagnostic] = safeMainDiagnostics([{
    stage: 'extract-archive',
    status: 'starting',
    extractStreamSnapshot: { ...raw, privatePath: 'C:/private/path', privateError: 'raw error' },
  }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
  assert.equal(diagnostic.streamSnapshot.mainCpuUserMsDelta, sample.mainCpuUserMsDelta);
  assert.equal(diagnostic.streamSnapshot.mainCpuSystemMsDelta, sample.mainCpuSystemMsDelta);

  const [bounded] = safeMainDiagnostics([{
    stage: 'extract-archive',
    status: 'starting',
    extractStreamSnapshot: {
      ...raw,
      mainCpuUserMsDelta: Number.MAX_SAFE_INTEGER,
      mainCpuSystemMsDelta: 'C:/private/path',
    },
  }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
  assert.equal(bounded.streamSnapshot.mainCpuUserMsDelta, 120_000);
  assert.equal(bounded.streamSnapshot.mainCpuSystemMsDelta, null);
  assert.doesNotMatch(JSON.stringify([diagnostic, bounded]), /C:\/private\/path|raw error/);
});

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
test('TUS release fetch diagnostics retain bounded quota evidence by phase and page', () => {
  const records = safeMainDiagnostics([
    {
      stage: 'release-fetch', phase: 'startup', page: 1, count: 1,
      status: 429, remainingZero: false, safeFailure: 'rate_limited',
      requestUrl: 'https://api.github.com/private-query-token',
      responseHeaders: { authorization: 'PRIVATE_HEADER' }, responseBody: 'private response body',
    },
    {
      stage: 'release-fetch', phase: 'manual', page: 1, count: 1,
      status: 403, remainingZero: true, safeFailure: 'rate_limited',
    },
    {
      stage: 'release-fetch', phase: 'manual', page: 2, count: 2,
      status: 200, remainingZero: false, safeFailure: 'none',
    },
    {
      stage: 'release-fetch', phase: 'manual', page: 3, count: 3,
      status: null, remainingZero: null, safeFailure: 'timeout',
    },
    {
      stage: 'release-fetch', phase: 'private phase', page: 11, count: 41,
      status: 999, remainingZero: '0', safeFailure: 'C:/private/error',
    },
  ], { sha256: 'a'.repeat(64) }, 'candidate.zip', 'v0.1.0-rc11');

  assert.deepEqual(records.map(({ stage, phase, page, count, status, remainingZero, safeFailure }) => [
    stage, phase, page, count, status, remainingZero, safeFailure,
  ]), [
    ['release-fetch', 'startup', 1, 1, 429, false, 'rate_limited'],
    ['release-fetch', 'manual', 1, 1, 403, true, 'rate_limited'],
    ['release-fetch', 'manual', 2, 2, 200, false, 'none'],
    ['release-fetch', 'manual', 3, 3, null, null, 'timeout'],
    ['release-fetch', 'unknown', null, null, null, null, 'unknown'],
  ]);
});

test('TUS release fetch diagnostics never retain request details or response data', () => {
  const [diagnostic] = safeMainDiagnostics([{
    stage: 'release-fetch',
    phase: 'manual',
    page: 1,
    count: 1,
    status: 403,
    remainingZero: true,
    safeFailure: 'rate_limited',
    requestUrl: 'https://api.github.com/private-query-token',
    responseHeaders: { authorization: 'Bearer private-test-token' },
    responseBody: 'private response body',
    rawError: 'C:/private/path',
  }], { sha256: 'a'.repeat(64) }, 'candidate.zip', 'v0.1.0-rc11');

  const serialized = JSON.stringify(diagnostic);
  for (const forbidden of ['private-query-token', 'private-test-token', 'private response body', 'C:/private/path']) {
    assert.equal(serialized.includes(forbidden), false, 'raw request or response data is omitted');
  }
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


test('TUS ZIP entry timing separates pre-pipeline setup from pipeline and keeps only bounded values', () => {
  const raw = updatePackage.safeZipExtractionStreamSnapshot(
    null, null, 12,
    { compressionMethod: 8, compressedSize: 10, uncompressedSize: 20 },
    null, null,
    {
      stage: 'pipeline', prePipelineMs: 31, pipelineMs: 47,
      sourcePath: 'C:/private/archive.zip', entryName: 'private-entry',
    },
  );
  const [diagnostic] = safeMainDiagnostics([{
    stage: 'extract-archive', status: 'starting', extractStreamSnapshot: raw,
  }], { sha256: 'a'.repeat(64) }, 'candidate.zip', 'v0.1.0-rc11');
  assert.deepEqual({
    stage: diagnostic.streamSnapshot.streamTimingStage,
    prePipelineMs: diagnostic.streamSnapshot.prePipelineMs,
    pipelineMs: diagnostic.streamSnapshot.pipelineMs,
  }, { stage: 'pipeline', prePipelineMs: 31, pipelineMs: 47 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /C:\/private\/archive\.zip|private-entry/);

  const [bounded] = safeMainDiagnostics([{
    stage: 'extract-archive', status: 'starting',
    extractStreamSnapshot: {
      ...raw, streamTimingStage: 'private-stage',
      prePipelineMs: 120_001, pipelineMs: -1, privateField: 'C:/private/path',
    },
  }], { sha256: 'a'.repeat(64) }, 'candidate.zip', 'v0.1.0-rc11');
  assert.deepEqual({
    stage: bounded.streamSnapshot.streamTimingStage,
    prePipelineMs: bounded.streamSnapshot.prePipelineMs,
    pipelineMs: bounded.streamSnapshot.pipelineMs,
  }, { stage: 'unknown', prePipelineMs: 120_000, pipelineMs: null });
  assert.doesNotMatch(JSON.stringify(bounded), /private-stage|privateField|C:\/private\/path/);
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
    sinkBytesWritten: 900, sinkWritableLength: 100, byteProgress: 'baseline',
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


test('TUS Windows ZIP sink totals completed write callback time at the safe log boundary', async () => {
  const trackWriteCallback = updatePackage.trackZipWriteCallback;
  assert.equal(typeof trackWriteCallback, 'function', 'the packaged extraction sink exposes callback timing');

  const manifestFile = { sha256: 'a'.repeat(64) };
  const exercise = async expectedState => {
    let finishWrite;
    let remainingWrites = expectedState === 'write' ? 1 : 2;
    let resolveWrites;
    let rejectWrites;
    const writesDone = new Promise((resolve, reject) => {
      resolveWrites = resolve;
      rejectWrites = reject;
    });
    const onWritten = error => {
      if (error) {
        rejectWrites(error);
        return;
      }
      remainingWrites--;
      if (remainingWrites === 0) resolveWrites();
    };
    const options = {
      write(_chunk, _encoding, callback) {
        if (expectedState === 'write') finishWrite = callback;
        else callback();
      },
    };
    if (expectedState === 'writev') options.writev = (_chunks, callback) => { finishWrite = callback; };
    const sink = new Writable(options);
    const readWriteCallback = trackWriteCallback(sink);
    if (expectedState === 'write') sink.write(Buffer.from('payload'), onWritten);
    else {
      sink.cork();
      sink.write(Buffer.from('first'), onWritten);
      sink.write(Buffer.from('second'), onWritten);
      sink.uncork();
    }

    await new Promise(resolve => setImmediate(resolve));
    const pending = readWriteCallback();
    assert.equal(pending.state, expectedState);
    assert.equal(pending.writeCallCount, expectedState === 'write' ? 1 : 0);
    assert.equal(pending.writevCallCount, expectedState === 'writev' ? 1 : 0);
    assert.equal(pending.writeCallbackCount, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(typeof finishWrite, 'function');
    finishWrite();
    await writesDone;

    const completed = readWriteCallback();
    assert.equal(completed.state, 'idle');
    assert.equal(completed.writeCallbackCount, 1);
    assert.ok(completed.writeCallbackWaitMs >= 10);
    const raw = updatePackage.safeZipExtractionStreamSnapshot(
      { readableEnded: false, actualByteCount: 7 },
      { writableFinished: false, closed: false, bytesWritten: 7, writableLength: 0 },
      12,
      { compressionMethod: 8, compressedSize: 3, uncompressedSize: 7 },
      null,
      completed,
    );
    const [first] = safeMainDiagnostics([{
      stage: 'extract-archive',
      status: 'starting',
      extractStreamSnapshot: { ...raw, privatePath: 'C:/private/path', privateError: 'raw error' },
    }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
    assert.equal(first.streamSnapshot.writeCallbackState, 'idle');
    assert.equal(first.streamSnapshot.writeCallbackWaitMs, completed.writeCallbackWaitMs);
    assert.equal(first.streamSnapshot.writeCallbackWaitMsDelta, null);
    assert.equal(first.streamSnapshot.writeCallbackCount, 1);
    assert.equal(first.streamSnapshot.writeCallCount, expectedState === 'write' ? 1 : 0);
    assert.equal(first.streamSnapshot.writevCallCount, expectedState === 'writev' ? 1 : 0);

    const [second] = safeMainDiagnostics([{
      stage: 'extract-archive',
      status: 'starting',
      previousStreamSnapshot: first.streamSnapshot,
      streamIntervalMs: 1000,
      extractStreamSnapshot: {
        ...raw,
        writeCallbackCount: 2,
        writeCallCount: completed.writeCallCount + (expectedState === 'write' ? 1 : 0),
        writevCallCount: completed.writevCallCount + (expectedState === 'writev' ? 1 : 0),
        writeCallbackWaitMs: completed.writeCallbackWaitMs + 7,
        privatePath: 'C:/private/path',
        privateError: 'raw error',
      },
    }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
    assert.equal(second.streamSnapshot.writeCallbackWaitMsDelta, 7);
    assert.equal(second.streamSnapshot.writeCallbackCountDelta, 1);
    assert.equal(second.streamSnapshot.writeCallCountDelta, expectedState === 'write' ? 1 : 0);
    assert.equal(second.streamSnapshot.writevCallCountDelta, expectedState === 'writev' ? 1 : 0);
    const [unsafe] = safeMainDiagnostics([{
      stage: 'extract-archive',
      status: 'starting',
      extractStreamSnapshot: {
        ...raw,
        writeCallbackState: 'C:/private/path',
        writeCallbackAgeMs: -1,
        writeCallbackWaitMs: 'private',
        writeCallbackCount: Number.MAX_SAFE_INTEGER,
        writeCallCount: 'private',
        writevCallCount: -1,
      },
    }], manifestFile, 'candidate.zip', 'v0.1.0-rc11');
    assert.equal(unsafe.streamSnapshot.writeCallbackState, 'unknown');
    assert.equal(unsafe.streamSnapshot.writeCallbackAgeMs, null);
    assert.equal(unsafe.streamSnapshot.writeCallbackWaitMs, null);
    assert.equal(unsafe.streamSnapshot.writeCallbackCount, 0xffffffff);
    assert.equal(unsafe.streamSnapshot.writeCallCount, null);
    assert.equal(unsafe.streamSnapshot.writevCallCount, null);
    assert.equal(JSON.stringify([first, second, unsafe]).includes('C:/private/path'), false);
    assert.equal(JSON.stringify([first, second, unsafe]).includes('raw error'), false);
    assert.equal(JSON.stringify([first, second, unsafe]).includes('private'), false);
    await new Promise(resolve => sink.end(resolve));
  };

  await exercise('write');
  await exercise('writev');
});


test('Windows ZIP comparison scratch prefix stays under the verified archive directory', async () => {
  const diagnostics = await import('../scripts/updater-smoke-diagnostics.mjs');
  const testRoot = path.join(tmpdir(), 'tus-update-e2e-scratch-test');
  const archivePath = path.join(testRoot, 'downloads', 'candidate.zip');

  const scratchPrefix = diagnostics.zipBatcherScratchPrefix?.(archivePath);
  assert.equal(scratchPrefix, path.join(path.dirname(archivePath), 'tus-zip-batcher-'));
  assert.equal(path.relative(testRoot, scratchPrefix).split(path.sep)[0], 'downloads');
});

test('TUS launch boundary preserves only allowlisted renderer and main phases', () => {
  const manifestFile = { sha256: 'a'.repeat(64) };
  const assetName = 'candidate.exe';
  const tag = 'v0.1.0-rc11';
  const [rehash, dialog, response, unsafe] = safeMainDiagnostics([
    { stage: 'update-launch', status: 'starting', launchPhase: 'rehash', launchDialog: 'not-started', launchDecision: 'not-started', rendererClickStatus: 'received', rendererInvokeStatus: 'pending' },
    { stage: 'update-launch', status: 'starting', launchPhase: 'dialog', launchDialog: 'marker-written', launchDecision: 'not-started', rendererClickStatus: 'received', rendererInvokeStatus: 'pending' },
    { stage: 'update-launch', status: 'fulfilled', launchPhase: 'response', launchDialog: 'marker-written', launchDecision: 'cancelled', rendererClickStatus: 'received', rendererInvokeStatus: 'fulfilled' },
    { stage: 'update-launch', status: 'private/path', launchPhase: 'C:/private/path', launchDialog: 'raw error', launchDecision: 'private caption', rendererClickStatus: 'raw click', rendererInvokeStatus: 'C:/private/path', privateDetails: 'raw exception' },
  ], manifestFile, assetName, tag);

  assert.deepEqual(
    [rehash.stage, rehash.status, rehash.launchPhase, rehash.launchDialog, rehash.launchDecision, rehash.rendererClickStatus, rehash.rendererInvokeStatus],
    ['update-launch', 'starting', 'rehash', 'not-started', 'not-started', 'received', 'pending'],
  );
  assert.deepEqual(
    [dialog.launchPhase, dialog.launchDialog, dialog.rendererInvokeStatus],
    ['dialog', 'marker-written', 'pending'],
  );
  assert.deepEqual(
    [response.status, response.launchPhase, response.launchDecision, response.rendererInvokeStatus],
    ['fulfilled', 'response', 'cancelled', 'fulfilled'],
  );
  assert.deepEqual(
    [unsafe.stage, unsafe.status, unsafe.launchPhase, unsafe.launchDialog, unsafe.launchDecision, unsafe.rendererClickStatus, unsafe.rendererInvokeStatus],
    ['update-launch', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
  );
  assert.equal(JSON.stringify([rehash, dialog, response, unsafe]).includes('C:/private/path'), false);
  assert.equal(JSON.stringify([rehash, dialog, response, unsafe]).includes('raw exception'), false);
  assert.equal(JSON.stringify([rehash, dialog, response, unsafe]).includes('private caption'), false);
});

test('TUS launch substage keeps only fixed module and rehash states', () => {
  const diagnostics = safeMainDiagnostics([
    { stage: 'update-launch', status: 'starting', launchSubstage: 'module-import' },
    { stage: 'update-launch', status: 'starting', launchSubstage: 'file-rehash' },
    { stage: 'update-launch', status: 'starting', launchSubstage: 'C:/private/path' },
  ], { sha256: 'a'.repeat(64) }, 'candidate.exe', 'v0.1.0-rc11');

  assert.deepEqual(diagnostics.map(item => item.launchSubstage), [
    'module-import', 'file-rehash', 'unknown',
  ]);
  assert.equal(JSON.stringify(diagnostics).includes('C:/private/path'), false);
});


test('TUS launch snapshot keeps bounded file rehash read state', () => {
  const diagnostics = safeMainDiagnostics([
    { stage: 'update-launch', status: 'starting', launchReadPhase: 'waiting-before-read', launchReadBytes: 0 },
    { stage: 'update-launch', status: 'starting', launchReadPhase: 'reading', launchReadBytes: 65_536 },
    { stage: 'update-launch', status: 'fulfilled', launchReadPhase: 'verified', launchReadBytes: 170_307_116 },
    { stage: 'update-launch', status: 'starting', launchReadPhase: 'C:/private/path', launchReadBytes: 'C:/private/path' },
    { stage: 'update-launch', status: 'starting', launchReadPhase: 'reading', launchReadBytes: Number.MAX_SAFE_INTEGER },
  ], { sha256: 'a'.repeat(64) }, 'candidate.exe', 'v0.1.0-rc11');

  assert.deepEqual(diagnostics.map(item => [item.launchReadPhase, item.launchReadBytes]), [
    ['waiting-before-read', 0],
    ['reading', 65_536],
    ['verified', 170_307_116],
    ['unknown', null],
    ['reading', 0xffff_ffff],
  ]);
  assert.equal(JSON.stringify(diagnostics).includes('C:/private/path'), false);
});

test('TUS verified ZIP comparison keeps counterbalanced memory Deflate sink arms safe', () => {
  const sinkArm = (trial, arm, sink, decodedBytes, sinkBytesProcessed) => ({
    trial, arm, sink, outcome: 'time-limit', batchBytes: 262_144,
    wallMs: 15_000, cpuUserMs: 30, cpuSystemMs: 20,
    compressedBytesRead: null, decodedBytes, sinkBytesProcessed,
    sinkWritableLength: 16_384, sinkNeedDrain: true, writeCallbackWaitMs: 900,
    sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: true,
    cleanupStatus: sink === 'node-fs-file' ? 'removed' : 'not-created',
    sourcePath: 'C:/private/archive.zip', entryName: 'private-entry',
    error: 'private read error',
  });
  const comparison = safeZipBatcherComparison({
    assetMatches: true, memorySourceVerified: true,
    entrySequence: 12, compression: 'deflate', entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448, entryNonAsar: true, entryMatches: true,
    batchBytes: 262_144, readHighWaterMarkBytes: 262_144, writeHighWaterMarkBytes: 16_384,
    arms: [
      sinkArm(1, 'memory-file', 'node-fs-file', 20_000, 19_000),
      sinkArm(1, 'memory-discard', 'count-discard', 20_000, 20_000),
      sinkArm(2, 'memory-discard', 'count-discard', 24_000, 24_000),
      sinkArm(2, 'memory-file', 'node-fs-file', 24_000, 24_000),
    ],
  });
  const [invalid] = safeZipBatcherComparison({
    arms: [{
      trial: 1, arm: 'C:/private/invalid-arm', sink: 'C:/private/sink',
      batchBytes: 262_144, wallMs: 60_001, cpuUserMs: Number.MAX_SAFE_INTEGER,
      cpuSystemMs: 'private', decodedBytes: 1_073_741_825,
      sinkBytesProcessed: 1_073_741_825, sinkWritableLength: Number.MAX_SAFE_INTEGER,
      sinkNeedDrain: 'private', writeCallbackWaitMs: 120_001,
      cleanupStatus: 'private', sourcePath: 'C:/private/archive/entry.bin', error: 'private error',
    }],
  }).arms;
  const serialized = JSON.stringify([comparison, invalid]);
  for (const privateValue of [
    'C:/private/archive.zip', 'C:/private/archive/entry.bin', 'C:/private/invalid-arm',
    'C:/private/sink', 'private-entry', 'private read error', 'private error',
  ]) assert.equal(serialized.includes(privateValue), false);
  assert.deepEqual([invalid.arm, invalid.sink, invalid.batchBytes, invalid.wallMs, invalid.cpuUserMs,
    invalid.cpuSystemMs, invalid.decodedBytes, invalid.sinkBytesProcessed, invalid.sinkWritableLength,
    invalid.sinkNeedDrain, invalid.writeCallbackWaitMs, invalid.cleanupStatus, invalid.countersMatch], [
    'unknown', 'unknown', null, null, null, null, null, null, null, null, null, 'unknown', null,
  ]);
  assert.equal(comparison.entryMatches, true);
  assert.equal(comparison.memorySourceVerified, true);
  assert.equal(comparison.measurementScope, 'verified-memory-deflate-file-vs-discard');
  assert.equal(comparison.cacheCaveat, 'verified-buffer; filesystem-write-cache-not-reset');
  assert.deepEqual(comparison.arms.map(({ trial, arm, batchBytes, sink, compressedBytesRead, decodedBytes, sinkBytesProcessed, sinkWritableLength, sinkNeedDrain, writeCallbackWaitMs, cleanupStatus }) =>
    ({ trial, arm, batchBytes, sink, compressedBytesRead, decodedBytes, sinkBytesProcessed, sinkWritableLength, sinkNeedDrain, writeCallbackWaitMs, cleanupStatus })), [
    { trial: 1, arm: 'memory-file', batchBytes: 262_144, sink: 'node-fs-file', compressedBytesRead: null, decodedBytes: 20_000, sinkBytesProcessed: 19_000, sinkWritableLength: 16_384, sinkNeedDrain: true, writeCallbackWaitMs: 900, cleanupStatus: 'removed' },
    { trial: 1, arm: 'memory-discard', batchBytes: 262_144, sink: 'count-discard', compressedBytesRead: null, decodedBytes: 20_000, sinkBytesProcessed: 20_000, sinkWritableLength: 16_384, sinkNeedDrain: true, writeCallbackWaitMs: 900, cleanupStatus: 'not-created' },
    { trial: 2, arm: 'memory-discard', batchBytes: 262_144, sink: 'count-discard', compressedBytesRead: null, decodedBytes: 24_000, sinkBytesProcessed: 24_000, sinkWritableLength: 16_384, sinkNeedDrain: true, writeCallbackWaitMs: 900, cleanupStatus: 'not-created' },
    { trial: 2, arm: 'memory-file', batchBytes: 262_144, sink: 'node-fs-file', compressedBytesRead: null, decodedBytes: 24_000, sinkBytesProcessed: 24_000, sinkWritableLength: 16_384, sinkNeedDrain: true, writeCallbackWaitMs: 900, cleanupStatus: 'removed' },
  ]);
});


test('portable smoke launches only after the ordinary Extract path is verified', async () => {
  const events = [];
  const run = async outcome => {
    await assertPortableExtractVerified(async () => {
      events.push('extract');
      return outcome;
    });
    events.push('launch');
  };

  await assert.rejects(run('pending'), { name: 'AssertionError', actual: 'pending', expected: 'verified' });
  assert.deepEqual(events, ['extract']);

  events.length = 0;
  await run('verified');
  assert.deepEqual(events, ['extract', 'launch']);
});
