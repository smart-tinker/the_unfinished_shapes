import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { verifyReleaseAttestation } from '../src/update-package.mjs';

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
  assert.equal(args[1], undefined);
  assert.deepEqual(args[2], {
    certificateIdentity: 'https://github.com/smart-tinker/the_unfinished_shapes/.github/workflows/stage-release.yml@refs/heads/release/0.1.0-rc11',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
  });
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
