import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType,
  verifyDownloadedFile, verifyReleaseAttestation,
} from '../src/update-package.mjs';

const repository = 'smart-tinker/the_unfinished_shapes';
const tag = 'v0.1.0-rc11';
const assetName = 'TheUnfinishedShapes-0.1.0-rc.11-darwin-arm64.zip';
const assetSha256 = '14c5c9d106f740b3d9e50f637d67fec914c8e82a53825a6836568252ded33d12';
const assetSize = 128482441;
const bundleSha256 = '8b41b54ca2688957bfdfa9a8476cde6d7d8e57bd613bdda9f9fc4729460fc0bf';
const assetUrl = 'https://github.com/' + repository + '/releases/download/' + tag + '/' + encodeURIComponent(assetName);
const attestationUrl = 'https://api.github.com/repos/' + repository + '/attestations/sha256:' + assetSha256;
const allowedHosts = new Set([
  'github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
]);

assert.equal(process.platform, 'darwin', 'the pinned verifier control runs on native macOS');
assert.equal(process.arch, 'arm64', 'the pinned verifier control uses the published macOS target');
assert.equal(process.env.CI, 'true', 'the pinned verifier control runs in GitHub Actions');
assert.ok(process.env.RUNNER_OS, 'the pinned verifier control is runner-only');
assert.ok(process.env.GITHUB_TOKEN, 'the runner can read the public release attestation');
const executable = path.resolve(process.env.TUS_SMOKE_EXECUTABLE || '');
assert.ok(process.env.TUS_SMOKE_EXECUTABLE, 'the packaged candidate executable is required');
await access(executable);

async function fetchBounded(url, options, label, maxBytes) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error(label + ' request failed.'); }
  if (!response.ok) throw new Error(label + ' request failed (HTTP ' + response.status + ').');
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(label + ' response exceeded its size limit.');
  try { return JSON.parse(text); }
  catch { throw new Error(label + ' response was invalid.'); }
}

async function trustRootInfo() {
  const rootPath = path.join(
    os.homedir(), 'Library', 'Application Support', 'sigstore-js',
    encodeURIComponent('tuf-repo-cdn.sigstore.dev'), 'targets', 'trusted_root.json',
  );
  try {
    const bytes = await readFile(rootPath);
    return { available: true, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { available: false, sha256: null };
  }
}

async function downloadPinnedAsset(filePath) {
  let currentUrl = assetUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetch(currentUrl, {
        headers: { accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(120000),
        redirect: 'manual',
      });
    } catch {
      throw new Error('Pinned RC11 asset download failed.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('Pinned RC11 asset redirect was unavailable.');
      let next;
      try { next = new URL(location, currentUrl); }
      catch { throw new Error('Pinned RC11 asset redirect was invalid.'); }
      if (next.protocol !== 'https:' || !allowedHosts.has(next.hostname) || next.username || next.password) {
        throw new Error('Pinned RC11 asset redirected outside trusted GitHub hosts.');
      }
      currentUrl = next.href;
      continue;
    }
    if (!response.ok || !response.body || !allowedHosts.has(new URL(currentUrl).hostname)) {
      throw new Error('Pinned RC11 asset response was invalid (HTTP ' + response.status + ').');
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== assetSize) throw new Error('Pinned RC11 asset size did not match.');
    let received = 0;
    const hash = createHash('sha256');
    async function* source() {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > assetSize) throw new Error('Pinned RC11 asset exceeded its published size.');
        hash.update(chunk);
        yield chunk;
      }
    }
    await pipeline(source(), createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
    assert.equal(received, assetSize, 'the pinned RC11 asset byte count matches the release manifest');
    assert.equal(hash.digest('hex'), assetSha256, 'the pinned RC11 asset matches its published SHA-256');
    await verifyDownloadedFile({ filePath, sha256: assetSha256 });
    return;
  }
  throw new Error('Pinned RC11 asset redirect limit was reached.');
}

const manifestUrl = 'https://github.com/' + repository + '/releases/download/' + tag + '/candidate-macos.json';
const manifest = await fetchBounded(manifestUrl, { signal: AbortSignal.timeout(15000) }, 'Pinned RC11 manifest', 16384);
assert.equal(manifest.repository, repository);
assert.equal(manifest.tag, tag);
assert.equal(manifest.platform, 'macos');
const manifestFile = manifest.files?.find(file => file?.name === assetName);
assert.ok(manifestFile, 'the pinned macOS RC11 asset is in the published manifest');
assert.equal(manifestFile.size, assetSize);
assert.equal(manifestFile.sha256, assetSha256);

const token = process.env.GITHUB_TOKEN;
const attestationBody = await fetchBounded(attestationUrl, {
  headers: {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    authorization: 'Bearer ' + token,
  },
  signal: AbortSignal.timeout(15000),
  redirect: 'error',
}, 'Pinned RC11 attestation', 2000000);
const bundles = (Array.isArray(attestationBody.attestations) ? attestationBody.attestations : [])
  .flatMap((item, index) => item?.bundle ? [{
    index, bundle: item.bundle,
    sha256: createHash('sha256').update(JSON.stringify(item.bundle)).digest('hex'),
  }] : []);
const matchingBundles = bundles.filter(item => item.sha256 === bundleSha256);
assert.equal(matchingBundles.length, 1, 'the official RC11 attestation matches the independently recorded bundle digest');
const pinned = matchingBundles[0];
const asset = {
  name: assetName, size: assetSize, digest: 'sha256:' + assetSha256,
  browser_download_url: assetUrl,
};

const workDir = await mkdtemp(path.join(os.tmpdir(), 'tus-pinned-verifier-'));
const dataDir = path.join(workDir, 'data');
const cacheDir = path.join(workDir, 'update-cache');
await Promise.all([mkdir(dataDir), mkdir(cacheDir)]);
const cachedAssetPath = path.join(cacheDir, assetSha256 + '-' + assetName);
let instance;
try {
  await downloadPinnedAsset(cachedAssetPath);
  const appEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|AUTH)/i.test(name)));
  appEnv.TUS_DATA_DIR = dataDir;
  instance = await electron.launch({
    executablePath: executable,
    args: ['--tus-smoke-provenance-diagnostic'],
    env: appEnv,
    timeout: 45000,
  });
  await instance.firstWindow();
  const electronMain = await instance.evaluate(async ({ app }, input) => {
    const path = process.getBuiltinModule('node:path');
    const os = process.getBuiltinModule('node:os');
    const fs = process.getBuiltinModule('node:fs/promises');
    const crypto = process.getBuiltinModule('node:crypto');
    const { pathToFileURL } = process.getBuiltinModule('node:url');
    const events = [];
    let fetchCount = 0;
    const rootPath = path.join(
      os.homedir(), 'Library', 'Application Support', 'sigstore-js',
      encodeURIComponent('tuf-repo-cdn.sigstore.dev'), 'targets', 'trusted_root.json',
    );
    const rootInfo = async () => {
      try {
        const bytes = await fs.readFile(rootPath);
        return { available: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      } catch {
        return { available: false, sha256: null };
      }
    };
    if (!app.isPackaged) return { moduleStatus: 'not-packaged', fetchCount, events };
    let updatePackage;
    try {
      const moduleUrl = pathToFileURL(path.join(app.getAppPath(), 'src', 'update-package.mjs')).href;
      updatePackage = await import(moduleUrl);
    } catch {
      return { moduleStatus: 'import-rejected', fetchCount, events };
    }
    const safeEvent = async item => {
      const stage = ['verify-start', 'verify-result', 'verifier-setup', 'verifier-verify'].includes(item?.stage)
        ? item.stage : 'unknown';
      const status = ['starting', 'ready', 'verified', 'rejected'].includes(item?.status)
        ? item.status : 'unknown';
      const value = {
        bundleIndex: Number.isInteger(item?.bundleIndex) ? item.bundleIndex : null,
        bundleSha256: typeof item?.bundleSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.bundleSha256) ? item.bundleSha256 : null,
        stage, status,
        assetMatches: item?.assetName === input.asset.name &&
          item?.assetSha256 === input.asset.digest.slice(7) && item?.tag === input.tag,
        trustedRootTarget: await rootInfo(),
      };
      if (status === 'rejected') {
        value.failureCode = updatePackage.safeUpdaterFailureCode(item.failureCode);
        value.verifierCode = updatePackage.safeVerifierCode(item.verifierCode, item.verifierErrorType);
        value.verifierErrorType = updatePackage.safeVerifierErrorType(item.verifierErrorType);
        value.verifierCauseCode = updatePackage.safeVerifierCode(item.verifierCauseCode);
        value.verifierCauseErrorType = updatePackage.safeVerifierErrorType(item.verifierCauseErrorType);
      }
      return value;
    };
    let outcome;
    try {
      const result = await updatePackage.downloadVerifiedAsset({
        asset: input.asset,
        tag: input.tag,
        directory: input.cacheDir,
        fetcher: async requestUrl => {
          fetchCount++;
          if (String(requestUrl) !== input.attestationUrl) throw new Error('Unexpected pinned diagnostic request.');
          return new Response(JSON.stringify({ attestations: [{ bundle: input.bundle }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        },
        onProvenanceDiagnostic: async item => events.push(await safeEvent(item)),
      });
      outcome = {
        status: 'verified',
        assetName: result.assetName,
        sha256: result.sha256,
        sourceSha: result.sourceSha,
      };
    } catch (error) {
      outcome = {
        status: 'rejected',
        failureCode: updatePackage.safeUpdaterFailureCode(error?.failureCode),
        verifierCode: updatePackage.safeVerifierCode(error?.code, error?.verifierErrorType),
        verifierErrorType: updatePackage.safeVerifierErrorType(error?.verifierErrorType),
        verifierCauseCode: updatePackage.safeVerifierCode(error?.verifierCauseCode),
        verifierCauseErrorType: updatePackage.safeVerifierErrorType(error?.verifierCauseErrorType),
      };
    }
    return { moduleStatus: 'ready', fetchCount, outcome, events };
  }, {
    tag, asset, bundle: pinned.bundle, attestationUrl, cacheDir,
  });

  const nodeRootBefore = await trustRootInfo();
  let node;
  try {
    const result = await verifyReleaseAttestation({ bundle: pinned.bundle, asset, tag });
    node = { status: 'verified', assetName: result.assetName, sourceSha: result.sourceSha };
  } catch (error) {
    node = {
      status: 'rejected',
      failureCode: safeUpdaterFailureCode(error?.failureCode),
      verifierCode: safeVerifierCode(error?.code, error?.verifierErrorType),
      verifierErrorType: safeVerifierErrorType(error?.verifierErrorType),
      verifierCauseCode: safeVerifierCode(error?.verifierCauseCode),
      verifierCauseErrorType: safeVerifierErrorType(error?.verifierCauseErrorType),
    };
  }
  const nodeRootAfter = await trustRootInfo();
  const evidence = {
    tag, assetName, assetSize, assetSha256,
    bundleIndex: pinned.index, bundleSha256,
    electronMain,
    node: { ...node, trustedRootTarget: { before: nodeRootBefore, after: nodeRootAfter } },
  };
  console.log('TUS_PINNED_VERIFIER_DIAGNOSTIC ' + JSON.stringify(evidence));

  assert.equal(electronMain.moduleStatus, 'ready', 'the packaged Electron main process imports the existing updater helper');
  assert.equal(electronMain.fetchCount, 1, 'the packaged updater consumes the one pinned official attestation');
  assert.equal(node.status, 'verified', 'Node verifies the exact pinned RC11 bundle with the same release policy');
  const mainBundleEvents = electronMain.events.filter(event => event.bundleSha256 === bundleSha256 && event.assetMatches);
  assert.equal(mainBundleEvents.filter(event => event.stage === 'verify-start').length, 1, 'Electron attempts exactly this bundle once');
  const setupStartCount = mainBundleEvents.filter(event => event.stage === 'verifier-setup' && event.status === 'starting').length;
  assert.equal(setupStartCount, 1, 'Electron reports one verifier setup attempt');
  const setupResults = mainBundleEvents.filter(event => event.stage === 'verifier-setup' && ['ready', 'rejected'].includes(event.status));
  assert.equal(setupResults.length, 1, 'Electron reports the verifier setup result');
  const verifyEvents = mainBundleEvents.filter(event => event.stage === 'verifier-verify');
  if (setupResults[0].status === 'ready') {
    assert.equal(verifyEvents.filter(event => event.status === 'starting').length, 1, 'bundle verification starts only after setup succeeds');
    assert.equal(verifyEvents.filter(event => ['verified', 'rejected'].includes(event.status)).length, 1, 'Electron reports the bundle verification result');
  } else {
    assert.equal(verifyEvents.length, 0, 'bundle verification does not start when verifier setup fails');
  }
  assert.equal(electronMain.outcome.status, 'verified', 'the packaged Electron updater accepts the pinned official RC11 attestation');
} finally {
  if (instance) {
    const child = instance.process();
    await Promise.race([
      instance.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
