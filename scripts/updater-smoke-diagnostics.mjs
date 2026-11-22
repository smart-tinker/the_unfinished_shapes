import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { createZipWriteBatcher, openZipReadStream, safeArchiveExtractionOperation, safeArchiveExtractionStage, safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType, zipReadChunkBytes } from '../src/update-package.mjs';
import { safeUpdaterModuleName } from '../src/update-release.mjs';

export const updaterZipStreamSampleOffsetsMs = Object.freeze([15_000, 35_000, 55_000, 75_000, 95_000, 110_000]);

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
const safeExtractRendererStatuses = new Map([
  ['Choose a destination folder…', 'pending'],
  ['Verified archive extracted. You can now launch the new copy.', 'verified'],
  ['Folder selection cancelled.', 'cancelled'],
]);
const safeExtractInvokeStatuses = new Set(['not-started', 'pending', 'fulfilled', 'rejected']);
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
const safeExtractStreamCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 0xffffffff) : null;

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
  const sameEntry = entrySequence !== null && entrySequence === previous?.entrySequence;
  const intervalMs = sameEntry && Number.isSafeInteger(elapsedMs) && elapsedMs >= 1 && elapsedMs <= 60_000
    ? elapsedMs : null;
  const rate = (current, before) => {
    if (intervalMs === null || current === null || !Number.isSafeInteger(before) || current < before) return null;
    return Math.min(0xffffffff, Math.round((current - before) * 1000 / intervalMs));
  };
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
const zipSinkArmTimeoutMs = 15_000;
const zipSinkWriteHighWaterMarkBytes = 16 * 1024;
const zipSinkArmPlan = Object.freeze([
  { trial: 1, sink: 'count-discard' },
  { trial: 1, sink: 'file-sink' },
  { trial: 2, sink: 'file-sink' },
  { trial: 2, sink: 'count-discard' },
]);
const safeZipSinkSinks = new Set(['count-discard', 'file-sink']);
const safeZipSinkOutcomes = new Set(['completed', 'time-limit', 'failed', 'unknown']);

function safeZipSinkMetric(value, limit) {
  return Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : null;
}

export function safeZipSinkComparison(value) {
  const entrySequence = Number.isSafeInteger(value?.entrySequence) && value.entrySequence >= 1 && value.entrySequence <= 20_000
    ? value.entrySequence : null;
  const compression = ['stored', 'deflate'].includes(value?.compression) ? value.compression : 'unknown';
  const entryCompressedSize = safeZipSinkMetric(value?.entryCompressedSize, 500_000_000);
  const entryUncompressedSize = safeZipSinkMetric(value?.entryUncompressedSize, 1_073_741_824);
  const entryNonAsar = value?.entryNonAsar === true;
  const rawArms = Array.isArray(value?.arms) ? value.arms.slice(0, zipSinkArmPlan.length) : [];
  const safeArm = arm => {
    const decodedBytes = safeZipSinkMetric(arm?.decodedBytes, 1_073_741_824);
    const sinkBytesWritten = safeZipSinkMetric(arm?.sinkBytesWritten, 1_073_741_824);
    return {
      trial: [1, 2].includes(arm?.trial) ? arm.trial : null,
      sink: safeZipSinkSinks.has(arm?.sink) ? arm.sink : 'unknown',
      outcome: safeZipSinkOutcomes.has(arm?.outcome) ? arm.outcome : 'unknown',
      wallMs: safeZipSinkMetric(arm?.wallMs, 60_000),
      cpuUserMs: safeZipSinkMetric(arm?.cpuUserMs, 120_000),
      cpuSystemMs: safeZipSinkMetric(arm?.cpuSystemMs, 120_000),
      compressedBytesRead: safeZipSinkMetric(arm?.compressedBytesRead, 500_000_000),
      decodedBytes,
      sinkBytesWritten,
      countersMatch: decodedBytes !== null && sinkBytesWritten !== null ? decodedBytes === sinkBytesWritten : null,
      sourceReadableEnded: arm?.sourceReadableEnded === true,
      sinkWritableFinished: arm?.sinkWritableFinished === true,
      sinkClosed: arm?.sinkClosed === true,
    };
  };
  const arms = rawArms.map(safeArm);
  const entryMatches = value?.entryMatches === true && entrySequence === zipSinkEntrySequence &&
    compression === 'deflate' && entryCompressedSize === zipSinkEntryCompressedSize &&
    entryUncompressedSize === zipSinkEntryUncompressedSize && entryNonAsar;
  return {
    assetMatches: value?.assetMatches === true,
    entrySequence,
    compression,
    entryCompressedSize,
    entryUncompressedSize,
    entryNonAsar,
    entryMatches,
    armOrder: arms.map(arm => arm.sink),
    cacheCaveat: 'sink-order-counterbalanced; filesystem-read-cache-not-reset',
    measurementScope: 'pipeline-only',
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
        cleanup();
        resolve({ entry, sequence });
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

function streamPositionBytes(stream) {
  return Number.isSafeInteger(stream?.start) && Number.isSafeInteger(stream?.pos) && stream.pos >= stream.start
    ? stream.pos - stream.start : null;
}

async function measureZipSinkArm(archivePath, sinkName) {
  const entryInfo = {
    entrySequence: null, compression: 'unknown',
    entryCompressedSize: null, entryUncompressedSize: null,
    entryNonAsar: false, entryMatches: false,
  };
  const arm = {
    outcome: 'failed', wallMs: null, cpuUserMs: null, cpuSystemMs: null,
    compressedBytesRead: null, decodedBytes: null, sinkBytesWritten: null,
    sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false,
  };
  let zip, source, compressedReadStream, sink, tempDir, timer, timedOut = false;
  try {
    zip = await yauzl.openPromise(archivePath, { strictFileNames: true, validateEntrySizes: true });
    const selected = await readZipEntryAt(zip, zipSinkEntrySequence);
    if (!selected) return { entryInfo, arm };
    const { entry, sequence } = selected;
    const compression = entry.compressionMethod === 8 ? 'deflate' : entry.compressionMethod === 0 ? 'stored' : 'unknown';
    const entryType = (entry.externalFileAttributes >>> 16) & 0o170000;
    const entryNonAsar = typeof entry.fileName === 'string' &&
      !entry.fileName.split('/').some(part => part.toLowerCase().endsWith('.asar')) &&
      !entry.fileName.endsWith('/') && (entryType === 0 || entryType === 0o100000);
    Object.assign(entryInfo, {
      entrySequence: sequence,
      compression,
      entryCompressedSize: entry.compressedSize,
      entryUncompressedSize: entry.uncompressedSize,
      entryNonAsar,
    });
    entryInfo.entryMatches = sequence === zipSinkEntrySequence && compression === 'deflate' &&
      entry.compressedSize === zipSinkEntryCompressedSize &&
      entry.uncompressedSize === zipSinkEntryUncompressedSize && entryNonAsar;
    if (!entryInfo.entryMatches) return { entryInfo, arm };
    if (sinkName === 'file-sink') tempDir = await mkdtemp(path.join(os.tmpdir(), 'tus-zip-sink-'));

    const opened = await openZipReadStream(zip, entry, true, zipReadChunkBytes);
    source = opened.stream;
    compressedReadStream = opened.compressedReadStream;
    if (sinkName === 'file-sink') {
      sink = createWriteStream(path.join(tempDir, 'entry.bin'), {
        flags: 'wx', mode: 0o600, highWaterMark: zipSinkWriteHighWaterMarkBytes,
      });
    } else {
      sink = new Writable({
        highWaterMark: zipSinkWriteHighWaterMarkBytes,
        write(chunk, _encoding, callback) {
          this.bytesWritten += chunk.length;
          callback();
        },
      });
      sink.bytesWritten = 0;
    }
    const controller = new AbortController();
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, zipSinkArmTimeoutMs);
    try {
      await pipeline(source, createZipWriteBatcher(), sink, { signal: controller.signal });
      arm.outcome = 'completed';
    } catch {
      arm.outcome = timedOut ? 'time-limit' : 'failed';
    } finally {
      clearTimeout(timer);
      timer = null;
      arm.wallMs = Math.round(performance.now() - startedAt);
      const cpu = process.cpuUsage(cpuStart);
      arm.cpuUserMs = Math.round(cpu.user / 1000);
      arm.cpuSystemMs = Math.round(cpu.system / 1000);
      arm.compressedBytesRead = streamPositionBytes(compressedReadStream);
      arm.decodedBytes = Number.isSafeInteger(source?.actualByteCount)
        ? source.actualByteCount : streamPositionBytes(source);
      arm.sinkBytesWritten = Number.isSafeInteger(sink?.bytesWritten) ? sink.bytesWritten : null;
      arm.sourceReadableEnded = source?.readableEnded === true;
      arm.sinkWritableFinished = sink?.writableFinished === true;
      arm.sinkClosed = sink?.closed === true;
    }
  } catch {
    arm.outcome = timedOut ? 'time-limit' : 'failed';
  } finally {
    clearTimeout(timer);
    source?.destroy();
    compressedReadStream?.destroy();
    try { zip?.close(); } catch {}
    if (tempDir) {
      try { await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch { arm.outcome = 'failed'; }
    }
  }
  return { entryInfo, arm };
}

export async function compareVerifiedWindowsZipEntrySinks(archivePath, assetMatches) {
  if (assetMatches !== true) return safeZipSinkComparison({ assetMatches: false });
  const arms = [];
  let entryInfo = null;
  let allEntriesMatch = true;
  for (const { trial, sink } of zipSinkArmPlan) {
    const measured = await measureZipSinkArm(archivePath, sink);
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
    arms.push({ trial, sink, ...measured.arm });
    if (!allEntriesMatch) break;
  }
  return safeZipSinkComparison({
    assetMatches: true,
    ...(entryInfo ?? {}),
    entryMatches: allEntriesMatch && arms.length === zipSinkArmPlan.length,
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
    stage: ['updater-module-import', 'download-verified-asset', 'renderer-invoke', 'extract-archive', 'extract-failed', 'main-catch-fallback', 'verify-start', 'verify-result', 'verifier-setup', 'verifier-verify', 'verifier-tampered-control'].includes(item?.stage) ? item.stage : 'unknown',
    status: ['not-started', 'pending', 'fulfilled', 'starting', 'ready', 'synthetic-other', 'verified', 'rejected', 'tampered-rejected', 'tampered-accepted', 'tampered-unavailable'].includes(item?.status)
      ? item.status : item?.stage === 'verify-start' ? 'started' : 'unknown',
    assetMatches: item?.assetName === assetName && item?.assetSha256 === manifestFile.sha256 && item?.tag === tag,
    ...(item?.status === 'rejected' && item?.stage !== 'updater-module-import' && item?.stage !== 'renderer-invoke' && item?.stage !== 'extract-failed' && item?.stage !== 'extract-archive' ? {
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
    trustedRootTarget: safeRootTarget(item?.trustedRootTarget),
  }));
}
