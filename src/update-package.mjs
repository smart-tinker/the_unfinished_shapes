import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, rm, symlink, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar } from 'tar';
import yauzl from 'yauzl';
import { createVerifier, verify } from 'sigstore';
import { parseReleaseTag } from './update-release.mjs';

const electronFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : null;

const repository = 'smart-tinker/the_unfinished_shapes';
const repositoryUrl = 'https://github.com/' + repository;
const maxAssetBytes = 500_000_000;
const maxJsonBytes = 2_000_000;
const maxExtractedBytes = 1_073_741_824;
const maxArchiveEntries = 20_000;
export const zipReadChunkBytes = 256 * 1024;

const zipWriteBatchBytes = 256 * 1024;

export function createZipWriteBatcher() {
  let pending = Buffer.allocUnsafe(zipWriteBatchBytes);
  let pendingBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < input.length) {
          const length = Math.min(zipWriteBatchBytes - pendingBytes, input.length - offset);
          input.copy(pending, pendingBytes, offset, offset + length);
          pendingBytes += length;
          offset += length;
          if (pendingBytes === zipWriteBatchBytes) {
            this.push(pending);
            pending = Buffer.allocUnsafe(zipWriteBatchBytes);
            pendingBytes = 0;
          }
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      if (pendingBytes) this.push(pending.subarray(0, pendingBytes));
      callback();
    },
  });
}

export function safeZipExtractionStreamSnapshot(source, sink, entrySequence, entry, compressedSource, writeCallback = null) {
  const count = (value, limit = maxExtractedBytes) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, limit) : null;
  const position = (value, limit) => Number.isSafeInteger(value?.start) && Number.isSafeInteger(value?.pos) && value.pos >= value.start
    ? count(value.pos - value.start, limit) : null;
  const compression = entry?.compressionMethod === 0 ? 'stored' : entry?.compressionMethod === 8 ? 'deflate' : 'unknown';
  const decodedBytes = Number.isSafeInteger(source?.actualByteCount)
    ? count(source.actualByteCount)
    : compression === 'stored' ? position(source, maxExtractedBytes) : null;
  const writeCallbackState = ['write', 'writev', 'idle'].includes(writeCallback?.state) ? writeCallback.state : 'unknown';
  const writeCallbackAgeMs = ['write', 'writev'].includes(writeCallbackState) &&
    Number.isSafeInteger(writeCallback?.ageMs) && writeCallback.ageMs >= 0
    ? Math.min(writeCallback.ageMs, 120_000) : null;
  return {
    entrySequence: Number.isSafeInteger(entrySequence) && entrySequence >= 1 && entrySequence <= maxArchiveEntries ? entrySequence : null,
    compression,
    entryCompressedSize: count(entry?.compressedSize, maxAssetBytes),
    entryUncompressedSize: count(entry?.uncompressedSize),
    compressedBytesRead: position(compressedSource, maxAssetBytes),
    decodedBytes,
    sourceReadableEnded: source?.readableEnded === true,
    sinkWritableFinished: sink?.writableFinished === true,
    sinkClosed: sink?.closed === true,
    sinkBytesWritten: count(sink?.bytesWritten),
    sinkWritableLength: count(sink?.writableLength),
    writeCallbackState,
    writeCallbackAgeMs,
  };
}

export function trackZipWriteCallback(sink) {
  let active = null;
  let instrumented = false;
  let supported = true;
  for (const method of ['_write', '_writev']) {
    const original = sink?.[method];
    if (typeof original !== 'function') continue;
    instrumented = true;
    const wrapped = function (...args) {
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (typeof callback !== 'function') return original.apply(this, args);
      const pending = { state: method === '_write' ? 'write' : 'writev', startedAt: performance.now() };
      active = pending;
      args[callbackIndex] = function (...callbackArgs) {
        if (active === pending) active = null;
        return callback.apply(this, callbackArgs);
      };
      try { return original.apply(this, args); }
      catch (error) {
        if (active === pending) active = null;
        throw error;
      }
    };
    try {
      sink[method] = wrapped;
      if (sink[method] !== wrapped) supported = false;
    } catch { supported = false; }
  }
  return () => {
    if (!instrumented || !supported) return { state: 'unknown', ageMs: null };
    if (!active) return { state: 'idle', ageMs: null };
    return {
      state: active.state,
      ageMs: Math.min(120_000, Math.max(0, Math.floor(performance.now() - active.startedAt))),
    };
  };
}

const sigstoreVerifierCodes = new Set([
  'NOT_IMPLEMENTED_ERROR', 'TLOG_ERROR', 'TLOG_INCLUSION_PROOF_ERROR', 'TLOG_INCLUSION_PROMISE_ERROR',
  'TLOG_MISSING_INCLUSION_ERROR', 'TLOG_BODY_ERROR', 'CERTIFICATE_ERROR', 'PUBLIC_KEY_ERROR',
  'SIGNATURE_ERROR', 'TIMESTAMP_ERROR', 'UNTRUSTED_SIGNER_ERROR', 'BUNDLE_VALIDATION_ERROR',
  'TUF_INIT_CACHE_ERROR', 'TUF_FIND_TARGET_ERROR', 'TUF_REFRESH_METADATA_ERROR',
  'TUF_DOWNLOAD_TARGET_ERROR', 'TUF_READ_TARGET_ERROR',
]);

const safeVerifierErrorTypes = new Map([
  ['Error', 'GENERIC_ERROR'], ['TypeError', 'TYPE_ERROR'], ['TUFError', 'TUF_ERROR'],
  ['ValidationError', 'BUNDLE_VALIDATION_ERROR'], ['ASN1ParseError', 'ASN1_PARSE_ERROR'],
  ['ASN1TypeError', 'ASN1_TYPE_ERROR'], ['RFC3161TimestampVerificationError', 'RFC3161_TIMESTAMP_VERIFICATION_ERROR'],
]);
const safeVerifierErrorCategories = new Set(safeVerifierErrorTypes.values());
const safeVerifierCodesByErrorType = new Map([['ValidationError', 'BUNDLE_VALIDATION_ERROR']]);

export function safeVerifierErrorType(errorType) {
  return typeof errorType === 'string'
    ? safeVerifierErrorTypes.get(errorType) || (safeVerifierErrorCategories.has(errorType) ? errorType : 'OTHER')
    : 'OTHER';
}

export function safeVerifierCode(code, errorType) {
  if (typeof code === 'string' && sigstoreVerifierCodes.has(code)) return code;
  return typeof errorType === 'string' ? safeVerifierCodesByErrorType.get(errorType) || 'OTHER' : 'OTHER';
}

const tufSetupSteps = new Map([
  ['TUF_INIT_CACHE_ERROR', 'tuf-cache-init'],
  ['TUF_FIND_TARGET_ERROR', 'tuf-target-metadata-search'],
  ['TUF_REFRESH_METADATA_ERROR', 'tuf-target-metadata-search'],
  ['TUF_DOWNLOAD_TARGET_ERROR', 'tuf-target-download'],
  ['TUF_READ_TARGET_ERROR', 'tuf-target-read'],
]);
const verifierSetupFrameSteps = new Map([
  ['initTufCache', 'tuf-cache-init'],
  ['seedCache', 'tuf-cache-seed'],
  ['initClient', 'tuf-client-init'],
  ['TUFClient', 'tuf-client-init'],
  ['Updater', 'tuf-client-init'],
  ['preorderDepthFirstWalk', 'tuf-target-metadata-search'],
  ['getTargetInfo', 'tuf-target-metadata-search'],
  ['findCachedTarget', 'tuf-target-cache-lookup'],
  ['downloadTarget', 'tuf-target-download'],
  ['getTargetPath', 'tuf-target-read'],
  ['readTarget', 'tuf-target-read'],
  ['getTarget', 'tuf-target-read'],
  ['toTrustMaterial', 'trust-material'],
  ['Verifier', 'verifier-construction'],
  ['createVerificationPolicy', 'verification-policy'],
]);

function verifierSetupFrames(error) {
  return [error?.cause, error].flatMap(cause => typeof cause?.stack === 'string'
    ? cause.stack.split(/\r?\n/).map(line =>
      line.match(/^\s*at\s+(?:async\s+)?(?:new\s+)?([\w$]+(?:\.[\w$]+)*)(?:\s+\(|$)/)?.[1],
    ).filter(Boolean)
    : []);
}

function verifierSetupFrameIs(frames, name) {
  return frames.some(frame => frame === name || frame.endsWith('.' + name));
}

function safeVerifierSetupDiagnostics(error) {
  const causes = [error, error?.cause];
  const code = causes.map(cause => cause?.code).find(value =>
    typeof value === 'string' && sigstoreVerifierCodes.has(value));
  const frames = verifierSetupFrames(error);
  const frameNames = frames.map(frame => frame.split('.').at(-1));
  const isTufError = typeof code === 'string' && code.startsWith('TUF_');

  let verifierSetupStage = 'unknown';
  if (isTufError || verifierSetupFrameIs(frames, 'getTrustedRoot')) verifierSetupStage = 'tuf-get-trusted-root';
  else if (verifierSetupFrameIs(frames, 'toTrustMaterial')) verifierSetupStage = 'trust-material';
  else if (verifierSetupFrameIs(frames, 'Verifier')) verifierSetupStage = 'verifier-construction';
  else if (verifierSetupFrameIs(frames, 'createVerificationPolicy')) verifierSetupStage = 'verification-policy';

  const firstMetadataFrame = frameNames.find(name =>
    ['refresh', 'getTargetInfo', 'preorderDepthFirstWalk'].includes(name));
  let verifierSetupStep = 'unknown';
  if (firstMetadataFrame === 'refresh' && verifierSetupFrameIs(frames, 'getTargetInfo')) {
    verifierSetupStep = 'tuf-metadata-refresh';
  } else if (verifierSetupFrameIs(frames, 'getTrustedRoot') && verifierSetupFrameIs(frames, 'JSON.parse')) {
    verifierSetupStep = 'trusted-root-json-parse';
  } else if (verifierSetupFrameIs(frames, 'getTrustedRoot') && verifierSetupFrameIs(frames, 'fromJSON')) {
    verifierSetupStep = 'trusted-root-deserialize';
  } else if (typeof code === 'string' && tufSetupSteps.has(code)) {
    verifierSetupStep = tufSetupSteps.get(code);
  } else {
    for (const frame of frames) {
      const step = verifierSetupFrameSteps.get(frame.split('.').at(-1));
      if (step) { verifierSetupStep = step; break; }
    }
  }

  return { verifierSetupStage, verifierSetupStep };
}

export function safeVerifierSetupStage(error) {
  return safeVerifierSetupDiagnostics(error).verifierSetupStage;
}

export function safeVerifierSetupStep(error) {
  return safeVerifierSetupDiagnostics(error).verifierSetupStep;
}

const updaterFailureCodes = new Set([
  'PROVENANCE_FETCH_ERROR', 'PROVENANCE_HTTP_ERROR', 'PROVENANCE_RESPONSE_ERROR',
  'MISSING_PROVENANCE', 'NO_MATCHING_PROVENANCE', 'INVALID_ATTESTATION',
  'INVALID_ATTESTATION_PAYLOAD', 'SIGNATURE_REJECTED', 'ATTESTATION_MISMATCH',
  'DOWNLOAD_FETCH_ERROR', 'DOWNLOAD_HTTP_ERROR', 'UPDATE_NOT_AVAILABLE', 'DOWNLOAD_ALREADY_RUNNING',
  'DIGEST_MISMATCH',
]);

export function safeUpdaterFailureCode(code) {
  return typeof code === 'string' && updaterFailureCodes.has(code) ? code : 'OTHER';
}

const archiveExtractionFailureMessages = new Map([
  ['Unsafe update archive path.', 'ARCHIVE_PATH'],
  ['Update archive contains a path outside its expected package folder.', 'ARCHIVE_PATH'],
  ['Update archive path escapes its destination.', 'ARCHIVE_PATH'],
  ['Unsafe update archive link.', 'ARCHIVE_LINK'],
  ['Update archive link escapes its package folder.', 'ARCHIVE_LINK'],
  ['Update archive contains an unsupported file type.', 'ARCHIVE_FILE_TYPE'],
  ['Update archive contains an unsupported link.', 'ARCHIVE_LINK'],
  ['Update archive exceeds extraction limits.', 'ARCHIVE_SIZE'],
  ['Update archive contains duplicate paths.', 'ARCHIVE_DUPLICATE_PATH'],
  ['Invalid verified update extraction request.', 'INVALID_REQUEST'],
  ['Choose a real destination folder for the update.', 'INVALID_DESTINATION'],
  ['The update destination already exists. Choose another folder.', 'DESTINATION_EXISTS'],
  ['This verified release package is not supported on this device.', 'UNSUPPORTED_PACKAGE'],
  ['Invalid downloaded update file.', 'INVALID_PACKAGE'],
  ['Downloaded update file failed its SHA-256 integrity check.', 'DIGEST_MISMATCH'],
]);
const archiveFileSystemCodes = new Map([
  ['EACCES', 'FILESYSTEM_PERMISSION'], ['EPERM', 'FILESYSTEM_PERMISSION'],
  ['ENOSPC', 'FILESYSTEM_SPACE'], ['EROFS', 'FILESYSTEM_READ_ONLY'],
  ['ENOENT', 'FILESYSTEM_NOT_FOUND'], ['ENOTDIR', 'FILESYSTEM_NOT_FOUND'],
  ['EEXIST', 'FILESYSTEM_CONFLICT'], ['EBUSY', 'FILESYSTEM_CONFLICT'], ['EISDIR', 'FILESYSTEM_CONFLICT'],
  ['EMFILE', 'FILESYSTEM_RESOURCE_LIMIT'], ['ENFILE', 'FILESYSTEM_RESOURCE_LIMIT'],
  ['EIO', 'FILESYSTEM_IO'],
]);

const archiveTarErrorCodes = new Set([
  'TAR_ABORT', 'TAR_BAD_ARCHIVE', 'TAR_ENTRY_ERROR', 'TAR_ENTRY_INFO',
  'TAR_ENTRY_INVALID', 'TAR_ENTRY_UNSUPPORTED',
]);

const archiveExtractionStages = new Set([
  'preflight', 'digest', 'zip-open', 'entry', 'symlink', 'write', 'executable',
]);

export function safeArchiveExtractionStage(value) {
  const stage = typeof value === 'string' ? value : value?.extractStage;
  return archiveExtractionStages.has(stage) ? stage : 'unknown';
}

export function classifyAppAsarOpenFailure(error, expectedPath, zipOutputPath) {
  const prefix = 'Invalid package ';
  if (typeof error?.message !== 'string' || !error.message.startsWith(prefix) || typeof expectedPath !== 'string') return 'unknown';
  const messagePath = error.message.slice(prefix.length);
  const failedPath = error?.entry && typeof error.entry === 'object' ? error.entry.absolute : zipOutputPath;
  return typeof failedPath === 'string' &&
    path.resolve(messagePath) === path.resolve(expectedPath) &&
    path.resolve(failedPath) === path.resolve(expectedPath)
    ? 'asar-open-invalid-package' : 'unknown';
}

export function safeArchiveExtractionOperation(value) {
  const operation = typeof value === 'string' ? value : value?.extractOperation;
  return operation === 'asar-open-invalid-package' ? operation : 'unknown';
}

export function safeArchiveExtractionFailureCode(error) {
  return archiveFileSystemCodes.get(error?.code) ??
    archiveExtractionFailureMessages.get(error?.message) ??
    (archiveTarErrorCodes.has(error?.tarCode) ? error.tarCode : 'OTHER');
}

function updaterFailure(message, failureCode, httpStatus) {
  const error = new Error(message);
  error.failureCode = safeUpdaterFailureCode(failureCode);
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) error.httpStatus = httpStatus;
  return error;
}
const downloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

function releaseVersion(tag) {
  const value = parseReleaseTag(tag);
  if (!value) throw new Error('Unsupported TUS release tag.');
  return value.major + '.' + value.minor + '.' + value.patch +
    (value.prereleaseNumber === null ? '' : '-rc.' + value.prereleaseNumber);
}

function validateAsset(asset, tag) {
  const prefix = 'TheUnfinishedShapes-' + releaseVersion(tag) + '-';
  const suffix = typeof asset?.name === 'string' && asset.name.startsWith(prefix) ? asset.name.slice(prefix.length) : '';
  if (!['Setup-x64.exe', 'win32-x64.zip', 'linux-x64.tar.gz', 'darwin-arm64.zip'].includes(suffix) ||
      !Number.isSafeInteger(asset?.size) || asset.size < 1 || asset.size > maxAssetBytes ||
      typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('Invalid or unsupported release asset.');
  }
  return asset.digest.slice(7);
}

async function readJsonLimited(response) {
  if (!response.body) throw updaterFailure('Empty GitHub provenance response.', 'PROVENANCE_RESPONSE_ERROR');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxJsonBytes) throw updaterFailure('GitHub provenance response is too large.', 'PROVENANCE_RESPONSE_ERROR');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw updaterFailure('Invalid GitHub provenance response.', 'PROVENANCE_RESPONSE_ERROR'); }
}

function exactRegex(value) {
  return '^' + value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&') + '$';
}

export async function verifyReleaseAttestation({ bundle, asset, tag }, verifySignature = verify) {
  const digest = validateAsset(asset, tag);
  if (!bundle || typeof verifySignature !== 'function') throw updaterFailure('Invalid release attestation.', 'INVALID_ATTESTATION');
  const releaseBranch = 'refs/heads/release/' + tag.replace(/^v/, '');
  const identity = repositoryUrl + '/.github/workflows/stage-release.yml@' + releaseBranch;
  try {
    await verifySignature(bundle, {
      certificateIdentityURI: exactRegex(identity),
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    });
  } catch (error) {
    const code = safeVerifierCode(error?.code, error?.constructor?.name);
    const rejection = updaterFailure('Release attestation signature rejected [verifier=' + code + '].', 'SIGNATURE_REJECTED');
    rejection.code = code;
    rejection.verifierErrorType = safeVerifierErrorType(error?.constructor?.name);
    rejection.verifierCauseCode = safeVerifierCode(error?.cause?.code, error?.cause?.constructor?.name);
    rejection.verifierCauseErrorType = safeVerifierErrorType(error?.cause?.constructor?.name);
    throw rejection;
  }
  const envelope = bundle.dsseEnvelope;
  if (bundle.mediaType !== 'application/vnd.dev.sigstore.bundle.v0.3+json' ||
      envelope?.payloadType !== 'application/vnd.in-toto+json' ||
      typeof envelope.payload !== 'string' || envelope.payload.length > maxJsonBytes * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload)) {
    throw updaterFailure('Invalid release attestation payload.', 'INVALID_ATTESTATION_PAYLOAD');
  }
  let statement;
  try { statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')); }
  catch { throw updaterFailure('Invalid release attestation payload.', 'INVALID_ATTESTATION_PAYLOAD'); }
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
  const builder = statement?.predicate?.runDetails?.builder?.id;
  const subjectMatches = Array.isArray(statement?.subject) && statement.subject.some(item =>
    item?.name === asset.name && item?.digest?.sha256 === digest);
  const source = Array.isArray(dependencies) ? dependencies.find(item =>
    item?.uri === 'git+' + repositoryUrl + '@' + releaseBranch) : null;
  if (statement?._type !== 'https://in-toto.io/Statement/v1' ||
      statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
      !subjectMatches ||
      workflow?.ref !== releaseBranch ||
      workflow?.repository !== repositoryUrl ||
      workflow?.path !== '.github/workflows/stage-release.yml' ||
      builder !== identity ||
      !/^[a-f0-9]{40}$/.test(source?.digest?.gitCommit || '')) {
    throw updaterFailure('Release attestation does not match this asset and release workflow.', 'ATTESTATION_MISMATCH');
  }
  return { sourceSha: source.digest.gitCommit, assetName: asset.name };
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyDownloadedFile({ filePath, sha256 }) {
  if (typeof filePath !== 'string' || !filePath || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid downloaded update file.');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || await fileSha256(filePath) !== sha256) {
    throw new Error('Downloaded update file failed its SHA-256 integrity check.');
  }
  return true;
}

async function reportProvenanceDiagnostic(callback, diagnostic) {
  if (typeof callback !== 'function') return;
  try { await callback(diagnostic); } catch {}
}

async function fetchAttestation({ fetcher, digest, tag, asset, signal, verifySignature, onProvenanceDiagnostic }) {
  let response;
  try {
    response = await fetcher('https://api.github.com/repos/' + repository + '/attestations/sha256:' + digest, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal, redirect: 'error',
    });
  } catch (error) {
    if (signal?.aborted && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR')) throw error;
    throw updaterFailure('GitHub release provenance request failed.', 'PROVENANCE_FETCH_ERROR');
  }
  if (!response?.ok) throw updaterFailure(
    'GitHub release provenance check failed (HTTP ' + response?.status + ').',
    'PROVENANCE_HTTP_ERROR', response?.status,
  );
  const body = await readJsonLimited(response);
  if (!Array.isArray(body?.attestations)) throw updaterFailure('Invalid GitHub provenance response.', 'PROVENANCE_RESPONSE_ERROR');
  if (body.attestations.length < 1) throw updaterFailure('No GitHub release provenance was found.', 'MISSING_PROVENANCE');
  if (body.attestations.length > 20) throw updaterFailure('Invalid GitHub provenance response.', 'PROVENANCE_RESPONSE_ERROR');
  let lastError;
  for (let bundleIndex = 0; bundleIndex < body.attestations.length; bundleIndex++) {
    const bundle = body.attestations[bundleIndex]?.bundle;
    if (!bundle) continue;
    const bundleSha256 = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
    const diagnostic = { bundleIndex, bundleSha256, assetName: asset.name, assetSha256: digest, tag };
    await reportProvenanceDiagnostic(onProvenanceDiagnostic, { ...diagnostic, stage: 'verify-start' });
    try {
      const diagnosticVerifySignature = verifySignature === verify
        ? async (bundleToVerify, options) => {
            const reportVerifierStage = (stage, status, error) => reportProvenanceDiagnostic(onProvenanceDiagnostic, {
              ...diagnostic, stage, status,
              ...(error ? {
                failureCode: 'SIGNATURE_REJECTED',
                ...(stage === 'verifier-setup' ? safeVerifierSetupDiagnostics(error) : {}),
                verifierCode: safeVerifierCode(error?.code, error?.constructor?.name),
                verifierErrorType: safeVerifierErrorType(error?.constructor?.name),
                verifierCauseCode: safeVerifierCode(error?.cause?.code, error?.cause?.constructor?.name),
                verifierCauseErrorType: safeVerifierErrorType(error?.cause?.constructor?.name),
              } : {}),
            });
            await reportVerifierStage('verifier-setup', 'starting');
            let verifier;
            try { verifier = await createVerifier(options); }
            catch (error) {
              await reportVerifierStage('verifier-setup', 'rejected', error);
              throw error;
            }
            await reportVerifierStage('verifier-setup', 'ready');
            await reportVerifierStage('verifier-verify', 'starting');
            try {
              const result = await verifier.verify(bundleToVerify);
              await reportVerifierStage('verifier-verify', 'verified');
              if (process.argv.includes('--tus-smoke-provenance-diagnostic')) {
                const tamperedBundle = structuredClone(bundleToVerify);
                const signatures = tamperedBundle?.dsseEnvelope?.signatures;
                let status = 'tampered-unavailable';
                if (Array.isArray(signatures) && signatures.length > 0 &&
                    signatures.every(signature => typeof signature?.sig === 'string' && Buffer.from(signature.sig, 'base64').length > 0)) {
                  for (const signature of signatures) {
                    const bytes = Buffer.from(signature.sig, 'base64');
                    bytes[0] ^= 1;
                    signature.sig = bytes.toString('base64');
                  }
                  status = 'tampered-accepted';
                  try { await verifier.verify(tamperedBundle); }
                  catch { status = 'tampered-rejected'; }
                }
                await reportProvenanceDiagnostic(onProvenanceDiagnostic, {
                  ...diagnostic, stage: 'verifier-tampered-control', status,
                });
              }
              return result;
            } catch (error) {
              await reportVerifierStage('verifier-verify', 'rejected', error);
              throw error;
            }
          }
        : verifySignature;
      const result = await verifyReleaseAttestation({ bundle, asset, tag }, diagnosticVerifySignature);
      await reportProvenanceDiagnostic(onProvenanceDiagnostic, { ...diagnostic, stage: 'verify-result', status: 'verified' });
      return result;
    } catch (error) {
      await reportProvenanceDiagnostic(onProvenanceDiagnostic, {
        ...diagnostic, stage: 'verify-result', status: 'rejected',
        failureCode: safeUpdaterFailureCode(error?.failureCode),
        verifierCode: safeVerifierCode(error?.code, error?.verifierErrorType),
        verifierErrorType: safeVerifierErrorType(error?.verifierErrorType),
        verifierCauseCode: safeVerifierCode(error?.verifierCauseCode),
        verifierCauseErrorType: safeVerifierErrorType(error?.verifierCauseErrorType),
      });
      lastError = error;
    }
  }
  throw lastError || updaterFailure('No matching GitHub release provenance was found.', 'NO_MATCHING_PROVENANCE');
}

export async function downloadVerifiedAsset({
  asset, tag, directory, fetcher = fetch, signal, verifySignature = verify, onProgress = () => {},
  onProvenanceDiagnostic,
}) {
  const digest = validateAsset(asset, tag);
  if (typeof directory !== 'string' || !directory || typeof fetcher !== 'function' || typeof onProgress !== 'function') {
    throw new Error('Invalid updater download request.');
  }
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = path.join(directory, digest + '-' + asset.name);
  let created = false;
  let phase = 'download';
  let partPath = finalPath + '.' + randomUUID() + '.part';
  try {
    let cached = false;
    try {
      const current = await lstat(finalPath);
      if (!current.isFile() || current.isSymbolicLink() || await fileSha256(finalPath) !== digest) {
        throw new Error('Existing update file failed its SHA-256 integrity check.');
      }
      cached = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!cached) {
      const url = 'https://github.com/' + repository + '/releases/download/' +
        encodeURIComponent(tag) + '/' + encodeURIComponent(asset.name);
      let response, currentUrl = url;
      for (let redirect = 0; redirect <= 3; redirect++) {
        try {
          response = await fetcher(currentUrl, {
            headers: { accept: 'application/octet-stream' }, signal: requestSignal, redirect: 'manual',
          });
        } catch (error) {
          if (signal?.aborted && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR')) throw error;
          throw updaterFailure('GitHub release asset request failed.', 'DOWNLOAD_FETCH_ERROR');
        }
        if (!response || !Number.isInteger(response.status)) throw new Error('Invalid GitHub download response.');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers?.get('location');
          if (!location || redirect === 3) throw new Error('GitHub update download redirect limit reached.');
          let next;
          try { next = new URL(location, currentUrl); }
          catch { throw new Error('Invalid GitHub update download redirect.'); }
          if (next.protocol !== 'https:' || !downloadHosts.has(next.hostname) || next.username || next.password) {
            throw new Error('GitHub update download redirected to an untrusted destination.');
          }
          currentUrl = next.href;
          continue;
        }
        if (!response.ok) throw updaterFailure('GitHub update download failed (HTTP ' + response.status + ').', 'DOWNLOAD_HTTP_ERROR', response.status);
        const length = response.headers?.get('content-length');
        if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) !== asset.size)) {
          throw new Error('Release asset size does not match GitHub metadata.');
        }
        if (!response.body) throw new Error('Empty GitHub release asset.');
        const hash = createHash('sha256');
        let received = 0;
        const source = async function* () {
          for await (const chunk of response.body) {
            received += chunk.length;
            if (received > asset.size) throw new Error('Release asset exceeds its declared size.');
            hash.update(chunk);
            onProgress({ received, total: asset.size });
            yield chunk;
          }
        };
        await pipeline(source(), createWriteStream(partPath, { flags: 'wx', mode: 0o600 }), { signal: requestSignal });
        if (received !== asset.size) throw new Error('Release asset size does not match GitHub metadata.');
        if (hash.digest('hex') !== digest) throw updaterFailure('Release asset SHA-256 integrity check failed.', 'DIGEST_MISMATCH');
        await verifyDownloadedFile({ filePath: partPath, sha256: digest });
        await rename(partPath, finalPath);
        partPath = null;
        created = true;
        break;
      }
      if (!created) throw new Error('GitHub did not provide the requested release asset.');
    }
    phase = 'provenance';
    onProgress({ state: 'verifying', phase });
    const provenance = await fetchAttestation({ fetcher, digest, tag, asset, signal: requestSignal, verifySignature, onProvenanceDiagnostic });
    onProgress({ received: asset.size, total: asset.size, verified: true });
    return { filePath: finalPath, sha256: digest, size: asset.size, sourceSha: provenance.sourceSha, assetName: asset.name };
  } catch (error) {
    if (partPath) await rm(partPath, { force: true }).catch(() => {});
    if (created) await rm(finalPath, { force: true }).catch(() => {});
    if (signal?.aborted && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR')) return { cancelled: true };
    const httpStatus = Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : null;
    onProgress({
      state: 'failed', phase,
      failureCode: safeUpdaterFailureCode(error?.failureCode),
      verifierCode: safeVerifierCode(error?.code),
      verifierErrorType: safeVerifierErrorType(error?.verifierErrorType),
      httpStatus,
    });
    throw error;
  }
}

function isWithin(root, destination) {
  const relative = path.relative(root, destination);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function safeArchiveEntryPath(name, archiveRoot) {
  if (typeof name !== 'string' || !name || name.length > 4096 || name.includes('\\') ||
      /[\0-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error('Unsafe update archive path.');
  }
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':')) || parts[0] !== archiveRoot) {
    throw new Error('Update archive contains a path outside its expected package folder.');
  }
  return parts.slice(1).join('/');
}

function safeArchiveLinkTarget(link, fromDirectory, root) {
  if (typeof link !== 'string' || !link || link.length > 4096 || link.includes('\\') ||
      /[\0-\x1f\x7f]/.test(link) || link.startsWith('/') || /^[A-Za-z]:/.test(link)) {
    throw new Error('Unsafe update archive link.');
  }
  const destination = path.resolve(fromDirectory, link);
  if (!isWithin(root, destination)) throw new Error('Update archive link escapes its package folder.');
}

function platformArchive(platform, assetName, tag) {
  const version = releaseVersion(tag);
  const packages = {
    win32: { asset: 'TheUnfinishedShapes-' + version + '-win32-x64.zip', root: 'TheUnfinishedShapes-win32-x64', executable: 'TheUnfinishedShapes.exe', zip: true },
    linux: { asset: 'TheUnfinishedShapes-' + version + '-linux-x64.tar.gz', root: 'TheUnfinishedShapes-linux-x64', executable: 'TheUnfinishedShapes', zip: false },
    darwin: { asset: 'TheUnfinishedShapes-' + version + '-darwin-arm64.zip', root: 'TheUnfinishedShapes.app', executable: 'Contents/MacOS/TheUnfinishedShapes', zip: true },
  };
  const value = packages[platform];
  if (!value || value.asset !== assetName) throw new Error('This verified release package is not supported on this device.');
  return value;
}

export async function openZipReadStream(zip, entry, trackCompressedRead, readHighWaterMark) {
  const configureReadHighWaterMark = Number.isSafeInteger(readHighWaterMark) && readHighWaterMark > 0;
  if ((!trackCompressedRead && !configureReadHighWaterMark) || typeof zip.reader?.createReadStream !== 'function') {
    return { stream: await zip.openReadStreamPromise(entry), compressedReadStream: null };
  }
  const reader = zip.reader;
  const descriptor = Object.getOwnPropertyDescriptor(reader, 'createReadStream');
  const createReadStream = reader.createReadStream;
  let compressedReadStream = null;
  reader.createReadStream = function (options) {
    const isEntryRange = options?.end - options?.start === entry.compressedSize;
    const readOptions = configureReadHighWaterMark && isEntryRange
      ? { ...options, highWaterMark: readHighWaterMark }
      : options;
    const stream = createReadStream.call(this, readOptions);
    if (trackCompressedRead && isEntryRange &&
        Number.isSafeInteger(stream?.start) && Number.isSafeInteger(stream?.pos) && stream.pos >= stream.start) {
      compressedReadStream = stream;
    }
    return stream;
  };
  try {
    return { stream: await zip.openReadStreamPromise(entry), compressedReadStream };
  } finally {
    if (descriptor) Object.defineProperty(reader, 'createReadStream', descriptor);
    else delete reader.createReadStream;
  }
}

async function extractZip(filePath, destination, spec, extraction, appAsarPath, platform) {
  const appAsarRelative = path.relative(destination, appAsarPath).split(path.sep).join('/');
  extraction.value = 'zip-open';
  const zip = await yauzl.openPromise(filePath, { strictFileNames: true, validateEntrySizes: true });
  let count = 0, extractedBytes = 0;
  extraction.value = 'entry';
  for await (const entry of zip.eachEntry()) {
    extraction.value = 'entry';
    count++;
    if (count > maxArchiveEntries || !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 || (extractedBytes += entry.uncompressedSize) > maxExtractedBytes) {
      throw new Error('Update archive exceeds extraction limits.');
    }
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (spec.root === 'TheUnfinishedShapes.app' &&
        (entry.fileName === '__MACOSX' || entry.fileName.startsWith('__MACOSX/'))) {
      const relative = safeArchiveEntryPath(entry.fileName, '__MACOSX');
      const directory = entry.fileName.endsWith('/') || mode === 0o040000;
      if (directory && (mode === 0 || mode === 0o040000)) continue;
      const name = relative.slice(relative.lastIndexOf('/') + 1);
      if (!directory && (mode === 0 || mode === 0o100000) && name.startsWith('._') && name.length > 2) continue;
      throw new Error('Update archive contains an unsupported file type.');
    }
    const relative = safeArchiveEntryPath(entry.fileName, spec.root);
    if (!relative) continue;
    if (relative.startsWith(appAsarRelative + '/')) throw new Error('Update archive contains an unsupported file type.');
    const output = path.resolve(destination, ...relative.split('/'));
    if (!isWithin(destination, output)) throw new Error('Update archive path escapes its destination.');
    const directory = entry.fileName.endsWith('/');
    const isAppAsar = output === appAsarPath;
    if (isAppAsar && (directory || mode === 0o040000)) throw new Error('Update archive contains an unsupported file type.');
    if (directory || mode === 0o040000) {
      extraction.value = 'write';
      extraction.substage = 'directory-mkdir';
      extraction.appAsarEntry = isAppAsar;
      await mkdir(output, { recursive: true, mode: 0o700 });
      extraction.substage = 'none';
      extraction.appAsarEntry = false;
      extraction.value = 'entry';
      continue;
    }
    if (mode !== 0 && mode !== 0o100000 && mode !== 0o120000) throw new Error('Update archive contains an unsupported file type.');
    extraction.value = 'write';
    extraction.substage = 'parent-mkdir';
    extraction.appAsarEntry = isAppAsar;
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    extraction.substage = 'none';
    extraction.appAsarEntry = false;
    if (mode === 0o120000) {
      extraction.value = 'symlink';
      if (process.platform === 'win32' || entry.uncompressedSize > 4096) throw new Error('Update archive contains an unsupported link.');
      extraction.substage = 'read-stream-open';
      extraction.appAsarEntry = isAppAsar;
      const stream = await zip.openReadStreamPromise(entry);
      extraction.substage = 'none';
      extraction.appAsarEntry = false;
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const target = Buffer.concat(chunks).toString('utf8');
      safeArchiveLinkTarget(target, path.dirname(output), destination);
      if (isAppAsar) throw new Error('Update archive contains an unsupported file type.');
      await symlink(target, output);
      extraction.value = 'entry';
      continue;
    }
    extraction.value = 'write';
    extraction.substage = 'read-stream-open';
    extraction.appAsarEntry = isAppAsar;
    const { stream, compressedReadStream } = await openZipReadStream(
      zip, entry, extraction.trackDiagnostics, platform === 'win32' ? zipReadChunkBytes : null,
    );
    extraction.substage = 'none';
    extraction.appAsarEntry = false;
    const fileMode = ((entry.externalFileAttributes >>> 16) & 0o777) || 0o600;
    let writeStream;
    try {
      extraction.substage = 'pipeline';
      extraction.appAsarEntry = isAppAsar;
      writeStream = isAppAsar && electronFs
        ? electronFs.createWriteStream(output, { flags: 'wx', mode: fileMode })
        : createWriteStream(output, { flags: 'wx', mode: fileMode });
      const writeCallbackSnapshot = extraction.trackDiagnostics && platform === 'win32' && !isAppAsar
        ? trackZipWriteCallback(writeStream)
        : null;
      extraction.streamSnapshot = () => safeZipExtractionStreamSnapshot(
        stream, writeStream, count, entry, compressedReadStream, writeCallbackSnapshot?.(),
      );
      await pipeline(...(platform === 'win32' && !isAppAsar
        ? [stream, createZipWriteBatcher(), writeStream]
        : [stream, writeStream]));
      extraction.substage = 'none';
      extraction.appAsarEntry = false;
    } catch (error) {
      const operation = classifyAppAsarOpenFailure(error, appAsarPath, output);
      if (operation !== 'unknown' && error && typeof error === 'object') {
        try { error.extractOperation = operation; } catch {}
      }
      throw error;
    } finally {
      extraction.streamSnapshot = null;
    }
    extraction.value = 'entry';
  }
}

export async function extractVerifiedArchive({ filePath, directory, tag, assetName, sha256, platform = process.platform }) {
  let phase = 'preflight', archiveFormat = 'unknown';
  const smokeBoundary = process.argv.includes('--tus-smoke-provenance-diagnostic') ? globalThis.__tusUpdaterSmokeBoundary : null;
  const extraction = {
    get value() { return phase; },
    get trackDiagnostics() { return smokeBoundary !== null; },
    set value(value) {
      phase = value;
      if (smokeBoundary) {
        smokeBoundary.extractPhase = ['entry', 'symlink'].includes(value)
          ? archiveFormat === 'zip' ? 'zip-read' : 'unknown'
          : value;
        if (value !== 'write') {
          smokeBoundary.extractSubstage = 'none';
          smokeBoundary.extractAppAsarEntry = false;
        }
      }
    },
    set substage(value) {
      if (smokeBoundary) smokeBoundary.extractSubstage = value;
    },
    set appAsarEntry(value) {
      if (smokeBoundary) smokeBoundary.extractAppAsarEntry = value === true;
    },
    set streamSnapshot(value) {
      if (smokeBoundary) smokeBoundary.extractStreamSnapshot = typeof value === 'function' ? value : null;
    },
  };
  let target, appAsarPath, targetCreated = false;
  try {
    const spec = platformArchive(platform, assetName, tag);
    archiveFormat = spec.zip ? 'zip' : 'tar';
    if (typeof filePath !== 'string' || !filePath || typeof directory !== 'string' || !directory ||
        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Invalid verified update extraction request.');
    }
    const parentStat = await lstat(directory);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Choose a real destination folder for the update.');
    const parent = await realpath(directory);
    target = path.join(parent, 'TheUnfinishedShapes-' + releaseVersion(tag) + (platform === 'darwin' ? '.app' : ''));
    appAsarPath = path.join(target, ...(platform === 'darwin' ? ['Contents', 'Resources', 'app.asar'] : ['resources', 'app.asar']));
    try { await lstat(target); throw new Error('The update destination already exists. Choose another folder.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    extraction.value = 'digest';
    await verifyDownloadedFile({ filePath, sha256 });
    extraction.value = 'preflight';
    await mkdir(target, { recursive: false, mode: 0o700 });
    targetCreated = true;
    if (spec.zip) await extractZip(filePath, target, spec, extraction, appAsarPath, platform);
    else {
      let count = 0, extractedBytes = 0;
      const appAsarRelative = path.relative(target, appAsarPath).split(path.sep).join('/');
      const stagedAsarRelative = path.posix.join(path.posix.dirname(appAsarRelative), '.tus-app-asar-' + randomUUID() + '.tmp');
      const stagedAsarPath = path.join(target, ...stagedAsarRelative.split('/'));
      let appAsarStaged = false;
      const paths = new Set();
      extraction.value = 'entry';
      await extractTar({
        file: filePath, cwd: target, strip: 1, strict: true, preservePaths: false, preserveOwner: false,
        filter: (entryPath, entry) => {
          extraction.value = 'entry';
          count++;
          if (count > maxArchiveEntries || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
              (extractedBytes += entry.size) > maxExtractedBytes) throw new Error('Update archive exceeds extraction limits.');
          const relative = safeArchiveEntryPath(entryPath, spec.root);
          if (!relative) return false;
          if (relative === stagedAsarRelative || relative.startsWith(stagedAsarRelative + '/')) {
            throw new Error('Update archive contains duplicate paths.');
          }
          if (relative.startsWith(appAsarRelative + '/')) throw new Error('Update archive contains an unsupported file type.');
          if (paths.has(relative)) throw new Error('Update archive contains duplicate paths.');
          paths.add(relative);
          const output = path.resolve(target, ...relative.split('/'));
          if (!isWithin(target, output)) throw new Error('Update archive path escapes its destination.');
          if (entry.type === 'SymbolicLink') {
            extraction.value = 'symlink';
            safeArchiveLinkTarget(entry.linkpath, path.dirname(output), target);
          }
          if (entry.type === 'Link') {
            extraction.value = 'symlink';
            safeArchiveLinkTarget(entry.linkpath, target, target);
            const linkRelative = path.posix.normalize(entry.linkpath.split('/').slice(1).join('/'));
            if (linkRelative === stagedAsarRelative) throw new Error('Update archive contains duplicate paths.');
            if (linkRelative.startsWith(appAsarRelative + '/')) throw new Error('Update archive contains an unsupported file type.');
            if (linkRelative === appAsarRelative) {
              if (relative === appAsarRelative) throw new Error('Update archive contains an unsupported file type.');
              entry.linkpath = spec.root + '/' + stagedAsarRelative;
            }
          }
          if (relative === appAsarRelative) {
            if (!['File', 'OldFile', 'ContiguousFile', 'Link'].includes(entry.type)) {
              throw new Error('Update archive contains an unsupported file type.');
            }
            if (paths.has(stagedAsarRelative)) throw new Error('Update archive contains duplicate paths.');
            paths.add(stagedAsarRelative);
            entry.path = spec.root + '/' + stagedAsarRelative;
            appAsarStaged = true;
          }
          extraction.value = 'write';
          return true;
        },
      });
      if (appAsarStaged) {
        extraction.value = 'write';
        await (electronFs?.promises?.rename ?? rename)(stagedAsarPath, appAsarPath);
      }
    }
    extraction.value = 'executable';
    const executablePath = path.join(target, ...spec.executable.split('/'));
    await access(executablePath, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return { target, executablePath };
  } catch (error) {
    if (error && typeof error === 'object') {
      const operation = classifyAppAsarOpenFailure(error, appAsarPath);
      if (operation !== 'unknown') {
        try { error.extractOperation = operation; } catch {}
      }
      try { error.extractStage = extraction.value; } catch {}
    }
    if (targetCreated) {
      extraction.value = 'cleanup';
      await (electronFs?.promises?.rm ?? rm)(target, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

