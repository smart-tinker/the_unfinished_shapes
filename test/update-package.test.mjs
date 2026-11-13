import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';
import { downloadVerifiedAsset, extractVerifiedArchive, safeArchiveEntryPath, verifyReleaseAttestation } from '../src/update-package.mjs';

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
  let attestationRequested = false;
  try {
    await assert.rejects(downloadVerifiedAsset({
      asset: { ...asset, size: 4 },
      tag, directory: dir,
      fetcher: async url => {
        if (url.startsWith('https://api.github.com/')) {
          attestationRequested = true;
          return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
        }
        return new Response(Buffer.from('evil'), { status: 200 });
      },
      verifySignature: async () => ({}),
    }), /digest|integrity/i);
    assert.equal(attestationRequested, false);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(0o100755 * 0x10000, 38);
  const localSize = local.length + filename.length + contents.length;
  const directorySize = central.length + filename.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, filename, contents, central, filename, end]);
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
