import { safeArchiveExtractionOperation, safeArchiveExtractionStage, safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType } from '../src/update-package.mjs';
import { safeUpdaterModuleName } from '../src/update-release.mjs';

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

function safeExtractStreamSnapshot(value, previousEntrySequence, previousSinkBytesWritten) {
  if (!value || typeof value !== 'object') return null;
  const entrySequence = Number.isSafeInteger(value.entrySequence) && value.entrySequence >= 1 && value.entrySequence <= 20_000
    ? value.entrySequence : null;
  const sinkBytesWritten = safeExtractStreamCount(value.sinkBytesWritten);
  let byteProgress = 'unknown';
  if (entrySequence !== null) {
    if (previousEntrySequence === undefined) byteProgress = 'baseline';
    else if (Number.isSafeInteger(previousEntrySequence) && previousEntrySequence >= 1 && previousEntrySequence <= 20_000) {
      if (previousEntrySequence !== entrySequence) byteProgress = 'baseline';
      else {
        const previousBytesWritten = safeExtractStreamCount(previousSinkBytesWritten);
        if (sinkBytesWritten !== null && previousBytesWritten !== null) {
          if (sinkBytesWritten > previousBytesWritten) byteProgress = 'advanced';
          else if (sinkBytesWritten === previousBytesWritten) byteProgress = 'unchanged';
        }
      }
    }
  }
  return {
    entrySequence,
    sourceReadableEnded: value.sourceReadableEnded === true,
    sinkWritableFinished: value.sinkWritableFinished === true,
    sinkClosed: value.sinkClosed === true,
    sinkBytesWritten,
    sinkWritableLength: safeExtractStreamCount(value.sinkWritableLength),
    byteProgress,
  };
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
      streamSnapshot: safeExtractStreamSnapshot(item.extractStreamSnapshot, item.previousEntrySequence, item.previousSinkBytesWritten),
    } : {}),
    trustedRootTarget: safeRootTarget(item?.trustedRootTarget),
  }));
}
