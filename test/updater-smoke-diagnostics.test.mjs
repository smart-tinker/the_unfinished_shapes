import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeMainDiagnostics } from '../scripts/updater-smoke-diagnostics.mjs';

test('TUS main diagnostic preserves the safe verifier setup stage at the log boundary', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const [diagnostic] = safeMainDiagnostics([{
    bundleIndex: 0,
    bundleSha256: 'b'.repeat(64),
    assetName,
    assetSha256: manifestFile.sha256,
    tag,
    stage: 'verifier-setup',
    status: 'rejected',
    verifierSetupStage: 'trust-material',
  }], manifestFile, assetName, tag);

  assert.equal(diagnostic.verifierSetupStage, 'trust-material');
});
