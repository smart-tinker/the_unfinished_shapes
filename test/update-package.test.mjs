import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { downloadVerifiedAsset, extractVerifiedArchive, safeArchiveEntryPath, verifyReleaseAttestation } from '../src/update-package.mjs';

const tag = 'v0.1.0-rc11';
const asset = {
  name: 'TheUnfinishedShapes-0.1.0-rc.11-linux-x64.tar.gz',
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

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
