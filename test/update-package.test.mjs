import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';
import yauzl from 'yauzl';
import { createZipWriteBatcher, downloadVerifiedAsset, extractVerifiedArchive, safeArchiveEntryPath, safeUpdaterFailureCode, safeVerifierErrorType, safeVerifierSetupStage, safeZipExtractionStreamSnapshot, verifyReleaseAttestation } from '../src/update-package.mjs';

const tag = 'v0.1.0-rc11';
const asset = {
  name: 'TheUnfinishedShapes-0.1.0-rc.11-linux-x64.tar.gz',
  size: 1,
  digest: 'sha256:' + 'a'.repeat(64),
};
const sourceSha = '89d517f9dd3d015afe9bf54a2edd96641ec96ebe';

function statement(overrides = {}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      { name: asset.name, digest: { sha256: asset.digest.slice(7) } },
      { name: 'candidate-linux.json', digest: { sha256: 'b'.repeat(64) } },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: 'refs/heads/release/0.1.0-rc11',
            repository: 'https://github.com/smart-tinker/the_unfinished_shapes',
            path: '.github/workflows/stage-release.yml',
          },
        },
        resolvedDependencies: [{
          uri: 'git+https://github.com/smart-tinker/the_unfinished_shapes@refs/heads/release/0.1.0-rc11',
          digest: { gitCommit: sourceSha },
        }],
      },
      runDetails: {
        builder: {
          id: 'https://github.com/smart-tinker/the_unfinished_shapes/.github/workflows/stage-release.yml@refs/heads/release/0.1.0-rc11',
        },
      },
    },
    ...overrides,
  };
}

function bundle(value = statement()) {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { certificate: { rawBytes: 'Y2VydA==' } },
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(value)).toString('base64'),
      signatures: [{ sig: 'c2ln' }],
    },
  };
}

test('verifies the exact GitHub release workflow identity and matching asset provenance', async () => {
  let args;
  const result = await verifyReleaseAttestation({ bundle: bundle(), asset, tag }, async (...values) => {
    args = values;
    return {};
  });

  assert.equal(args[0].mediaType, 'application/vnd.dev.sigstore.bundle.v0.3+json');
  assert.deepEqual(args[1], {
    certificateIdentityURI: '^https://github\\.com/smart-tinker/the_unfinished_shapes/\\.github/workflows/stage-release\\.yml@refs/heads/release/0\\.1\\.0-rc11$',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
  });
  assert.equal(args.length, 2);
  assert.equal(result.sourceSha, sourceSha);
  assert.equal(result.assetName, asset.name);
});

test('rejects a signed statement that names another asset or workflow', async () => {
  const cases = [
    statement({ subject: [{ name: asset.name, digest: { sha256: 'c'.repeat(64) } }] }),
    statement({ predicateType: 'https://example.invalid/provenance' }),
    statement({
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: {
            ref: 'refs/heads/main',
            repository: 'https://github.com/smart-tinker/the_unfinished_shapes',
            path: '.github/workflows/stage-release.yml',
          } },
          resolvedDependencies: [{
            uri: 'git+https://github.com/smart-tinker/the_unfinished_shapes@refs/heads/main',
            digest: { gitCommit: sourceSha },
          }],
        },
        runDetails: { builder: { id: 'https://github.com/attacker/workflow.yml@refs/heads/main' } },
      },
    }),
  ];
  for (const payload of cases) {
    await assert.rejects(
      verifyReleaseAttestation({ bundle: bundle(payload), asset, tag }, async () => ({})),
      /attestation|provenance|asset/i,
    );
  }
});

test('does not accept malformed provenance or a failed cryptographic verifier', async () => {
  await assert.rejects(
    verifyReleaseAttestation({ bundle: bundle(), asset: { ...asset, digest: 'sha256:invalid' }, tag }, async () => ({})),
    /digest|asset/i,
  );
  await assert.rejects(
    verifyReleaseAttestation({ bundle: bundle(), asset, tag }, async () => { throw new Error('signature rejected'); }),
    /signature rejected/i,
  );
  const malformed = bundle();
  malformed.dsseEnvelope.payload = 'not-base64-json';
  await assert.rejects(
    verifyReleaseAttestation({ bundle: malformed, asset, tag }, async () => ({})),
    /attestation|payload|provenance/i,
  );
});

test('downloads only the exact official asset and requires its matching signed attestation', async () => {
  const bytes = Buffer.from('verified update package');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const downloadAsset = { ...asset, size: bytes.length, digest: 'sha256:' + digest };
  const signed = statement();
  signed.subject[0].digest.sha256 = digest;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tus-update-download-'));
  const calls = [];
  try {
    const result = await downloadVerifiedAsset({
      asset: downloadAsset, tag, directory: dir,
      fetcher: async (url, options) => {
        calls.push({ url, options });
        if (url.startsWith('https://github.com/')) {
          return new Response(null, { status: 302, headers: {
            location: 'https://release-assets.githubusercontent.com/package?signature=temporary',
          } });
        }
        if (url.startsWith('https://release-assets.githubusercontent.com/')) {
          return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
        }
        if (url.startsWith('https://api.github.com/')) {
          return new Response(JSON.stringify({ attestations: [{ bundle: bundle(signed) }] }), { status: 200 });
        }
        throw new Error('Unexpected destination');
      },
      verifySignature: async () => ({}),
    });

    assert.equal(await readFile(result.filePath, 'utf8'), bytes.toString());
    assert.equal(result.sha256, digest);
    assert.equal(result.sourceSha, sourceSha);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.options.redirect === 'manual' || call.url.startsWith('https://api.github.com/')));
    assert.ok(calls.some(call => call.url.includes('/attestations/sha256:')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns structured cancellation when the download request is aborted', async () => {
  const controller = new AbortController();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tus-update-cancel-'));
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  try {
    const pending = downloadVerifiedAsset({
      asset, tag, directory: dir, signal: controller.signal,
      fetcher: async (url, options) => {
        if (url.startsWith('https://github.com/')) {
          return new Response(null, { status: 302, headers: {
            location: 'https://release-assets.githubusercontent.com/package',
          } });
        }
        requestStarted();
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      },
    });
    await started;
    controller.abort();
    assert.deepEqual(await pending, { cancelled: true });
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects an untrusted redirect and removes partial update files', async () => {
  const bytes = Buffer.from('not trusted');
  const downloadAsset = { ...asset, size: bytes.length };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tus-update-redirect-'));
  try {
    await assert.rejects(downloadVerifiedAsset({
      asset: downloadAsset, tag, directory: dir,
      fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/file' } }),
      verifySignature: async () => ({}),
    }), /redirect|destination|GitHub/i);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a byte digest mismatch before asking GitHub for provenance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tus-update-digest-'));
  const progress = [];
  let attestationRequested = false;
  try {
    let caught;
    await assert.rejects(downloadVerifiedAsset({
      asset: { ...asset, size: 4 },
      tag, directory: dir,
      onProgress: event => progress.push(event),
      fetcher: async url => {
        if (url.startsWith('https://api.github.com/')) {
          attestationRequested = true;
          return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
        }
        return new Response(Buffer.from('evil'), { status: 200 });
      },
      verifySignature: async () => ({}),
    }), error => {
      caught = error;
      assert.match(error.message, /digest|integrity/i);
      assert.equal(error.failureCode, 'DIGEST_MISMATCH');
      return true;
    });
    assert.equal(safeUpdaterFailureCode(caught.failureCode), 'DIGEST_MISMATCH');
    assert.deepEqual(progress.at(-1), {
      state: 'failed', phase: 'download', failureCode: 'DIGEST_MISMATCH',
      verifierCode: 'OTHER', verifierErrorType: 'OTHER', httpStatus: null,
    });
    assert.equal(attestationRequested, false);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('maps early download guards to fixed updater failure codes', () => {
  for (const code of ['UPDATE_NOT_AVAILABLE', 'DOWNLOAD_ALREADY_RUNNING']) {
    assert.equal(safeUpdaterFailureCode(code), code);
  }
  assert.equal(safeUpdaterFailureCode('PRIVATE_PATH_TOKEN'), 'OTHER');
});

test('classifies real archive-path rejection and known file-type, size and filesystem errors without raw details', async () => {
  let pathFailure;
  assert.throws(
    () => safeArchiveEntryPath('../private-file', 'TheUnfinishedShapes-linux-x64'),
    error => { pathFailure = error; return true; },
  );
  const { safeArchiveExtractionFailureCode } = await import('../src/update-package.mjs');
  assert.equal(typeof safeArchiveExtractionFailureCode, 'function', 'extraction failures have a safe diagnostic classifier');
  const failures = [
    [pathFailure, 'ARCHIVE_PATH'],
    [new Error('Update archive contains an unsupported file type.'), 'ARCHIVE_FILE_TYPE'],
    [new Error('Update archive exceeds extraction limits.'), 'ARCHIVE_SIZE'],
    [Object.assign(new Error('/private/runner/path'), { code: 'ENOSPC', tarCode: 'TAR_ENTRY_ERROR' }), 'FILESYSTEM_SPACE'],
    [Object.assign(new Error('private tar message'), { code: 'TAR_ENTRY_ERROR', tarCode: 'TAR_ENTRY_ERROR' }), 'TAR_ENTRY_ERROR'],
    [Object.assign(new Error('private tar code'), { tarCode: 'PRIVATE_TAR_CODE' }), 'OTHER'],
    [new Error('private archive path'), 'OTHER'],
  ];
  const safeCodes = failures.map(([error]) => safeArchiveExtractionFailureCode(error));
  assert.deepEqual(safeCodes, failures.map(([, expected]) => expected));
  assert.doesNotMatch(JSON.stringify(safeCodes), /private|runner|path|PRIVATE_TAR_CODE/);
});

test('classifies ASAR open failures only for the exact app.asar output path', async () => {
  const { classifyAppAsarOpenFailure, safeArchiveExtractionOperation } = await import('../src/update-package.mjs');
  assert.equal(typeof classifyAppAsarOpenFailure, 'function', 'ASAR attribution compares the failing output path');
  assert.equal(typeof safeArchiveExtractionOperation, 'function', 'ASAR write failures have a safe operation classifier');
  const expected = path.join(os.tmpdir(), 'tus-asar-update', 'resources', 'app.asar');
  const failures = [
    [Object.assign(new Error('Invalid package ' + expected), { entry: { absolute: expected } }), null, 'asar-open-invalid-package'],
    [new Error('Invalid package ' + expected), expected, 'asar-open-invalid-package'],
    [Object.assign(new Error('Invalid package ' + expected), { entry: { absolute: expected + '.other' } }), expected, 'unknown'],
    [Object.assign(new Error('Invalid package ' + expected + '.other'), { entry: { absolute: expected } }), null, 'unknown'],
    [Object.assign(new Error('private open failure'), { entry: { absolute: expected } }), null, 'unknown'],
    [new Error('Invalid package ' + expected), null, 'unknown'],
  ];
  const operations = failures.map(([error, zipOutput]) => classifyAppAsarOpenFailure(error, expected, zipOutput));
  assert.deepEqual(operations, failures.map(([, , expectedOperation]) => expectedOperation));
  assert.equal(safeArchiveExtractionOperation({ extractOperation: operations[0] }), 'asar-open-invalid-package');
  assert.equal(safeArchiveExtractionOperation({ extractOperation: expected }), 'unknown');
  assert.doesNotMatch(JSON.stringify({ operations, safe: safeArchiveExtractionOperation({ extractOperation: operations[0] }) }), /private|runner|app\.asar/);
});

test('archive extraction refuses to replace an existing version folder', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-target-'));
  const target = path.join(parent, 'TheUnfinishedShapes-0.1.0-rc.11');
  try {
    await (await import('node:fs/promises')).mkdir(target);
    const marker = path.join(target, 'keep.txt');
    await (await import('node:fs/promises')).writeFile(marker, 'user file');
    await assert.rejects(
      extractVerifiedArchive({ filePath: path.join(parent, 'missing.zip'), directory: parent, tag, assetName: 'TheUnfinishedShapes-0.1.0-rc.11-linux-x64.tar.gz', sha256: 'a'.repeat(64), platform: 'linux' }),
      /exists|already|destination/i,
    );
    assert.equal(await readFile(marker, 'utf8'), 'user file');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


test('archive extraction keeps the macOS app bundle destination', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-macos-'));
  const target = path.join(parent, 'TheUnfinishedShapes-0.1.0-rc.11.app');
  try {
    await (await import('node:fs/promises')).mkdir(target);
    await assert.rejects(
      extractVerifiedArchive({
        filePath: path.join(parent, 'missing.zip'),
        directory: parent,
        tag,
        assetName: 'TheUnfinishedShapes-0.1.0-rc.11-darwin-arm64.zip',
        sha256: 'a'.repeat(64),
        platform: 'darwin',
      }),
      /exists|already|destination/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('archive entry paths stay under the exact package root', () => {
  assert.equal(
    safeArchiveEntryPath('TheUnfinishedShapes-win32-x64/TheUnfinishedShapes.exe', 'TheUnfinishedShapes-win32-x64'),
    'TheUnfinishedShapes.exe',
  );
  for (const name of [
    '../outside.txt',
    'TheUnfinishedShapes-win32-x64/../../outside.txt',
    'TheUnfinishedShapes-win32-x64/C:/outside.txt',
    '/TheUnfinishedShapes-win32-x64/app.exe',
    'TheUnfinishedShapes-win32-x64\\..\\outside.txt',
  ]) assert.throws(() => safeArchiveEntryPath(name, 'TheUnfinishedShapes-win32-x64'), /archive|unsafe/i);
});

test('extracts the verified Linux archive into a new version folder', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-linux-'));
  const root = path.join(parent, 'TheUnfinishedShapes-linux-x64');
  const binary = path.join(root, 'TheUnfinishedShapes');
  const archive = path.join(parent, 'linux.tar.gz');
  try {
    await mkdir(root);
    await writeFile(binary, 'linux executable fixture', { mode: 0o755 });
    await createTar({ file: archive, gzip: true, cwd: parent, portable: true }, ['TheUnfinishedShapes-linux-x64']);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const result = await extractVerifiedArchive({
      filePath: archive, directory: parent, tag,
      assetName: 'TheUnfinishedShapes-0.1.0-rc.11-linux-x64.tar.gz',
      sha256: digest, platform: 'linux',
    });
    assert.equal(result.target, path.join(await realpath(parent), 'TheUnfinishedShapes-0.1.0-rc.11'));
    assert.deepEqual(await readFile(result.executablePath), Buffer.from('linux executable fixture'));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function zipFixture(name, contents) {
  const entries = Array.isArray(name) ? name : [{ name, contents, mode: 0o100755 }];
  const localFiles = [];
  const centralFiles = [];
  let localSize = 0, directorySize = 0;
  for (const item of entries) {
    const filename = Buffer.from(item.name);
    const bytes = Buffer.from(item.contents);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((item.mode ?? 0o100755) * 0x10000, 38);
    central.writeUInt32LE(localSize, 42);
    const localFile = Buffer.concat([local, filename, bytes]);
    localFiles.push(localFile);
    centralFiles.push(Buffer.concat([central, filename]));
    localSize += localFile.length;
    directorySize += central.length + filename.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([...localFiles, ...centralFiles, end]);
}
test('extracts Windows portable and macOS app archives under the selected folder', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-zip-'));
  const cases = [
    {
      platform: 'win32',
      assetName: 'TheUnfinishedShapes-0.1.0-rc.11-win32-x64.zip',
      entry: 'TheUnfinishedShapes-win32-x64/TheUnfinishedShapes.exe',
      targetName: 'TheUnfinishedShapes-0.1.0-rc.11',
      executable: 'TheUnfinishedShapes.exe',
    },
    {
      platform: 'darwin',
      assetName: 'TheUnfinishedShapes-0.1.0-rc.11-darwin-arm64.zip',
      entry: 'TheUnfinishedShapes.app/Contents/MacOS/TheUnfinishedShapes',
      targetName: 'TheUnfinishedShapes-0.1.0-rc.11.app',
      executable: 'Contents/MacOS/TheUnfinishedShapes',
    },
  ];
  try {
    for (const item of cases) {
      const archive = path.join(parent, item.platform + '.zip');
      const payload = Buffer.from(item.platform + ' executable fixture');
      await writeFile(archive, zipFixture(item.entry, payload));
      const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
      const result = await extractVerifiedArchive({
        filePath: archive, directory: parent, tag, assetName: item.assetName, sha256: digest, platform: item.platform,
      });
      assert.equal(result.target, path.join(await realpath(parent), item.targetName));
      assert.equal(result.executablePath, path.join(await realpath(parent), item.targetName, item.executable));
      assert.deepEqual(await readFile(result.executablePath), payload);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


test('accepts ditto AppleDouble metadata without writing it outside the macOS app', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-appledouble-'));
  const archive = path.join(parent, 'macos.zip');
  const payload = Buffer.from('macOS executable fixture');
  try {
    await writeFile(archive, zipFixture([
      { name: 'TheUnfinishedShapes.app/Contents/MacOS/TheUnfinishedShapes', contents: payload, mode: 0o100755 },
      { name: '__MACOSX/', contents: Buffer.alloc(0), mode: 0o040755 },
      { name: '__MACOSX/._TheUnfinishedShapes.app', contents: Buffer.from('root AppleDouble metadata'), mode: 0o100644 },
      { name: '__MACOSX/TheUnfinishedShapes.app/Contents/MacOS/._TheUnfinishedShapes', contents: Buffer.from('file AppleDouble metadata'), mode: 0o100644 },
    ]));
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const result = await extractVerifiedArchive({
      filePath: archive, directory: parent, tag,
      assetName: 'TheUnfinishedShapes-0.1.0-rc.11-darwin-arm64.zip',
      sha256, platform: 'darwin',
    });
    assert.equal(result.target, path.join(await realpath(parent), 'TheUnfinishedShapes-0.1.0-rc.11.app'));
    assert.deepEqual(await readFile(result.executablePath), payload);
    assert.equal((await readdir(parent)).includes('__MACOSX'), false);
    assert.equal((await readdir(path.join(result.target, 'Contents', 'MacOS'))).includes('._TheUnfinishedShapes'), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('rejects traversal inside ditto AppleDouble metadata without writing outside the app', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-appledouble-path-'));
  const archive = path.join(parent, 'macos.zip');
  try {
    await writeFile(archive, zipFixture([
      { name: 'TheUnfinishedShapes.app/Contents/MacOS/TheUnfinishedShapes', contents: Buffer.from('fixture'), mode: 0o100755 },
      { name: '__MACOSX/../outside', contents: Buffer.from('must not be written'), mode: 0o100644 },
    ]));
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    let rejection;
    await assert.rejects(extractVerifiedArchive({
      filePath: archive, directory: parent, tag,
      assetName: 'TheUnfinishedShapes-0.1.0-rc.11-darwin-arm64.zip',
      sha256, platform: 'darwin',
    }), error => { rejection = error; return true; });
    assert.equal(rejection?.extractStage, 'entry');
    const names = await readdir(parent);
    assert.equal(names.includes('outside'), false);
    assert.equal(names.includes('TheUnfinishedShapes-0.1.0-rc.11.app'), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('reports terminal updater failures with safe provenance and verifier codes', async t => {
  async function expectFailure({
    responseStatus = 200, responseBody, verifySignature = async () => ({}),
    failureCode, verifierCode = 'OTHER', verifierErrorType = 'OTHER', httpStatus = null, noRawError = false,
    verifierCauseCode = null, verifierCauseErrorType = null,
  }) {
    const bytes = Buffer.from('unverified update package');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const downloadAsset = { ...asset, size: bytes.length, digest: 'sha256:' + digest };
    const provenance = statement();
    provenance.subject[0].digest.sha256 = digest;
    const body = responseBody || { attestations: [{ bundle: bundle(provenance) }] };
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tus-update-verifier-failure-'));
    const progress = [];
    const diagnostics = [];
    try {
      let caught;
      await assert.rejects(downloadVerifiedAsset({
        asset: downloadAsset, tag, directory,
        onProgress: event => progress.push(event),
        onProvenanceDiagnostic: event => diagnostics.push(event),
        fetcher: async url => {
          if (url.startsWith('https://github.com/')) {
            return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
          }
          if (url.startsWith('https://api.github.com/')) {
            return new Response(JSON.stringify(body), { status: responseStatus });
          }
          throw new Error('Unexpected destination');
        },
        verifySignature,
      }), error => { caught = error; return true; });
      assert.deepEqual(progress.at(-1), {
        state: 'failed', phase: 'provenance', failureCode, verifierCode, verifierErrorType, httpStatus,
      });
      if (verifierCauseCode !== null || verifierCauseErrorType !== null) {
        const diagnostic = diagnostics.findLast(event => event.stage === 'verify-result' && event.status === 'rejected');
        assert.equal(diagnostic?.verifierCauseCode, verifierCauseCode);
        assert.equal(diagnostic?.verifierCauseErrorType, verifierCauseErrorType);
      }
      if (noRawError) {
        assert.doesNotMatch(caught.message, /private verifier detail|private cause detail/);
        assert.doesNotMatch(JSON.stringify(diagnostics), /PrivateVerifierError|TUFError|private verifier detail|private cause detail/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  await t.test('preserves a known Sigstore verifier code', () => expectFailure({
    verifySignature: async () => { throw Object.assign(new Error('private verifier detail'), { code: 'SIGNATURE_ERROR' }); },
    failureCode: 'SIGNATURE_REJECTED', verifierCode: 'SIGNATURE_ERROR', verifierErrorType: 'GENERIC_ERROR', noRawError: true,
  }));
  await t.test('classifies Sigstore bundle validation failures without exposing their message', () => {
    class ValidationError extends Error {}
    return expectFailure({
      verifySignature: async () => { throw new ValidationError('private verifier detail'); },
      failureCode: 'SIGNATURE_REJECTED', verifierCode: 'BUNDLE_VALIDATION_ERROR', verifierErrorType: 'BUNDLE_VALIDATION_ERROR', noRawError: true,
    });
  });
  await t.test('preserves Sigstore TUF error codes without exposing details', async () => {
    for (const code of [
      'TUF_INIT_CACHE_ERROR', 'TUF_FIND_TARGET_ERROR', 'TUF_REFRESH_METADATA_ERROR',
      'TUF_DOWNLOAD_TARGET_ERROR', 'TUF_READ_TARGET_ERROR',
    ]) {
      await expectFailure({
        verifySignature: async () => { throw Object.assign(new Error('private verifier detail'), { code }); },
        failureCode: 'SIGNATURE_REJECTED', verifierCode: code, verifierErrorType: 'GENERIC_ERROR', noRawError: true,
      });
    }
  });
  await t.test('reports only known verifier error categories without exposing their messages', async () => {
    assert.equal(safeVerifierErrorType('TypeError'), 'TYPE_ERROR');
    assert.equal(safeVerifierErrorType('Error'), 'GENERIC_ERROR');
    assert.equal(safeVerifierErrorType('PrivateVerifierType'), 'OTHER');
    assert.equal(safeVerifierErrorType('Private_VerifierError'), 'OTHER');
    assert.equal(safeVerifierErrorType('A'.repeat(50) + 'Error'), 'OTHER');
    for (const [type, category] of [
      ['ASN1ParseError', 'ASN1_PARSE_ERROR'], ['ASN1TypeError', 'ASN1_TYPE_ERROR'],
      ['RFC3161TimestampVerificationError', 'RFC3161_TIMESTAMP_VERIFICATION_ERROR'],
    ]) assert.equal(safeVerifierErrorType(type), category);
    class ASN1ParseError extends Error {}
    await expectFailure({
      verifySignature: async () => { throw new ASN1ParseError('private verifier detail'); },
      failureCode: 'SIGNATURE_REJECTED', verifierErrorType: 'ASN1_PARSE_ERROR', noRawError: true,
    });
  });
  await t.test('redacts unknown verifier exception class names from progress', async () => {
    class PrivateVerifierError extends Error {}
    await expectFailure({
      verifySignature: async () => { throw new PrivateVerifierError('private verifier detail'); },
      failureCode: 'SIGNATURE_REJECTED', verifierErrorType: 'OTHER', noRawError: true,
    });
    assert.equal(safeVerifierErrorType('PrivateVerifierError'), 'OTHER');
  });
  await t.test('reports a safe verifier cause without exposing its class or message', () => {
    class PrivateVerifierError extends Error {}
    class TUFError extends Error {}
    const cause = Object.assign(new TUFError('private cause detail'), { code: 'TUF_REFRESH_METADATA_ERROR' });
    return expectFailure({
      verifySignature: async () => { throw new PrivateVerifierError('private verifier detail', { cause }); },
      failureCode: 'SIGNATURE_REJECTED', verifierCode: 'OTHER', verifierErrorType: 'OTHER',
      verifierCauseCode: 'TUF_REFRESH_METADATA_ERROR', verifierCauseErrorType: 'TUF_ERROR', noRawError: true,
    });
  });
  await t.test('maps unknown verifier codes to OTHER', () => expectFailure({
    verifySignature: async () => { throw Object.assign(new Error('private verifier detail'), { code: 'PRIVATE_CODE' }); },
    failureCode: 'SIGNATURE_REJECTED', verifierCode: 'OTHER', verifierErrorType: 'GENERIC_ERROR', noRawError: true,
  }));
  await t.test('reports provenance HTTP failures separately', () => expectFailure({
    responseStatus: 503, responseBody: {}, failureCode: 'PROVENANCE_HTTP_ERROR', httpStatus: 503,
  }));
  await t.test('reports a missing attestation separately', () => expectFailure({
    responseBody: { attestations: [] }, failureCode: 'MISSING_PROVENANCE',
  }));
  await t.test('reports a claims mismatch separately', () => {
    const mismatched = statement();
    mismatched.subject[0].digest.sha256 = 'f'.repeat(64);
    return expectFailure({
      responseBody: { attestations: [{ bundle: bundle(mismatched) }] },
      failureCode: 'ATTESTATION_MISMATCH',
    });
  });
});


test('reports package-download failures with safe codes', async t => {
  async function expectFailure(fetcher, { failureCode, httpStatus = null, noRawError = false }) {
    const bytes = Buffer.from('unverified update package');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const downloadAsset = { ...asset, size: bytes.length, digest: 'sha256:' + digest };
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tus-update-download-failure-'));
    const progress = [];
    try {
      let caught;
      await assert.rejects(downloadVerifiedAsset({
        asset: downloadAsset, tag, directory,
        onProgress: event => progress.push(event),
        fetcher,
      }), error => { caught = error; return true; });
      assert.deepEqual(progress.at(-1), {
        state: 'failed', phase: 'download', failureCode, verifierCode: 'OTHER', verifierErrorType: 'OTHER', httpStatus,
      });
      if (noRawError) assert.doesNotMatch(caught.message, /private package transport detail/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  await t.test('reports package HTTP status separately', () => expectFailure(
    async () => new Response('private package response', { status: 503 }),
    { failureCode: 'DOWNLOAD_HTTP_ERROR', httpStatus: 503 },
  ));
  await t.test('does not expose package transport errors', () => expectFailure(
    async () => { throw new Error('private package transport detail'); },
    { failureCode: 'DOWNLOAD_FETCH_ERROR', noRawError: true },
  ));
});

test('classifies verifier setup failures into safe internal stages', () => {
  function captureSetupError(run) {
    try { run(); } catch (error) { return error; }
    throw new Error('Expected the setup fixture to fail.');
  }
  function getTrustedRoot() { throw new Error('private diagnostic details'); }
  function toTrustMaterial() { throw new Error('private diagnostic details'); }
  function Verifier() { throw new Error('private diagnostic details'); }
  function createVerificationPolicy() { throw new Error('private diagnostic details'); }
  function unclassifiedSetup() { throw new Error('private diagnostic details'); }

  const tufError = captureSetupError(getTrustedRoot);
  assert.equal(safeVerifierSetupStage(tufError), 'tuf-get-trusted-root');
  tufError.code = 'TUF_REFRESH_METADATA_ERROR';
  assert.equal(safeVerifierSetupStage(tufError), 'tuf-get-trusted-root');

  const trustMaterialError = captureSetupError(toTrustMaterial);
  const verifierError = captureSetupError(() => new Verifier());
  const policyError = captureSetupError(createVerificationPolicy);
  const unknownError = captureSetupError(unclassifiedSetup);
  function messageOnlySetup() { throw new Error('toTrustMaterial'); }
  const messageOnlyError = captureSetupError(messageOnlySetup);
  const pathOnlyError = captureSetupError(unclassifiedSetup);
  pathOnlyError.stack = pathOnlyError.stack.replaceAll('update-package.test.mjs', 'toTrustMaterial.test.mjs');
  assert.equal(safeVerifierSetupStage(messageOnlyError), 'unknown');
  assert.equal(safeVerifierSetupStage(pathOnlyError), 'unknown');
  const result = [
    safeVerifierSetupStage(trustMaterialError),
    safeVerifierSetupStage(verifierError),
    safeVerifierSetupStage(policyError),
    safeVerifierSetupStage(unknownError),
  ];

  assert.deepEqual(result, [
    'trust-material', 'verifier-construction', 'verification-policy', 'unknown',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic details|unclassifiedSetup/);
});
test('distinguishes target metadata search from refresh only by its own frame', async () => {
  const { safeVerifierSetupStep } = await import('../src/update-package.mjs');
  assert.equal(typeof safeVerifierSetupStep, 'function');

  function captureSetupError(run) {
    try { run(); } catch (error) { return error; }
    throw new Error('Expected the TUF setup fixture to fail.');
  }

  let metadataSearchError;
  {
    function preorderDepthFirstWalk() { throw new Error('private diagnostic details'); }
    function getTargetInfo() { return preorderDepthFirstWalk(); }
    function getTrustedRoot() { return getTargetInfo(); }
    metadataSearchError = captureSetupError(getTrustedRoot);
  }
  assert.equal(safeVerifierSetupStep(metadataSearchError), 'tuf-target-metadata-search');
  metadataSearchError.code = 'TUF_REFRESH_METADATA_ERROR';
  assert.equal(safeVerifierSetupStep(metadataSearchError), 'tuf-target-metadata-search');

  let refreshError;
  {
    function refresh() { throw new Error('private diagnostic details'); }
    function getTargetInfo() { return refresh(); }
    function getTrustedRoot() { return getTargetInfo(); }
    refreshError = captureSetupError(getTrustedRoot);
  }
  assert.equal(safeVerifierSetupStep(refreshError), 'tuf-metadata-refresh');

  let rootOnlyError;
  {
    function getTrustedRoot() { throw new Error('private diagnostic details'); }
    rootOnlyError = captureSetupError(getTrustedRoot);
  }
  assert.equal(safeVerifierSetupStep(rootOnlyError), 'unknown');
});

test('extracts TAR app.asar when Electron rejects a direct archive write', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-asar-tar-'));
  const root = path.join(parent, 'TheUnfinishedShapes-linux-x64');
  const resources = path.join(root, 'resources');
  const archive = path.join(parent, 'linux.tar.gz');
  const payload = Buffer.from('verified app.asar fixture');
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(root, 'TheUnfinishedShapes'), 'Linux executable fixture', { mode: 0o755 });
    await writeFile(path.join(resources, 'app.asar'), payload);
    await createTar({ file: archive, gzip: true, cwd: parent, portable: true }, ['TheUnfinishedShapes-linux-x64']);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const childSource = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const open = fs.open;",
      "fs.open = function (file, ...args) {",
      "  if (typeof file === 'string' && path.basename(file) === 'app.asar') {",
      "    const callback = args.at(-1);",
      "    queueMicrotask(() => callback(new Error('Invalid package ' + file)));",
      "    return;",
      "  }",
      "  return open.call(fs, file, ...args);",
      "};",
      "syncBuiltinESMExports();",
      "const [moduleUrl, filePath, directory, tag, assetName, sha256, platform] = process.argv.slice(1);",
      "const { extractVerifiedArchive } = await import(moduleUrl);",
      "try {",
      "  await extractVerifiedArchive({ filePath, directory, tag, assetName, sha256, platform });",
      "  process.stdout.write('success');",
      "} catch (error) {",
      "  process.stdout.write(error?.extractOperation === 'asar-open-invalid-package' ? 'asar-open-invalid-package' : 'other');",
      "  process.exitCode = 1;",
      "}",
    ].join('\n');
    const child = spawnSync(process.execPath, [
      '--input-type=module', '-e', childSource,
      new URL('../src/update-package.mjs', import.meta.url).href,
      archive, parent, tag, asset.name, sha256, 'linux',
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.stdout, 'success', 'the verified app.asar must survive the Electron ASAR open boundary');
    assert.equal(child.status, 0);
    const target = path.join(parent, 'TheUnfinishedShapes-0.1.0-rc.11');
    const extractedAsar = path.join(target, 'resources', 'app.asar');
    assert.deepEqual(await readFile(extractedAsar), payload);
    assert.equal((await lstat(extractedAsar)).isFile(), true);
    assert.deepEqual(await readdir(path.join(target, 'resources')), ['app.asar']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});



test('removes a materialized update target with Electron original-fs after a later failure', async () => {
  const electronExecutable = createRequire(import.meta.url)('electron');
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-asar-cleanup-'));
  const root = path.join(parent, 'TheUnfinishedShapes-linux-x64');
  const resources = path.join(root, 'resources');
  const archive = path.join(parent, 'linux.tar.gz');
  const target = path.join(parent, 'TheUnfinishedShapes-0.1.0-rc.11');
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(resources, 'app.asar'), Buffer.from('verified app.asar fixture'));
    await createTar({ file: archive, gzip: true, cwd: parent, portable: true }, ['TheUnfinishedShapes-linux-x64']);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const childSource = [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const wrappedRm = fs.promises.rm;",
      "let intercepted = false;",
      "fs.promises.rm = async (target, options) => {",
      "  if (typeof target === 'string' && target.endsWith('TheUnfinishedShapes-0.1.0-rc.11')) {",
      "    intercepted = true;",
      "    return;",
      "  }",
      "  return wrappedRm(target, options);",
      "};",
      "syncBuiltinESMExports();",
      "const { rm: testRm } = await import('node:fs/promises');",
      "const [moduleUrl, filePath, directory, tag, assetName, sha256, target] = process.argv.slice(1);",
      "await testRm(target, { recursive: true, force: true });",
      "if (!intercepted) { process.stdout.write('control-failed'); process.exitCode = 2; }",
      "else {",
      "  intercepted = false;",
      "  const { extractVerifiedArchive } = await import(moduleUrl);",
      "  try {",
      "    await extractVerifiedArchive({ filePath, directory, tag, assetName, sha256, platform: 'linux' });",
      "    process.stdout.write('unexpected-success');",
      "  } catch (error) {",
      "    let targetExists = false;",
      "    try { await fs.promises.lstat(target); targetExists = true; } catch {}",
      "    process.stdout.write(error?.code === 'ENOENT' && error?.extractStage === 'executable' ? targetExists ? 'target-left' : 'cleaned' : 'original-error-changed');",
      "  }",
      "}",
    ].join(String.fromCharCode(10));
    const child = spawnSync(electronExecutable, [
      '--input-type=module', '-e', childSource,
      new URL('../src/update-package.mjs', import.meta.url).href,
      archive, parent, tag, asset.name, sha256, target,
    ], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.equal(child.status, 0, 'the Electron cleanup boundary control ran');
    assert.equal(child.stdout, 'cleaned', 'a post-materialization error removes the target and stays intact');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


test('ZIP stream snapshots identify the current archive entry without its name', () => {
  const snapshot = safeZipExtractionStreamSnapshot(
    { readableEnded: false, fileName: 'private-entry-name' },
    { writableFinished: false, closed: false, bytesWritten: 233242624, writableLength: 16384, path: 'C:/private/path' },
    17,
  );
  const unsafe = safeZipExtractionStreamSnapshot(
    { readableEnded: false },
    { writableFinished: false, closed: false, bytesWritten: 8, writableLength: 0 },
    'C:/private/path',
  );

  assert.deepEqual(snapshot, {
    entrySequence: 17,
    compression: 'unknown',
    entryCompressedSize: null,
    entryUncompressedSize: null,
    compressedBytesRead: null,
    decodedBytes: null,
    sourceReadableEnded: false,
    sinkWritableFinished: false,
    sinkClosed: false,
    sinkBytesWritten: 233242624,
    sinkWritableLength: 16384,
  });
  assert.equal(unsafe.entrySequence, null);
  assert.doesNotMatch(JSON.stringify([snapshot, unsafe]), /private-entry-name|C:\/private\/path/);
});

test('Windows ZIP extraction uses bounded larger compressed reads', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-win-read-'));
  const archive = path.join(parent, 'windows.zip');
  const entryName = 'TheUnfinishedShapes-win32-x64/TheUnfinishedShapes.exe';
  const payload = Buffer.from('Windows executable fixture');
  const originalOpenPromise = yauzl.openPromise;
  let compressedReadHighWaterMark = null;
  try {
    await writeFile(archive, zipFixture(entryName, payload));
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    yauzl.openPromise = async (...args) => {
      const zip = await originalOpenPromise(...args);
      const reader = zip.reader;
      const createReadStream = reader.createReadStream;
      reader.createReadStream = function (options) {
        const stream = createReadStream.call(this, options);
        compressedReadHighWaterMark = stream.readableHighWaterMark;
        return stream;
      };
      return zip;
    };
    const result = await extractVerifiedArchive({
      filePath: archive,
      directory: parent,
      tag,
      assetName: 'TheUnfinishedShapes-0.1.0-rc.11-win32-x64.zip',
      sha256,
      platform: 'win32',
    });
    assert.deepEqual(await readFile(result.executablePath), payload);
    assert.equal(compressedReadHighWaterMark, 256 * 1024);
  } finally {
    yauzl.openPromise = originalOpenPromise;
    await rm(parent, { recursive: true, force: true });
  }
});


test('smoke-only ENOSPC after one completed target write cleans extraction and permits same-asset retry', async () => {
  const electronExecutable = createRequire(import.meta.url)('electron');
  const parent = await mkdtemp(path.join(os.tmpdir(), 'tus-update-enospc-'));
  const archive = path.join(parent, 'windows.zip');
  const archiveRoot = 'TheUnfinishedShapes-win32-x64';
  const target = path.join(parent, 'TheUnfinishedShapes-0.1.0-rc.11');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  const executable = Buffer.from('verified executable fixture');
  const request = {
    filePath: archive,
    directory: parent,
    tag,
    assetName: 'TheUnfinishedShapes-0.1.0-rc.11-win32-x64.zip',
    sha256: '',
    platform: 'win32',
  };

  try {
    await writeFile(archive, zipFixture([
      { name: archiveRoot + '/resources/app.asar', contents: payload, mode: 0o100644 },
      { name: archiveRoot + '/TheUnfinishedShapes.exe', contents: executable, mode: 0o100755 },
    ]));
    request.sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const childSource = [
      "process.argv.push('--tus-smoke-provenance-diagnostic');",
      "const control = { state: 'armed', firstChunkWritten: false };",
      "globalThis.__tusUpdaterSmokeBoundary = { downloadVerifiedAsset: 'fulfilled', writeFailureControl: control };",
      "const [moduleUrl, requestJSON] = process.argv.slice(1);",
      "const request = JSON.parse(requestJSON);",
      "const target = path.join(request.directory, 'TheUnfinishedShapes-0.1.0-rc.11');",
      "const updater = await import(moduleUrl);",
      "let failure;",
      "try { await updater.extractVerifiedArchive(request); } catch (error) { failure = error; }",
      "const targetRemoved = await lstat(target).then(() => false, error => error.code === 'ENOENT');",
      "let retrySucceeded = false;",
      "if (failure && control.state === 'injected' && targetRemoved) {",
      "  control.state = 'disabled';",
      "  const retry = await updater.extractVerifiedArchive(request);",
      "  retrySucceeded = (await readFile(retry.executablePath)).equals(Buffer.from('verified executable fixture'));",
      "}",
      "process.stdout.write(JSON.stringify({",
      "  status: failure ? 'rejected' : 'fulfilled',",
      "  failureCode: failure ? updater.safeArchiveExtractionFailureCode(failure) : null,",
      "  extractStage: failure ? updater.safeArchiveExtractionStage(failure) : null,",
      "  controlState: control.state,",
      "  firstChunkWritten: control.firstChunkWritten,",
      "  targetRemoved,",
      "  retrySucceeded,",
      "}));",
    ].join(String.fromCharCode(10));
    const child = spawnSync(electronExecutable, [
      '--input-type=module', '-e',
      "import path from 'node:path'; import { lstat, readFile } from 'node:fs/promises';\n" + childSource,
      new URL('../src/update-package.mjs', import.meta.url).href,
      JSON.stringify(request),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    assert.equal(child.status, 0, 'the Electron extraction probe completed');
    assert.deepEqual(JSON.parse(child.stdout), {
      status: 'rejected',
      failureCode: 'FILESYSTEM_SPACE',
      extractStage: 'write',
      controlState: 'disabled',
      firstChunkWritten: true,
      targetRemoved: true,
      retrySucceeded: true,
    }, 'a one-shot post-write ENOSPC removes the partial target and allows retry of the same verified archive');
    assert.deepEqual(await readFile(path.join(target, 'resources', 'app.asar')), payload);
    assert.deepEqual(await readFile(path.join(target, 'TheUnfinishedShapes.exe')), executable);
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), request.sha256);
    assert.deepEqual((await readdir(parent)).sort(), ['TheUnfinishedShapes-0.1.0-rc.11', 'windows.zip']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


test('ZIP write batcher preserves bytes and uses only the requested bounded batch size', async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  const chunksFor = async batchBytes => {
    const chunks = [];
    const stream = batchBytes === null ? createZipWriteBatcher() : createZipWriteBatcher(batchBytes);
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await new Promise((resolve, reject) => {
      stream.once('error', reject);
      stream.once('end', resolve);
      stream.end(payload);
    });
    return chunks;
  };
  const defaultChunks = await chunksFor(null);
  const productionChunks = await chunksFor(256 * 1024);
  const largerChunks = await chunksFor(1024 * 1024);

  assert.deepEqual(defaultChunks.map(chunk => chunk.length), [...Array(8).fill(256 * 1024), 17]);
  assert.deepEqual(productionChunks.map(chunk => chunk.length), [...Array(8).fill(256 * 1024), 17]);
  assert.deepEqual(largerChunks.map(chunk => chunk.length), [1024 * 1024, 1024 * 1024, 17]);
  assert.deepEqual(Buffer.concat(defaultChunks), payload);
  assert.deepEqual(Buffer.concat(productionChunks), payload);
  assert.deepEqual(Buffer.concat(largerChunks), payload);
  assert.throws(() => createZipWriteBatcher(2 * 1024 * 1024), /Invalid ZIP write batch size/);
});
