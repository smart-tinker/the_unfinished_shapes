import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, rm, symlink, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar } from 'tar';
import yauzl from 'yauzl';
import { verify } from 'sigstore';
import { parseReleaseTag } from './update-release.mjs';

const repository = 'smart-tinker/the_unfinished_shapes';
const repositoryUrl = 'https://github.com/' + repository;
const maxAssetBytes = 500_000_000;
const maxJsonBytes = 2_000_000;
const maxExtractedBytes = 1_073_741_824;
const maxArchiveEntries = 20_000;
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
  if (!response.body) throw new Error('Empty GitHub provenance response.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxJsonBytes) throw new Error('GitHub provenance response is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid GitHub provenance response.'); }
}

function exactRegex(value) {
  return '^' + value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&') + '$';
}

export async function verifyReleaseAttestation({ bundle, asset, tag }, verifySignature = verify) {
  const digest = validateAsset(asset, tag);
  if (!bundle || typeof verifySignature !== 'function') throw new Error('Invalid release attestation.');
  const releaseBranch = 'refs/heads/release/' + tag.replace(/^v/, '');
  const identity = repositoryUrl + '/.github/workflows/stage-release.yml@' + releaseBranch;
  try {
    await verifySignature(bundle, {
      certificateIdentityURI: exactRegex(identity),
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    });
  } catch (error) {
    throw new Error('Release attestation signature rejected: ' + String(error?.message || error).slice(0, 300));
  }
  const envelope = bundle.dsseEnvelope;
  if (bundle.mediaType !== 'application/vnd.dev.sigstore.bundle.v0.3+json' ||
      envelope?.payloadType !== 'application/vnd.in-toto+json' ||
      typeof envelope.payload !== 'string' || envelope.payload.length > maxJsonBytes * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload)) {
    throw new Error('Invalid release attestation payload.');
  }
  let statement;
  try { statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')); }
  catch { throw new Error('Invalid release attestation payload.'); }
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
    throw new Error('Release attestation does not match this asset and release workflow.');
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

async function fetchAttestation({ fetcher, digest, tag, asset, signal, verifySignature }) {
  const response = await fetcher('https://api.github.com/repos/' + repository + '/attestations/sha256:' + digest, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal, redirect: 'error',
  });
  if (!response?.ok) throw new Error('GitHub release provenance check failed (HTTP ' + response?.status + ').');
  const body = await readJsonLimited(response);
  if (!Array.isArray(body?.attestations) || body.attestations.length < 1 || body.attestations.length > 20) {
    throw new Error('No GitHub release provenance was found.');
  }
  let lastError;
  for (const item of body.attestations) {
    if (!item?.bundle) continue;
    try { return await verifyReleaseAttestation({ bundle: item.bundle, asset, tag }, verifySignature); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error('No matching GitHub release provenance was found.');
}

export async function downloadVerifiedAsset({
  asset, tag, directory, fetcher = fetch, signal, verifySignature = verify, onProgress = () => {},
}) {
  const digest = validateAsset(asset, tag);
  if (typeof directory !== 'string' || !directory || typeof fetcher !== 'function' || typeof onProgress !== 'function') {
    throw new Error('Invalid updater download request.');
  }
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = path.join(directory, digest + '-' + asset.name);
  let created = false;
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
        response = await fetcher(currentUrl, {
          headers: { accept: 'application/octet-stream' }, signal: requestSignal, redirect: 'manual',
        });
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
        if (!response.ok) throw new Error('GitHub update download failed (HTTP ' + response.status + ').');
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
        if (received !== asset.size || hash.digest('hex') !== digest) throw new Error('Release asset SHA-256 integrity check failed.');
        await verifyDownloadedFile({ filePath: partPath, sha256: digest });
        await rename(partPath, finalPath);
        partPath = null;
        created = true;
        break;
      }
      if (!created) throw new Error('GitHub did not provide the requested release asset.');
    }
    const provenance = await fetchAttestation({ fetcher, digest, tag, asset, signal: requestSignal, verifySignature });
    onProgress({ received: asset.size, total: asset.size, verified: true });
    return { filePath: finalPath, sha256: digest, size: asset.size, sourceSha: provenance.sourceSha, assetName: asset.name };
  } catch (error) {
    if (partPath) await rm(partPath, { force: true }).catch(() => {});
    if (created) await rm(finalPath, { force: true }).catch(() => {});
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

async function extractZip(filePath, destination, spec) {
  const zip = await yauzl.openPromise(filePath, { strictFileNames: true, validateEntrySizes: true });
  let count = 0, extractedBytes = 0;
  for await (const entry of zip.eachEntry()) {
    count++;
    if (count > maxArchiveEntries || !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 || (extractedBytes += entry.uncompressedSize) > maxExtractedBytes) {
      throw new Error('Update archive exceeds extraction limits.');
    }
    const relative = safeArchiveEntryPath(entry.fileName, spec.root);
    if (!relative) continue;
    const output = path.resolve(destination, ...relative.split('/'));
    if (!isWithin(destination, output)) throw new Error('Update archive path escapes its destination.');
    const directory = entry.fileName.endsWith('/');
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (directory || mode === 0o040000) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      continue;
    }
    if (mode !== 0 && mode !== 0o100000 && mode !== 0o120000) throw new Error('Update archive contains an unsupported file type.');
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    if (mode === 0o120000) {
      if (process.platform === 'win32' || entry.uncompressedSize > 4096) throw new Error('Update archive contains an unsupported link.');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const target = Buffer.concat(chunks).toString('utf8');
      safeArchiveLinkTarget(target, path.dirname(output), destination);
      await symlink(target, output);
      continue;
    }
    const stream = await zip.openReadStreamPromise(entry);
    const fileMode = ((entry.externalFileAttributes >>> 16) & 0o777) || 0o600;
    await pipeline(stream, createWriteStream(output, { flags: 'wx', mode: fileMode }));
  }
}

export async function extractVerifiedArchive({ filePath, directory, tag, assetName, sha256, platform = process.platform }) {
  const spec = platformArchive(platform, assetName, tag);
  if (typeof filePath !== 'string' || !filePath || typeof directory !== 'string' || !directory ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid verified update extraction request.');
  }
  const parentStat = await lstat(directory);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Choose a real destination folder for the update.');
  const parent = await realpath(directory);
  const target = path.join(parent, 'TheUnfinishedShapes-' + releaseVersion(tag) + (platform === 'darwin' ? '.app' : ''));
  try { await lstat(target); throw new Error('The update destination already exists. Choose another folder.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await verifyDownloadedFile({ filePath, sha256 });
  await mkdir(target, { recursive: false, mode: 0o700 });
  try {
    if (spec.zip) await extractZip(filePath, target, spec);
    else {
      let count = 0, extractedBytes = 0;
      const paths = new Set();
      await extractTar({
        file: filePath, cwd: target, strip: 1, strict: true, preservePaths: false, preserveOwner: false,
        filter: (entryPath, entry) => {
          count++;
          if (count > maxArchiveEntries || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
              (extractedBytes += entry.size) > maxExtractedBytes) throw new Error('Update archive exceeds extraction limits.');
          const relative = safeArchiveEntryPath(entryPath, spec.root);
          if (!relative) return false;
          if (paths.has(relative)) throw new Error('Update archive contains duplicate paths.');
          paths.add(relative);
          const output = path.resolve(target, ...relative.split('/'));
          if (!isWithin(target, output)) throw new Error('Update archive path escapes its destination.');
          if (entry.type === 'SymbolicLink') safeArchiveLinkTarget(entry.linkpath, path.dirname(output), target);
          if (entry.type === 'Link') safeArchiveLinkTarget(entry.linkpath, target, target);
          return true;
        },
      });
    }
    const executablePath = path.join(target, ...spec.executable.split('/'));
    await access(executablePath, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return { target, executablePath };
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
