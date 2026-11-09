import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assetNames, candidateContext, recordManifest, requireDraft, requireNewRelease, requireStagingAttempt, validateManifest, verifyFiles, verifyRun } from '../scripts/release-candidate.mjs';

const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/release/0.1.0-rc3', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const context = candidateContext('0.1.0-rc.3', env);
const fixture = platform => ({ schema: 1, ...Object.fromEntries(['repository', 'tag', 'version', 'sourceSha', 'runId', 'runAttempt'].map(key => [key, context[key]])), platform,
  files: assetNames(context.version, platform).map(name => ({ name, size: 1, sha256: 'a'.repeat(64) })) });

test('candidate identity requires exact RC version, matching branch and source SHA', () => {
  assert.equal(context.tag, 'v0.1.0-rc3');
  for (const version of ['0.1.0', '0.1.0-rc3', '../../release']) assert.throws(() => candidateContext(version, env));
  for (const change of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: 'short' }, { GITHUB_RUN_ID: '1; echo hello' }, { GITHUB_RUN_ATTEMPT: '0' }]) assert.throws(() => candidateContext(context.version, { ...env, ...change }));
  assert.throws(() => assetNames(context.version, '../linux'));
});

test('only explicit release 404 permits creation; denial and collisions fail once without retry', async () => {
  for (const status of [200, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(requireNewRelease(context, async () => { calls++; return { status, data: {} }; }));
    assert.equal(calls, 1);
  }
  await requireNewRelease(context, async () => ({ status: 404, data: {} }));
  await assert.rejects(requireNewRelease(context, async () => { throw new Error('network denied'); }), /network denied/);
});

test('draft and staging-attempt identity fail closed', () => {
  const release = { id: 1, draft: true, prerelease: true, tag_name: context.tag, target_commitish: context.sourceSha, assets: [] };
  requireDraft(release, context, '1');
  for (const change of [{ id: 2 }, { draft: false }, { prerelease: false }, { target_commitish: 'b'.repeat(40) }, { tag_name: 'v-other' }]) assert.throws(() => requireDraft({ ...release, ...change }, context, '1'));
  requireStagingAttempt(context, '1');
  assert.throws(() => requireStagingAttempt(context, '2'));
  assert.throws(() => requireStagingAttempt(context, undefined));
});

test('manifest is bound to one exact candidate, platform, run and complete asset set', () => {
  validateManifest(fixture('windows'), context, 'windows');
  for (const change of [{ sourceSha: 'b'.repeat(40) }, { repository: 'other/repo' }, { tag: 'v-other' }, { platform: 'linux' }, { runId: '456' }, { runAttempt: '0' }, { schema: 2 }, { files: [] }]) assert.throws(() => validateManifest({ ...fixture('windows'), ...change }, context, 'windows'));
  for (const change of [{ name: '../file' }, { sha256: 'short' }, { size: 0 }, { size: 536870913 }]) {
    const manifest = fixture('linux'); Object.assign(manifest.files[0], change);
    assert.throws(() => validateManifest(manifest, context, 'linux'));
  }
  const duplicate = fixture('windows'); duplicate.files[1] = duplicate.files[0];
  assert.throws(() => validateManifest(duplicate, context, 'windows'));
});

test('hashes recorded before tests reject changed bytes or size; record never overwrites', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tus-manifest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = assetNames(context.version, 'linux')[0];
  await writeFile(path.join(directory, name), 'candidate');
  const manifest = await recordManifest(context, 'linux', directory);
  validateManifest(manifest, context, 'linux'); await verifyFiles(manifest, directory);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'candidate-linux.json'), 'utf8')), manifest);
  await assert.rejects(recordManifest(context, 'linux', directory));
  await writeFile(path.join(directory, name), 'Candidate');
  await assert.rejects(verifyFiles(manifest, directory), /digest changed/);
  await writeFile(path.join(directory, name), 'truncated');
  // Same-length changes are still caught by digest; different length by size.
  await assert.rejects(verifyFiles(manifest, directory));
  await writeFile(path.join(directory, name), 'x');
  await assert.rejects(verifyFiles(manifest, directory), /size changed/);
});

test('publication requires this staging workflow and exact completed successful attempt', () => {
  const run = { id: 123, run_attempt: 1, path: '.github/workflows/stage-release.yml', event: 'workflow_dispatch', head_branch: context.branch, head_sha: context.sourceSha, status: 'completed', conclusion: 'success' };
  verifyRun(run, context, '123', '1');
  for (const change of [{ id: 124 }, { run_attempt: 2 }, { path: '.github/workflows/local-cpu-model.yml' }, { event: 'pull_request' }, { head_branch: 'main' }, { head_sha: 'b'.repeat(40) }, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]) assert.throws(() => verifyRun({ ...run, ...change }, context, '123', '1'));
});

test('draft collision is detected even when the published-tag endpoint returns 404', async () => {
  const request = async endpoint => endpoint.includes('/releases/tags/')
    ? { status: 404, data: {} }
    : { status: 200, data: [{ id: 99, tag_name: context.tag, draft: true }] };
  await assert.rejects(requireNewRelease(context, request), /existing release/);
});
