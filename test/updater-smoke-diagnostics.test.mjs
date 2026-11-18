import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeMainDiagnostics } from '../scripts/updater-smoke-diagnostics.mjs';

test('TUS main diagnostic preserves only safe verifier setup stages at the log boundary', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const base = {
    bundleIndex: 0,
    bundleSha256: 'b'.repeat(64),
    assetName,
    assetSha256: manifestFile.sha256,
    tag,
    status: 'rejected',
  };
  const diagnostics = safeMainDiagnostics([
    { ...base, stage: 'verifier-setup', verifierSetupStage: 'trust-material' },
    { ...base, stage: 'verifier-setup', verifierSetupStage: 'private/path/token' },
    { ...base, stage: 'verifier-verify', verifierSetupStage: 'trust-material' },
  ], manifestFile, assetName, tag);

  assert.equal(diagnostics[0].verifierSetupStage, 'trust-material');
  assert.equal(diagnostics[1].verifierSetupStage, 'unknown');
  assert.equal(Object.hasOwn(diagnostics[2], 'verifierSetupStage'), false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private\/path\/token/);
});
