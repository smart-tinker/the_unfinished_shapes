import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghRequest, verifyReleaseTag } from './verify-release-tag.mjs';

const execute = promisify(execFile);
const platforms = ['windows', 'macos', 'linux'];
const maxAssetSize = 512 * 1024 * 1024;
const manifestName = platform => `candidate-${platform}.json`;

export function candidateContext(version, env) {
  assert.match(version, /^\d+\.\d+\.\d+-rc\.\d+$/, 'only release candidates are supported');
  assert.match(env.GITHUB_REPOSITORY || '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  const tag = `v${version.replace('-rc.', '-rc')}`;
  const branch = `release/${tag.slice(1)}`;
  assert.equal(env.GITHUB_REF, `refs/heads/${branch}`, 'dispatch on the matching release branch');
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9]\d*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT || '', /^[1-9]\d*$/);
  return { version, tag, branch, repository: env.GITHUB_REPOSITORY, sourceSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
}

export function requireStagingAttempt(context, preparedAttempt) {
  assert.equal(preparedAttempt, context.runAttempt, 'Refusing to reuse a draft from an earlier staging attempt. Choose a new candidate; do not rerun failed jobs into a partial draft.');
}

export function assetNames(version, platform) {
  const prefix = `TheUnfinishedShapes-${version}`;
  const names = {
    windows: [`${prefix}-win32-x64.zip`, `${prefix}-Setup-x64.exe`],
    macos: [`${prefix}-darwin-arm64.zip`],
    linux: [`${prefix}-linux-x64.tar.gz`]
  };
  assert.ok(Object.hasOwn(names, platform), 'unknown platform');
  return names[platform];
}

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function recordManifest(context, platform, directory) {
  assert.deepEqual((await readdir(directory)).sort(), assetNames(context.version, platform).sort(), 'only final candidate files belong in the upload directory');
  const files = [];
  for (const name of assetNames(context.version, platform)) {
    const file = path.join(directory, name), info = await stat(file);
    assert.ok(info.isFile() && info.size > 0 && info.size <= maxAssetSize, `invalid file: ${name}`);
    files.push({ name, size: info.size, sha256: await fileDigest(file) });
  }
  const manifest = { schema: 1, repository: context.repository, tag: context.tag, version: context.version,
    sourceSha: context.sourceSha, runId: context.runId, runAttempt: context.runAttempt, platform, files };
  await writeFile(path.join(directory, manifestName(platform)), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

export function validateManifest(manifest, context, platform, runId = context.runId) {
  for (const key of ['repository', 'tag', 'version', 'sourceSha']) assert.equal(manifest[key], context[key], `candidate ${key} mismatch`);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.platform, platform);
  assert.equal(manifest.runId, runId, 'candidate run mismatch');
  assert.match(manifest.runAttempt || '', /^[1-9]\d*$/);
  assert.ok(Array.isArray(manifest.files));
  assert.deepEqual(manifest.files.map(file => file.name).sort(), assetNames(context.version, platform).sort(), 'candidate file set mismatch');
  for (const file of manifest.files) {
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxAssetSize, 'invalid candidate file size');
    assert.match(file.sha256 || '', /^[a-f0-9]{64}$/, 'invalid candidate digest');
  }
  return manifest;
}

export async function verifyFiles(manifest, directory) {
  for (const file of manifest.files) {
    assert.equal((await stat(path.join(directory, file.name))).size, file.size, `size changed: ${file.name}`);
    assert.equal(await fileDigest(path.join(directory, file.name)), file.sha256, `digest changed: ${file.name}`);
  }
}

async function lookup(context, endpoint, request) {
  const response = await request(`repos/${context.repository}/${endpoint}`);
  assert.equal(response.status, 200, `GitHub lookup failed (HTTP ${response.status}): ${endpoint}`);
  return response.data;
}

export async function requireNewRelease(context, request = ghRequest()) {
  const response = await request(`repos/${context.repository}/releases/tags/${encodeURIComponent(context.tag)}`);
  assert.equal(response.status, 404, `Refusing to reuse an existing release or an uncertain lookup (HTTP ${response.status}). Choose a new candidate version; never overwrite assets.`);
}

export function requireDraft(release, context, releaseId) {
  if (releaseId) assert.equal(String(release.id), releaseId, 'draft ID changed');
  assert.equal(release.draft, true, 'release must still be a draft');
  assert.equal(release.prerelease, true, 'only prereleases are supported');
  assert.equal(release.tag_name, context.tag, 'draft tag changed');
  assert.equal(release.target_commitish, context.sourceSha, 'draft source changed');
  assert.ok(Array.isArray(release.assets));
}

export function verifyRun(run, context, runId, runAttempt) {
  assert.equal(String(run.id), runId);
  assert.equal(String(run.run_attempt), runAttempt);
  assert.equal(run.path, '.github/workflows/stage-release.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, context.branch);
  assert.equal(run.head_sha, context.sourceSha);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success', 'the selected candidate staging attempt must succeed');
}

async function verifySource(context, request) {
  const ref = await lookup(context, `git/ref/heads/${encodeURIComponent(context.branch)}`, request);
  assert.equal(ref.ref, `refs/heads/${context.branch}`);
  assert.equal(ref.object?.type, 'commit');
  assert.equal(ref.object.sha, context.sourceSha, 'release branch moved; dispatch the intended current commit');
  await verifyReleaseTag({ repository: context.repository, tag: context.tag, expectedSha: context.sourceSha, request });
}

async function gh(args) {
  return execute('gh', args, { timeout: 180000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
}
async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'release operations require an explicit manual dispatch');
  const context = candidateContext(JSON.parse(await readFile('package.json', 'utf8')).version, process.env);
  const request = ghRequest();
  const [command, platformOrRun, directory, releaseId, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  assert.equal((await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), context.sourceSha, 'checkout must be the exact candidate commit');
  if (['check-attempt', 'record', 'stage'].includes(command)) requireStagingAttempt(context, process.env.CANDIDATE_RUN_ATTEMPT);
  if (command === 'check-attempt') { assert.ok(!platformOrRun); return; }
  if (command === 'record') {
    assert.ok(directory && !releaseId);
    await recordManifest(context, platformOrRun, directory);
    return;
  }
  await verifySource(context, request);
  if (command === 'preflight' || command === 'create-draft') {
    assert.ok(!platformOrRun);
    await requireNewRelease(context, request);
    if (command === 'create-draft') {
      await gh(['release', 'create', context.tag, '--repo', context.repository, '--verify-tag', '--target', context.sourceSha,
        '--title', `The Unfinished Shapes ${context.version}`, '--draft', '--prerelease', '--notes',
        `Source: ${context.sourceSha}\nCandidate run: https://github.com/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}\n\nWindows x64 is unsigned. macOS supports Apple Silicon arm64 only, with an ad-hoc signature and no notarization. Linux and Windows CI use explicit SwiftShader with the existing runner-only no-sandbox setting; normal application startup is unchanged. Default Linux automatic graphics and Windows D3D11-WARP context loss remain unresolved. Hardware-GPU and interactive desktop acceptance were not performed. See docs/GRAPHICS.md and README at this source commit for scope and limitations.`]);
      const release = await lookup(context, `releases/tags/${encodeURIComponent(context.tag)}`, request);
      requireDraft(release, context);
      assert.equal(release.assets.length, 0, 'new draft must be empty');
      await output('release_id', release.id);
      await output('run_attempt', context.runAttempt);
    }
    await output('tag', context.tag);
    await output('version', context.version);
    return;
  }
  if (command === 'stage') {
    assert.match(releaseId || '', /^[1-9]\d*$/);
    const platform = platformOrRun;
    const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, manifestName(platform)), 'utf8')), context, platform);
    assert.equal(manifest.runAttempt, context.runAttempt);
    assert.deepEqual((await readdir(directory)).sort(), [...assetNames(context.version, platform), manifestName(platform)].sort());
    await verifyFiles(manifest, directory);
    const release = await lookup(context, `releases/${releaseId}`, request);
    requireDraft(release, context, releaseId);
    const names = [...assetNames(context.version, platform), manifestName(platform)];
    for (const asset of release.assets) assert.ok(!names.includes(asset.name), `asset already exists: ${asset.name}`);
    // No --clobber: collisions, including concurrent uploads, fail rather than replacing bytes.
    await gh(['release', 'upload', context.tag, ...names.map(name => path.join(directory, name)), '--repo', context.repository]);
    return;
  }
  assert.equal(command, 'publish', 'expected preflight, create-draft, record, stage or publish');
  assert.ok(!directory && !releaseId);
  const runId = platformOrRun;
  assert.match(runId || '', /^[1-9]\d*$/);
  const release = await lookup(context, `releases/tags/${encodeURIComponent(context.tag)}`, request);
  requireDraft(release, context);
  const names = platforms.flatMap(platform => [...assetNames(context.version, platform), manifestName(platform)]);
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), names.sort(), 'draft must contain exactly this complete candidate');
  for (const asset of release.assets) assert.ok(asset.state === 'uploaded' && asset.size > 0 && asset.size <= (asset.name.startsWith('candidate-') ? 16384 : maxAssetSize), `invalid release asset: ${asset.name}`);
  const download = await mkdtemp(path.join(os.tmpdir(), 'tus-publish-'));
  try {
    await gh(['release', 'download', context.tag, '--repo', context.repository, '--dir', download, ...names.flatMap(name => ['--pattern', name])]);
    let runAttempt;
    for (const platform of platforms) {
      const manifest = validateManifest(JSON.parse(await readFile(path.join(download, manifestName(platform)), 'utf8')), context, platform, runId);
      runAttempt ??= manifest.runAttempt;
      assert.equal(manifest.runAttempt, runAttempt, 'candidate mixes staging attempts');
      for (const file of manifest.files) assert.equal(release.assets.find(asset => asset.name === file.name).size, file.size);
      await verifyFiles(manifest, download);
    }
    verifyRun(await lookup(context, `actions/runs/${runId}/attempts/${runAttempt}`, request), context, runId, runAttempt);
    // Recheck identity and the asset snapshot immediately before changing visibility.
    await verifySource(context, request);
    const current = await lookup(context, `releases/${release.id}`, request);
    requireDraft(current, context, String(release.id));
    const snapshot = assets => assets.map(({ id, name, size, updated_at, digest, state }) => ({ id, name, size, updated_at, digest, state })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(snapshot(current.assets), snapshot(release.assets), 'draft assets changed during verification');
    await gh(['release', 'edit', context.tag, '--repo', context.repository, '--draft=false', '--prerelease']);
    console.log(`Published ${context.tag} without rebuilding; source ${context.sourceSha}, staging run ${runId}/${runAttempt}.`);
  } finally { await rm(download, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
