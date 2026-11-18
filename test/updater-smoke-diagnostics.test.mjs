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
    { ...base, stage: 'verifier-setup', verifierSetupStage: 'tuf-get-trusted-root', verifierSetupStep: 'tuf-target-metadata-search' },
    { ...base, stage: 'verifier-setup', verifierSetupStage: 'private/path/token', verifierSetupStep: 'private/path/token' },
    { ...base, stage: 'verifier-verify', verifierSetupStage: 'trust-material' },
  ], manifestFile, assetName, tag);

  assert.equal(diagnostics[0].verifierSetupStage, 'tuf-get-trusted-root');
  assert.equal(diagnostics[0].verifierSetupStep, 'tuf-target-metadata-search');
  assert.equal(diagnostics[1].verifierSetupStage, 'unknown');
  assert.equal(diagnostics[1].verifierSetupStep, 'unknown');
  assert.equal(Object.hasOwn(diagnostics[2], 'verifierSetupStage'), false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private\/path\/token/);
});

test('TUS main diagnostic preserves a bounded tampered-bundle verifier result', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const base = {
    bundleIndex: 0,
    bundleSha256: 'b'.repeat(64),
    assetName,
    assetSha256: manifestFile.sha256,
    tag,
    privateDetails: 'raw verifier exception',
  };
  const [control] = safeMainDiagnostics([{
    ...base,
    stage: 'verifier-tampered-control',
    status: 'tampered-rejected',
  }], manifestFile, assetName, tag);

  assert.equal(control.stage, 'verifier-tampered-control');
  assert.equal(control.status, 'tampered-rejected');
  assert.equal(control.assetMatches, true);
  assert.doesNotMatch(JSON.stringify(control), /raw verifier exception/);
});
test('TUS runtime boundary preserves only fixed import and renderer-invoke outcomes', () => {
  const manifestFile = { sha256: 'a'.repeat(64) };
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const diagnostics = safeMainDiagnostics([
    { stage: 'updater-module-import', status: 'pending' },
    { stage: 'updater-module-import', status: 'fulfilled' },
    { stage: 'updater-module-import', status: 'rejected', moduleFailureCode: 'MODULE_IMPORT_REJECTED', privateDetails: 'C:/private/path' },
    { stage: 'updater-module-import', status: 'rejected', moduleFailureCode: 'ERR_MODULE_NOT_FOUND', moduleFailureName: '@sigstore/tuf', privateDetails: 'private module path' },
    { stage: 'updater-module-import', status: 'rejected', moduleFailureCode: 'SyntaxError', moduleFailureName: 'file:///C:/private/app.asar/secrets/private.mjs', privateDetails: 'private syntax detail' },
    { stage: 'download-verified-asset', status: 'pending' },
    { stage: 'renderer-invoke', status: 'rejected', privateDetails: 'raw IPC exception' },
    { stage: 'private/path', status: 'private/path', moduleFailureCode: 'PRIVATE_CODE' },
  ], manifestFile, assetName, tag);

  assert.deepEqual(diagnostics.map(({ stage, status }) => [stage, status]), [
    ['updater-module-import', 'pending'],
    ['updater-module-import', 'fulfilled'],
    ['updater-module-import', 'rejected'],
    ['updater-module-import', 'rejected'],
    ['updater-module-import', 'rejected'],
    ['download-verified-asset', 'pending'],
    ['renderer-invoke', 'rejected'],
    ['unknown', 'unknown'],
  ]);
  assert.equal(diagnostics[2].moduleFailureCode, 'MODULE_IMPORT_REJECTED');
  assert.equal(diagnostics[3].moduleFailureCode, 'ERR_MODULE_NOT_FOUND');
  assert.equal(diagnostics[3].moduleFailureName, '@sigstore/tuf');
  assert.equal(diagnostics[4].moduleFailureCode, 'SyntaxError');
  assert.equal(diagnostics[4].moduleFailureName, 'unknown');
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes('C:/private/path'), false);
  assert.equal(serialized.includes('raw IPC exception'), false);
  assert.equal(serialized.includes('PRIVATE_CODE'), false);
});

test('TUS extraction diagnostic carries only an allowlisted failure stage', () => {
  const assetName = 'candidate.zip';
  const tag = 'v0.1.0-rc11';
  const manifestFile = { sha256: 'a'.repeat(64) };
  const [entry, privateStage] = safeMainDiagnostics([
    { stage: 'extract-failed', status: 'rejected', extractStage: 'entry', extractOperation: 'asar-open-invalid-package', privateDetails: 'raw parser message' },
    { stage: 'extract-failed', status: 'rejected', extractStage: 'C:/private/path', extractOperation: 'C:/private/app.asar', privateDetails: 'raw parser message' },
  ], manifestFile, assetName, tag);

  assert.equal(entry.stage, 'extract-failed');
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.extractStage, 'entry');
  assert.equal(entry.extractOperation, 'asar-open-invalid-package');
  assert.equal(privateStage.stage, 'extract-failed');
  assert.equal(privateStage.extractStage, 'unknown');
  assert.equal(privateStage.extractOperation, 'unknown');
  assert.doesNotMatch(JSON.stringify([entry, privateStage]), /raw parser message|C:\/private\/path/);
});
