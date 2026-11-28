import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { createZipWriteBatcher, openZipReadStream, safeArchiveExtractionOperation, safeArchiveExtractionStage, safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType, trackZipWriteCallback, zipReadChunkBytes, zipWriteBatchBytes } from '../src/update-package.mjs';
import { safeUpdaterModuleName } from '../src/update-release.mjs';

export const updaterZipStreamSampleOffsetsMs = Object.freeze([15_000, 35_000, 55_000, 75_000, 95_000, 110_000]);

export async function assertPortableExtractVerified(runExtract) {
  assert.equal(await runExtract(), 'verified', 'the selected verified archive reaches a terminal extraction success');
}

const safeVerifierSetupStages = new Set([
  'tuf-get-trusted-root', 'trust-material', 'verifier-construction',
  'verification-policy', 'unknown',
]);

const safeVerifierSetupSteps = new Set([
  'tuf-cache-init', 'tuf-cache-seed', 'tuf-client-init',
  'tuf-target-metadata-search', 'tuf-metadata-refresh', 'tuf-target-cache-lookup',
  'tuf-target-download', 'tuf-target-read', 'trusted-root-json-parse',
  'trusted-root-deserialize', 'trust-material', 'verifier-construction',
  'verification-policy', 'unknown',
]);

const safeModuleFailureCodes = new Set(['MODULE_IMPORT_REJECTED', 'ERR_MODULE_NOT_FOUND', 'SyntaxError']);
const safeReleaseFetchPhases = new Set(['startup', 'manual']);
const safeReleaseFetchFailures = new Set(['none', 'rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed', 'unknown']);
const safeExtractRendererStatuses = new Map([
  ['Choose a destination folder…', 'pending'],
  ['Verified archive extracted. You can now launch the new copy.', 'verified'],
  ['Folder selection cancelled.', 'cancelled'],
]);
const safeExtractInvokeStatuses = new Set(['not-started', 'pending', 'fulfilled', 'rejected']);
const safeUpdateLaunchPhases = new Set(['unknown', 'rehash', 'dialog', 'response']);
const safeUpdateLaunchSubstages = new Set(['unknown', 'not-started', 'module-import', 'file-rehash', 'verified', 'not-applicable']);
const safeUpdateLaunchReadPhases = new Set(['unknown', 'not-started', 'not-applicable', 'waiting-before-read', 'reading', 'verified']);
const safeUpdateLaunchDialogs = new Set(['not-started', 'invoked', 'marker-written', 'marker-write-failed']);
const safeUpdateLaunchDecisions = new Set(['not-started', 'cancelled', 'approved']);
const safeUpdateLaunchClickStatuses = new Set(['not-started', 'received']);
const safeUpdateLaunchInvokeStatuses = new Set(['not-started', 'pending', 'fulfilled', 'rejected']);
const safeExtractMainStatuses = new Set(['not-started', 'starting', 'fulfilled', 'rejected']);
const safeExtractPhases = new Set(['preflight', 'digest', 'zip-open', 'zip-read', 'write', 'executable', 'cleanup', 'fulfilled', 'rejected', 'unknown']);
const safeExtractSubstages = new Set(['none', 'directory-mkdir', 'parent-mkdir', 'read-stream-open', 'pipeline', 'unknown']);
const safeVisibilityStates = new Set(['visible', 'hidden', 'prerender', 'unloaded']);
const safeArchiveFailureCodes = new Set([
  'ARCHIVE_PATH', 'ARCHIVE_LINK', 'ARCHIVE_FILE_TYPE', 'ARCHIVE_SIZE', 'ARCHIVE_DUPLICATE_PATH',
  'INVALID_REQUEST', 'INVALID_DESTINATION', 'DESTINATION_EXISTS', 'UNSUPPORTED_PACKAGE',
  'INVALID_PACKAGE', 'DIGEST_MISMATCH', 'FILESYSTEM_PERMISSION', 'FILESYSTEM_SPACE',
  'FILESYSTEM_READ_ONLY', 'FILESYSTEM_NOT_FOUND', 'FILESYSTEM_CONFLICT',
  'FILESYSTEM_RESOURCE_LIMIT', 'FILESYSTEM_IO', 'TAR_ABORT', 'TAR_BAD_ARCHIVE',
  'TAR_ENTRY_ERROR', 'TAR_ENTRY_INFO', 'TAR_ENTRY_INVALID', 'TAR_ENTRY_UNSUPPORTED', 'OTHER',
]);
const safeArchiveFailureCode = value => safeArchiveFailureCodes.has(value) ? value : 'OTHER';
const safeExtractStreamCount = (value, max = 0xffffffff) =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : null;

function safeExtractTiming(value) {
  const elapsed = (start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const milliseconds = Math.round(end - start);
    return milliseconds >= 0 && milliseconds <= 120_000 ? milliseconds : null;
  };
  const completedZipEntries = [];
  for (const entry of (Array.isArray(value?.completedZipEntries) ? value.completedZipEntries : []).slice(0, 15)) {
    if (entry?.entrySequence !== completedZipEntries.length + 1 ||
        !Number.isSafeInteger(entry.elapsedMs) || entry.elapsedMs < 0 || entry.elapsedMs > 120_000 ||
        (completedZipEntries.length > 0 && entry.elapsedMs < completedZipEntries.at(-1).elapsedMs)) break;
    completedZipEntries.push({ entrySequence: entry.entrySequence, elapsedMs: entry.elapsedMs });
  }
  return {
    ipcToExtractCallMs: elapsed(value?.ipcEnteredAt, value?.extractCallAt),
    extractCallToDigestVerifiedMs: elapsed(value?.extractCallAt, value?.digestVerifiedAt),
    digestVerifiedToFirstZipPipelineMs: elapsed(value?.digestVerifiedAt, value?.firstZipPipelineAt),
    firstZipPipelineToEntry12Ms: elapsed(value?.firstZipPipelineAt, value?.entry12At),
    ipcToEntry12Ms: elapsed(value?.ipcEnteredAt, value?.entry12At),
    completedZipEntries,
  };
}

function safeExtractStreamSnapshot(value, previous, elapsedMs) {
  if (!value || typeof value !== 'object') return null;
  const entrySequence = Number.isSafeInteger(value.entrySequence) && value.entrySequence >= 1 && value.entrySequence <= 20_000
    ? value.entrySequence : null;
  const compression = ['stored', 'deflate'].includes(value.compression) ? value.compression : 'unknown';
  const entryCompressedSize = safeExtractStreamCount(value.entryCompressedSize);
  const entryUncompressedSize = safeExtractStreamCount(value.entryUncompressedSize);
  const compressedBytesRead = safeExtractStreamCount(value.compressedBytesRead);
  const decodedBytes = safeExtractStreamCount(value.decodedBytes);
  const sinkBytesWritten = safeExtractStreamCount(value.sinkBytesWritten);
  const streamTiming = Object.hasOwn(value, 'streamTimingStage') ? {
    stage: ['before-pipeline', 'pipeline', 'complete'].includes(value.streamTimingStage) ? value.streamTimingStage : 'unknown',
    prePipelineMs: safeExtractStreamCount(value.prePipelineMs, 120_000),
    pipelineMs: safeExtractStreamCount(value.pipelineMs, 120_000),
  } : null;
  const writeCallback = Object.hasOwn(value, 'writeCallbackState') ? {
    state: ['idle', 'write', 'writev'].includes(value.writeCallbackState) ? value.writeCallbackState : 'unknown',
    finishToCloseMs: safeExtractStreamCount(value.writeFinishToCloseMs, 120_000),
    pipelineCpuMs: safeExtractStreamCount(value.pipelineCpuMs, 120_000),
    ageMs: safeExtractStreamCount(value.writeCallbackAgeMs, 120_000),
    waitMs: safeExtractStreamCount(value.writeCallbackWaitMs, 120_000),
    callbackCount: safeExtractStreamCount(value.writeCallbackCount),
    writeCount: safeExtractStreamCount(value.writeCallCount),
    writevCount: safeExtractStreamCount(value.writevCallCount),
  } : null;
  const sameEntry = entrySequence !== null && entrySequence === previous?.entrySequence;
  const intervalMs = sameEntry && Number.isSafeInteger(elapsedMs) && elapsedMs >= 1 && elapsedMs <= 60_000
    ? elapsedMs : null;
  const rate = (current, before) => {
    if (intervalMs === null || current === null || !Number.isSafeInteger(before) || current < before) return null;
    return Math.min(0xffffffff, Math.round((current - before) * 1000 / intervalMs));
  };
  const delta = (current, before, max = 0xffffffff) =>
    intervalMs !== null && current !== null && Number.isSafeInteger(before) && current >= before
      ? Math.min(max, current - before) : null;
  let byteProgress = 'unknown';
  if (entrySequence !== null) {
    if (!Number.isSafeInteger(previous?.entrySequence)) byteProgress = 'baseline';
    else if (!sameEntry) byteProgress = 'baseline';
    else {
      const previousBytesWritten = safeExtractStreamCount(previous.sinkBytesWritten);
      if (sinkBytesWritten !== null && previousBytesWritten !== null) {
        if (sinkBytesWritten > previousBytesWritten) byteProgress = 'advanced';
        else if (sinkBytesWritten === previousBytesWritten) byteProgress = 'unchanged';
      }
    }
  }
  return {
    entrySequence,
    compression,
    entryCompressedSize,
    entryUncompressedSize,
    compressedBytesRead,
    decodedBytes,
    sourceReadableEnded: value.sourceReadableEnded === true,
    sinkWritableFinished: value.sinkWritableFinished === true,
    sinkClosed: value.sinkClosed === true,
    sinkBytesWritten,
    sinkWritableLength: safeExtractStreamCount(value.sinkWritableLength),
    ...(streamTiming ? {
      streamTimingStage: streamTiming.stage,
      prePipelineMs: streamTiming.prePipelineMs,
      pipelineMs: streamTiming.pipelineMs,
    } : {}),
    ...(writeCallback ? {
      writeCallbackState: writeCallback.state,
      writeFinishToCloseMs: writeCallback.finishToCloseMs,
      pipelineCpuMs: writeCallback.pipelineCpuMs,
      writeCallbackAgeMs: writeCallback.ageMs,
      writeCallbackWaitMs: writeCallback.waitMs,
      writeCallbackWaitMsDelta: delta(writeCallback.waitMs, previous?.writeCallbackWaitMs, 120_000),
      writeCallbackCount: writeCallback.callbackCount,
      writeCallbackCountDelta: delta(writeCallback.callbackCount, previous?.writeCallbackCount),
      writeCallCount: writeCallback.writeCount,
      writeCallCountDelta: delta(writeCallback.writeCount, previous?.writeCallCount),
      writevCallCount: writeCallback.writevCount,
      writevCallCountDelta: delta(writeCallback.writevCount, previous?.writevCallCount),
    } : {}),
    byteProgress,
    intervalMs,
    compressedReadBytesPerSecond: rate(compressedBytesRead, previous?.compressedBytesRead),
    decodedBytesPerSecond: rate(decodedBytes, previous?.decodedBytes),
    writtenBytesPerSecond: rate(sinkBytesWritten, previous?.sinkBytesWritten),
  };
}

const zipSinkEntrySequence = 12;
const zipSinkEntryCompressedSize = 111_522_616;
const zipSinkEntryUncompressedSize = 249_832_448;
const zipBatcherArmTimeoutMs = 15_000;
const zipBatcherWriteHighWaterMarkBytes = 16 * 1024;

export function zipBatcherScratchPrefix(archivePath) {
  return path.join(path.dirname(archivePath), 'tus-zip-batcher-');
}
const zipBatcherArmPlan = Object.freeze([
  { trial: 1, arm: 'memory-file' },
  { trial: 1, arm: 'memory-discard' },
  { trial: 2, arm: 'memory-discard' },
  { trial: 2, arm: 'memory-file' },
]);
const safeZipArms = new Set(['memory-file', 'memory-discard']);
const safeZipSinks = new Set(['node-fs-file', 'count-discard']);
const safeZipBatcherOutcomes = new Set(['completed', 'time-limit', 'failed', 'unknown']);
const safeZipCleanupStatuses = new Set(['removed', 'not-created', 'failed', 'unknown']);

function safeZipSinkMetric(value, limit) {
  return Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : null;
}

export function safeZipBatcherComparison(value) {
  const entrySequence = Number.isSafeInteger(value?.entrySequence) && value.entrySequence >= 1 && value.entrySequence <= 20_000
    ? value.entrySequence : null;
  const compression = ['stored', 'deflate'].includes(value?.compression) ? value.compression : 'unknown';
  const entryCompressedSize = safeZipSinkMetric(value?.entryCompressedSize, 500_000_000);
  const entryUncompressedSize = safeZipSinkMetric(value?.entryUncompressedSize, 1_073_741_824);
  const entryNonAsar = value?.entryNonAsar === true;
  const arms = (Array.isArray(value?.arms) ? value.arms : []).slice(0, zipBatcherArmPlan.length).map(arm => {
    const armName = safeZipArms.has(arm?.arm) ? arm.arm : 'unknown';
    const expectedSink = armName === 'memory-file' ? 'node-fs-file'
      : armName === 'memory-discard' ? 'count-discard' : null;
    const sink = safeZipSinks.has(arm?.sink) && arm.sink === expectedSink ? arm.sink : 'unknown';
    const usesBatcher = safeZipArms.has(armName) && sink !== 'unknown';
    const decodedBytes = safeZipSinkMetric(arm?.decodedBytes, 1_073_741_824);
    const sinkBytesProcessed = safeZipSinkMetric(arm?.sinkBytesProcessed, 1_073_741_824);
    return {
      trial: [1, 2].includes(arm?.trial) ? arm.trial : null,
      arm: armName,
      sink,
      batchBytes: usesBatcher && arm?.batchBytes === zipWriteBatchBytes ? zipWriteBatchBytes : null,
      outcome: safeZipBatcherOutcomes.has(arm?.outcome) ? arm.outcome : 'unknown',
      wallMs: safeZipSinkMetric(arm?.wallMs, 60_000),
      cpuUserMs: safeZipSinkMetric(arm?.cpuUserMs, 120_000),
      cpuSystemMs: safeZipSinkMetric(arm?.cpuSystemMs, 120_000),
      compressedBytesRead: null,
      decodedBytes,
      sinkBytesProcessed,
      countersMatch: decodedBytes !== null && sinkBytesProcessed !== null ? decodedBytes === sinkBytesProcessed : null,
      sinkWritableLength: safeZipSinkMetric(arm?.sinkWritableLength, zipWriteBatchBytes + zipBatcherWriteHighWaterMarkBytes),
      sinkNeedDrain: typeof arm?.sinkNeedDrain === 'boolean' ? arm.sinkNeedDrain : null,
      writeCallbackWaitMs: safeZipSinkMetric(arm?.writeCallbackWaitMs, zipBatcherArmTimeoutMs),
      sourceReadableEnded: arm?.sourceReadableEnded === true,
      sinkWritableFinished: arm?.sinkWritableFinished === true,
      sinkClosed: arm?.sinkClosed === true,
      cleanupStatus: safeZipCleanupStatuses.has(arm?.cleanupStatus) ? arm.cleanupStatus : 'unknown',
    };
  });
  return {
    assetMatches: value?.assetMatches === true,
    memorySourceVerified: value?.memorySourceVerified === true,
    entrySequence,
    compression,
    entryCompressedSize,
    entryUncompressedSize,
    entryNonAsar,
    entryMatches: value?.entryMatches === true && entrySequence === zipSinkEntrySequence &&
      compression === 'deflate' && entryCompressedSize === zipSinkEntryCompressedSize &&
      entryUncompressedSize === zipSinkEntryUncompressedSize && entryNonAsar,
    batchBytes: value?.batchBytes === zipWriteBatchBytes ? zipWriteBatchBytes : null,
    armOrder: arms.map(arm => arm.arm),
    sinkOrder: arms.map(arm => arm.sink),
    readHighWaterMarkBytes: safeZipSinkMetric(value?.readHighWaterMarkBytes, 1_073_741_824),
    writeHighWaterMarkBytes: safeZipSinkMetric(value?.writeHighWaterMarkBytes, 1_073_741_824),
    cacheCaveat: 'verified-buffer; filesystem-write-cache-not-reset',
    measurementScope: 'verified-memory-deflate-file-vs-discard',
    arms,
  };
}

function readZipEntryAt(zip, wantedSequence) {
  return new Promise((resolve, reject) => {
    let sequence = 0;
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = entry => {
      sequence++;
      if (sequence === wantedSequence) {
        zip.off('entry', onEntry);
        zip.off('end', onEnd);
        resolve({ entry, sequence, cleanup: () => zip.off('error', onError) });
        return;
      }
      try { zip.readEntry(); }
      catch (error) { cleanup(); reject(error); }
    };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = error => { cleanup(); reject(error); };
    zip.on('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    try { zip.readEntry(); }
    catch (error) { cleanup(); reject(error); }
  });
}

function zipStreamPositionBytes(stream) {
  return Number.isSafeInteger(stream?.start) && Number.isSafeInteger(stream?.pos) && stream.pos >= stream.start
    ? stream.pos - stream.start : null;
}

export function runZipSinkPipeline(source, sink, batchBytes, signal) {
  return pipeline(source, createZipWriteBatcher(batchBytes), sink, { signal });
}

async function measureZipBatcherArm(archivePath, archiveBuffer, trial, armName) {
  let entryInfo = {
    entrySequence: null, compression: 'unknown',
    entryCompressedSize: null, entryUncompressedSize: null,
    entryNonAsar: false, entryMatches: false,
  };
  const fileSink = armName === 'memory-file';
  const arm = {
    trial, arm: armName, sink: fileSink ? 'node-fs-file' : 'count-discard',
    batchBytes: zipWriteBatchBytes,
    outcome: 'failed', wallMs: null, cpuUserMs: null, cpuSystemMs: null,
    compressedBytesRead: null, decodedBytes: null, sinkBytesProcessed: null,
    sinkWritableLength: null, sinkNeedDrain: null, writeCallbackWaitMs: null,
    sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false,
    cleanupStatus: 'not-created',
  };
  let zip, selected, source, compressedReadStream, sink, tempDirectory, filePath, timer, timedOut = false;
  let writeCallbackSnapshot;
  const sampleSink = () => {
    arm.sinkWritableLength = Number.isSafeInteger(sink?.writableLength) && sink.writableLength >= 0
      ? sink.writableLength : null;
    arm.sinkNeedDrain = typeof sink?.writableNeedDrain === 'boolean' ? sink.writableNeedDrain : null;
    const snapshot = writeCallbackSnapshot?.();
    arm.writeCallbackWaitMs = Number.isSafeInteger(snapshot?.writeCallbackWaitMs)
      ? snapshot.writeCallbackWaitMs : null;
  };
  try {
    const options = { strictFileNames: true, validateEntrySizes: true };
    zip = await yauzl.fromBufferPromise(archiveBuffer, options);
    selected = await readZipEntryAt(zip, zipSinkEntrySequence);
    if (!selected) return { entryInfo, arm };

    const { entry, sequence } = selected;
    const compression = entry.compressionMethod === 8 ? 'deflate'
      : entry.compressionMethod === 0 ? 'stored' : 'unknown';
    const entryType = (entry.externalFileAttributes >>> 16) & 0o170000;
    const entryNonAsar = typeof entry.fileName === 'string' &&
      !entry.fileName.split('/').some(part => part.toLowerCase().endsWith('.asar')) &&
      !entry.fileName.endsWith('/') && (entryType === 0 || entryType === 0o100000);
    entryInfo = {
      entrySequence: sequence,
      compression,
      entryCompressedSize: entry.compressedSize,
      entryUncompressedSize: entry.uncompressedSize,
      entryNonAsar,
    };
    entryInfo.entryMatches = sequence === zipSinkEntrySequence && compression === 'deflate' &&
      entry.compressedSize === zipSinkEntryCompressedSize &&
      entry.uncompressedSize === zipSinkEntryUncompressedSize && entryNonAsar;
    if (!entryInfo.entryMatches) return { entryInfo, arm };

    const opened = await openZipReadStream(zip, entry, true, zipReadChunkBytes, true);
    source = opened.stream;
    compressedReadStream = opened.compressedReadStream;
    if (fileSink) {
      tempDirectory = await mkdtemp(zipBatcherScratchPrefix(archivePath));
      filePath = path.join(tempDirectory, 'entry.bin');
      sink = createWriteStream(filePath, {
        flags: 'wx', mode: 0o600, highWaterMark: zipBatcherWriteHighWaterMarkBytes,
      });
    } else {
      sink = new Writable({
        highWaterMark: zipBatcherWriteHighWaterMarkBytes,
        write(chunk, _encoding, callback) {
          arm.sinkBytesProcessed = (arm.sinkBytesProcessed ?? 0) + chunk.length;
          callback();
        },
      });
    }
    writeCallbackSnapshot = trackZipWriteCallback(sink);

    const controller = new AbortController();
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    timer = setTimeout(() => {
      timedOut = true;
      sampleSink();
      controller.abort();
    }, zipBatcherArmTimeoutMs);
    try {
      await runZipSinkPipeline(source, sink, zipWriteBatchBytes, controller.signal);
      arm.outcome = 'completed';
      sampleSink();
    } catch {
      arm.outcome = timedOut ? 'time-limit' : 'failed';
      if (!timedOut) sampleSink();
    } finally {
      clearTimeout(timer);
      timer = null;
      arm.wallMs = Math.round(performance.now() - startedAt);
      const cpu = process.cpuUsage(cpuStart);
      arm.cpuUserMs = Math.round(cpu.user / 1000);
      arm.cpuSystemMs = Math.round(cpu.system / 1000);
      arm.decodedBytes = Number.isSafeInteger(source?.actualByteCount) ? source.actualByteCount : zipStreamPositionBytes(source);
      arm.sourceReadableEnded = source?.readableEnded === true;
      arm.sinkWritableFinished = sink?.writableFinished === true;
      arm.sinkClosed = sink?.closed === true;
      if (fileSink) {
        try {
          const result = await stat(filePath);
          arm.sinkBytesProcessed = Number.isSafeInteger(result.size) ? result.size : null;
        } catch {}
      } else {
        arm.sinkBytesProcessed ??= 0;
      }
    }
  } catch {
    arm.outcome = timedOut ? 'time-limit' : 'failed';
  } finally {
    clearTimeout(timer);
    selected?.cleanup();
    source?.destroy();
    compressedReadStream?.destroy();
    sink?.destroy();
    try { zip?.close(); } catch {}
    if (tempDirectory) {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
        arm.cleanupStatus = 'removed';
      } catch {
        arm.cleanupStatus = 'failed';
        arm.outcome = 'failed';
      }
    }
  }
  return { entryInfo, arm };
}

export async function compareVerifiedWindowsZipBatcher(archivePath, assetMatches, expected) {
  const expectedSize = expected?.size;
  const expectedSha256 = expected?.sha256;
  if (assetMatches !== true || typeof archivePath !== 'string' ||
      !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 500_000_000 ||
      typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return safeZipBatcherComparison({ assetMatches: false, memorySourceVerified: false });
  }
  let archiveBuffer;
  try { archiveBuffer = await readFile(archivePath); }
  catch { return safeZipBatcherComparison({ assetMatches: true, memorySourceVerified: false }); }
  const memorySourceVerified = archiveBuffer.length === expectedSize &&
    createHash('sha256').update(archiveBuffer).digest('hex') === expectedSha256;
  if (!memorySourceVerified) return safeZipBatcherComparison({ assetMatches: true, memorySourceVerified: false });

  const arms = [];
  let entryInfo = null;
  let allEntriesMatch = true;
  for (const { trial, arm } of zipBatcherArmPlan) {
    const measured = await measureZipBatcherArm(archivePath, archiveBuffer, trial, arm);
    if (entryInfo === null) {
      entryInfo = measured.entryInfo;
      allEntriesMatch = entryInfo.entryMatches;
    } else {
      const sameEntry = measured.entryInfo.entrySequence === entryInfo.entrySequence &&
        measured.entryInfo.compression === entryInfo.compression &&
        measured.entryInfo.entryCompressedSize === entryInfo.entryCompressedSize &&
        measured.entryInfo.entryUncompressedSize === entryInfo.entryUncompressedSize &&
        measured.entryInfo.entryNonAsar === entryInfo.entryNonAsar;
      allEntriesMatch = allEntriesMatch && measured.entryInfo.entryMatches && sameEntry;
    }
    arms.push(measured.arm);
    if (!allEntriesMatch) break;
  }
  return safeZipBatcherComparison({
    assetMatches: true,
    memorySourceVerified,
    ...(entryInfo ?? {}),
    entryMatches: allEntriesMatch && arms.length === zipBatcherArmPlan.length,
    batchBytes: zipWriteBatchBytes,
    readHighWaterMarkBytes: zipReadChunkBytes,
    writeHighWaterMarkBytes: zipBatcherWriteHighWaterMarkBytes,
    arms,
  });
}

export function safeMainDiagnostics(live, manifestFile, assetName, tag) {
  const safeRootTarget = value => ({
    available: value?.available === true,
    sha256: typeof value?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : null,
  });
  return (Array.isArray(live) ? live : []).slice(0, 40).map(item => ({
    bundleIndex: Number.isInteger(item?.bundleIndex) && item.bundleIndex >= 0 && item.bundleIndex < 20 ? item.bundleIndex : null,
    bundleSha256: typeof item?.bundleSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.bundleSha256) ? item.bundleSha256 : null,
    stage: ['updater-module-import', 'download-verified-asset', 'renderer-invoke', 'extract-archive', 'extract-failed', 'main-catch-fallback', 'verify-start', 'verify-result', 'verifier-setup', 'verifier-verify', 'verifier-tampered-control', 'update-launch', 'release-fetch'].includes(item?.stage) ? item.stage : 'unknown',
    status: item?.stage === 'release-fetch'
      ? (Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? item.status : null)
      : (['not-started', 'pending', 'fulfilled', 'starting', 'ready', 'synthetic-other', 'verified', 'rejected', 'tampered-rejected', 'tampered-accepted', 'tampered-unavailable'].includes(item?.status)
        ? item.status : item?.stage === 'verify-start' ? 'started' : 'unknown'),
    assetMatches: item?.assetName === assetName && item?.assetSha256 === manifestFile.sha256 && item?.tag === tag,
    ...(item?.status === 'rejected' && item?.stage !== 'updater-module-import' && item?.stage !== 'renderer-invoke' && item?.stage !== 'extract-failed' && item?.stage !== 'extract-archive' && item?.stage !== 'update-launch' ? {
      failureCode: safeUpdaterFailureCode(item.failureCode),
      ...(item?.stage === 'verifier-setup' ? {
        verifierSetupStage: safeVerifierSetupStages.has(item.verifierSetupStage) ? item.verifierSetupStage : 'unknown',
        verifierSetupStep: safeVerifierSetupSteps.has(item.verifierSetupStep) ? item.verifierSetupStep : 'unknown',
      } : {}),
      verifierCode: safeVerifierCode(item.verifierCode, item.verifierErrorType),
      verifierErrorType: safeVerifierErrorType(item.verifierErrorType),
      verifierCauseCode: safeVerifierCode(item.verifierCauseCode),
      verifierCauseErrorType: safeVerifierErrorType(item.verifierCauseErrorType),
    } : {}),
    ...(item?.stage === 'updater-module-import' && item?.status === 'rejected' ? {
      moduleFailureCode: safeModuleFailureCodes.has(item?.moduleFailureCode) ? item.moduleFailureCode : 'OTHER',
      moduleFailureName: safeUpdaterModuleName(item?.moduleFailureName),
    } : {}),
    ...(item?.stage === 'update-launch' ? {
      launchPhase: safeUpdateLaunchPhases.has(item.launchPhase) ? item.launchPhase : 'unknown',
      launchSubstage: safeUpdateLaunchSubstages.has(item.launchSubstage) ? item.launchSubstage : 'unknown',
      launchReadPhase: safeUpdateLaunchReadPhases.has(item.launchReadPhase) ? item.launchReadPhase : 'unknown',
      launchReadBytes: Number.isSafeInteger(item.launchReadBytes) && item.launchReadBytes >= 0
        ? Math.min(item.launchReadBytes, 0xffff_ffff)
        : null,
      launchDialog: safeUpdateLaunchDialogs.has(item.launchDialog) ? item.launchDialog : 'unknown',
      launchDecision: safeUpdateLaunchDecisions.has(item.launchDecision) ? item.launchDecision : 'unknown',
      rendererClickStatus: safeUpdateLaunchClickStatuses.has(item.rendererClickStatus) ? item.rendererClickStatus : 'unknown',
      rendererInvokeStatus: safeUpdateLaunchInvokeStatuses.has(item.rendererInvokeStatus) ? item.rendererInvokeStatus : 'unknown',
    } : {}),
    ...(item?.stage === 'extract-failed' && item?.status === 'rejected' ? {
      failureCode: typeof item.failureCode === 'string' ? safeArchiveFailureCode(item.failureCode) : null,
      extractStage: safeArchiveExtractionStage(item.extractStage),
      extractOperation: safeArchiveExtractionOperation(item.extractOperation),
    } : {}),
    ...(item?.stage === 'extract-archive' ? {
      rendererStatus: safeExtractRendererStatuses.get(item.rendererStatusText) ?? (typeof item.rendererStatusText === 'string' && item.rendererStatusText ? 'other' : 'unknown'),
      rendererInvokeStatus: safeExtractInvokeStatuses.has(item.rendererInvokeStatus) ? item.rendererInvokeStatus : 'unknown',
      extractModuleImport: safeExtractMainStatuses.has(item.extractModuleImport) ? item.extractModuleImport : 'unknown',
      extractCall: safeExtractMainStatuses.has(item.extractCall) ? item.extractCall : 'unknown',
      extractPhase: safeExtractPhases.has(item.extractPhase) ? item.extractPhase : 'unknown',
      extractSubstage: safeExtractSubstages.has(item.extractSubstage) ? item.extractSubstage : 'unknown',
      extractAppAsarEntry: item.extractAppAsarEntry === true,
      extractTiming: safeExtractTiming(item.extractTiming),
      failureCode: typeof item.failureCode === 'string' ? safeArchiveFailureCode(item.failureCode) : null,
      extractStage: typeof item.extractStage === 'string' ? safeArchiveExtractionStage(item.extractStage) : null,
      extractOperation: typeof item.extractOperation === 'string' ? safeArchiveExtractionOperation(item.extractOperation) : null,
      visibilityState: safeVisibilityStates.has(item.visibilityState) ? item.visibilityState : 'unknown',
      fileFlags: {
        targetExists: item.fileFlags?.targetExists === true,
        appAsarExists: item.fileFlags?.appAsarExists === true,
        appAsarFile: item.fileFlags?.appAsarFile === true,
        executableExists: item.fileFlags?.executableExists === true,
        stagedAsarExists: item.fileFlags?.stagedAsarExists === true,
      },
      streamSnapshot: safeExtractStreamSnapshot(item.extractStreamSnapshot, item.previousStreamSnapshot, item.streamIntervalMs),
    } : {}),
    ...(item?.stage === 'release-fetch' ? {
      phase: safeReleaseFetchPhases.has(item.phase) ? item.phase : 'unknown',
      page: Number.isInteger(item.page) && item.page >= 1 && item.page <= 10 ? item.page : null,
      count: Number.isInteger(item.count) && item.count >= 1 && item.count <= 10 ? item.count : null,
      remainingZero: typeof item.remainingZero === 'boolean' ? item.remainingZero : null,
      safeFailure: safeReleaseFetchFailures.has(item.safeFailure) ? item.safeFailure : 'unknown',
    } : {}),
    trustedRootTarget: safeRootTarget(item?.trustedRootTarget),
  }));
}
