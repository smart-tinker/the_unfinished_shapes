import test from 'node:test';
import assert from 'node:assert/strict';
import { ghRequest, ghCreateTag, verifyReleaseTag, ensureReleaseTag } from '../scripts/verify-release-tag.mjs';

const commit = 'a'.repeat(40), other = 'b'.repeat(40), tagA = 'c'.repeat(40), tagB = 'd'.repeat(40);
const repository = 'smart-tinker/the_unfinished_shapes', tag = 'v0.1.0-rc3';
const refPath = `repos/${repository}/git/ref/tags/${tag}`;
const ref = object => ({ status: 200, data: { ref: `refs/tags/${tag}`, object } });
function fixture(responses) {
  const calls = [];
  return { calls, request: async endpoint => { calls.push(endpoint); if (!(endpoint in responses)) throw new Error(`Unexpected GET: ${endpoint}`); return responses[endpoint]; } };
}
const options = f => ({ repository, tag, expectedSha: commit, request: f.request });

test('lightweight tag must resolve to the exact tested commit', async () => {
  const f = fixture({ [refPath]: ref({ type: 'commit', sha: commit }) });
  assert.deepEqual(await verifyReleaseTag(options(f)), { missing: false, sha: commit, annotatedTags: 0 });
  assert.deepEqual(f.calls, [refPath]);
  const wrong = fixture({ [refPath]: ref({ type: 'commit', sha: other }) });
  await assert.rejects(verifyReleaseTag({ ...options(wrong), allowMissing: true }), /not tested commit/);
});

test('annotated tags are peeled through bounded read-only lookups', async () => {
  const f = fixture({
    [refPath]: ref({ type: 'tag', sha: tagA }),
    [`repos/${repository}/git/tags/${tagA}`]: { status: 200, data: { sha: tagA, object: { type: 'tag', sha: tagB } } },
    [`repos/${repository}/git/tags/${tagB}`]: { status: 200, data: { sha: tagB, object: { type: 'commit', sha: commit } } }
  });
  assert.equal((await verifyReleaseTag(options(f))).annotatedTags, 2);
  assert.equal(f.calls.length, 3);
  await assert.rejects(verifyReleaseTag({ ...options(f), maxTagDepth: 1 }), /depth limit/);
});

test('missing root tag is allowed only in explicit pre-create mode; all other failures close', async () => {
  const missing = fixture({ [refPath]: { status: 404, data: { message: 'Not Found' } } });
  assert.deepEqual(await verifyReleaseTag({ ...options(missing), allowMissing: true }), { missing: true });
  await assert.rejects(verifyReleaseTag(options(missing)), /HTTP 404/);
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({ [refPath]: { status, data: {} } });
    await assert.rejects(verifyReleaseTag({ ...options(f), allowMissing: true }), new RegExp(`HTTP ${status}`));
  }
  const broken = fixture({ [refPath]: ref({ type: 'tag', sha: tagA }), [`repos/${repository}/git/tags/${tagA}`]: { status: 404, data: {} } });
  await assert.rejects(verifyReleaseTag({ ...options(broken), allowMissing: true }), /Annotated-tag lookup failed/);
});

test('cycles, non-commit objects and inconsistent API objects are rejected', async () => {
  const cyclic = fixture({ [refPath]: ref({ type: 'tag', sha: tagA }), [`repos/${repository}/git/tags/${tagA}`]: { status: 200, data: { sha: tagA, object: { type: 'tag', sha: tagA } } } });
  await assert.rejects(verifyReleaseTag(options(cyclic)), /cyclic/);
  assert.equal(cyclic.calls.length, 2);
  for (const object of [{ type: 'blob', sha: commit }, { type: 'commit', sha: 'short' }, null]) {
    await assert.rejects(verifyReleaseTag(options(fixture({ [refPath]: ref(object) }))));
  }
  const wrongRef = fixture({ [refPath]: { status: 200, data: { ref: 'refs/tags/other', object: { type: 'commit', sha: commit } } } });
  await assert.rejects(verifyReleaseTag(options(wrongRef)), /different tag ref/);
  const wrongObject = fixture({ [refPath]: ref({ type: 'tag', sha: tagA }), [`repos/${repository}/git/tags/${tagA}`]: { status: 200, data: { sha: tagB, object: { type: 'commit', sha: commit } } } });
  await assert.rejects(verifyReleaseTag(options(wrongObject)), /different annotated/);
});

test('invalid inputs are rejected before invoking gh', async () => {
  for (const override of [{ repository: '../repo' }, { tag: '../bad' }, { tag: '-bad' }, { expectedSha: 'main' }, { maxTagDepth: 1000 }]) {
    const f = fixture({});
    await assert.rejects(verifyReleaseTag({ ...options(f), ...override }));
    assert.equal(f.calls.length, 0);
  }
});

test('gh adapter issues GET only with timeout and parses HTTP status instead of guessing stderr', async () => {
  const calls = [];
  const request = ghRequest(async (...args) => { calls.push(args); return { stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ref":"refs/tags/test"}\n' }; });
  assert.deepEqual(await request(refPath), { status: 200, data: { ref: 'refs/tags/test' } });
  assert.deepEqual(calls[0][0], 'gh');
  assert.deepEqual(calls[0][1], ['api', '--method', 'GET', '--include', refPath]);
  assert.equal(calls[0][2].timeout, 15000);
  assert.equal(calls[0][2].maxBuffer, 1024 * 1024);
  const missing = ghRequest(async () => { throw { stdout: 'HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}' }; });
  assert.equal((await missing(refPath)).status, 404);
  const failed = ghRequest(async () => { throw { stderr: 'some failure mentions HTTP 404' }; });
  await assert.rejects(failed(refPath), /without an HTTP response/);
  const malformed = ghRequest(async () => ({ stdout: 'HTTP/2.0 200 OK\n\nnot JSON' }));
  await assert.rejects(malformed(refPath), /invalid JSON/);
});


test('read-only GET retries a missing HTTP response once but not a valid HTTP error', async () => {
  let calls = 0;
  const request = ghRequest(async () => {
    calls++;
    if (calls === 1) throw { stdout: '', stderr: 'temporary transport failure' };
    return { stdout: 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"ref":"refs/tags/test"}\\n' };
  });
  assert.equal((await request(refPath)).status, 200);
  assert.equal(calls, 2);

  calls = 0;
  const denied = ghRequest(async () => {
    calls++;
    throw { stdout: 'HTTP/2.0 403 Forbidden\\r\\nContent-Type: application/json\\r\\n\\r\\n{"message":"Forbidden"}' };
  });
  assert.equal((await denied(refPath)).status, 403);
  assert.equal(calls, 1);
});

test('tag creation is 404-only, create-only and always followed by exact-SHA verification', async () => {
  let count = 0; const writes = [];
  const opts = { repository, tag, expectedSha: commit, request: async () => ++count === 1 ? { status: 404, data: {} } : ref({ type: 'commit', sha: commit }) };
  const result = await ensureReleaseTag(opts, async (...args) => { writes.push(args); return { status: 201, data: {} }; });
  assert.equal(result.created, true); assert.equal(count, 2);
  assert.deepEqual(writes, [[repository, tag, commit]]);
  const existing = fixture({ [refPath]: ref({ type: 'commit', sha: commit }) });
  assert.equal((await ensureReleaseTag(options(existing), async () => { throw Error('must not write'); })).created, false);
  const wrong = fixture({ [refPath]: ref({ type: 'commit', sha: other }) });
  await assert.rejects(ensureReleaseTag(options(wrong), async () => { throw Error('must not retag'); }), /not tested commit/);
});

test('creation conflicts are read once and never overwritten; other failures close', async () => {
  for (const status of [409, 422]) {
    let reads = 0, writes = 0;
    const opts = { repository, tag, expectedSha: commit, request: async () => ++reads === 1 ? { status: 404, data: {} } : ref({ type: 'commit', sha: commit }) };
    assert.equal((await ensureReleaseTag(opts, async () => { writes++; return { status, data: {} }; })).created, false);
    assert.equal(writes, 1); assert.equal(reads, 2);
  }
  let reads = 0;
  const mismatch = { repository, tag, expectedSha: commit, request: async () => ++reads === 1 ? { status: 404, data: {} } : ref({ type: 'commit', sha: other }) };
  await assert.rejects(ensureReleaseTag(mismatch, async () => ({ status: 422, data: {} })), /not tested commit/);
  const absent = fixture({ [refPath]: { status: 404, data: {} } });
  await assert.rejects(ensureReleaseTag(options(absent), async () => ({ status: 403, data: {} })), /creation failed/);
  assert.equal(absent.calls.length, 1);
  await assert.rejects(ensureReleaseTag(options(absent), async () => { throw Error('uncertain network outcome'); }), /uncertain network/);
});

test('creation adapter only POSTs a new fully specified lightweight tag, without force', async () => {
  const calls = [];
  const create = ghCreateTag(async (...args) => { calls.push(args); return { stdout: 'HTTP/2.0 201 Created\n\n{}' }; });
  assert.equal((await create(repository, tag, commit)).status, 201);
  assert.deepEqual(calls[0][1], ['api', '--method', 'POST', '--include', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${commit}`]);
});
