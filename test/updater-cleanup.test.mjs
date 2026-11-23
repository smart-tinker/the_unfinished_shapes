import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupUpdaterTemporaryData } from '../scripts/updater-cleanup.mjs';
import { withSmokeCleanup } from '../scripts/graphics-smoke.mjs';

test('updater temporary cleanup bounds a stalled remove and preserves the original failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const primary = new Error('updater operation failed');
  const outcomes = [];
  let laterCleanupRan = false;
  let result;
  const completion = withSmokeCleanup(
    async () => { throw primary; },
    () => cleanupUpdaterTemporaryData({
      testRoot: 'C:/private/updater-smoke',
      canRemove: async () => true,
      remove: () => new Promise(() => {}),
      onOutcome: outcome => outcomes.push(outcome),
    }),
    () => { laterCleanupRan = true; },
  ).then(
    () => { result = { status: 'fulfilled' }; },
    error => { result = { status: 'rejected', error }; },
  );

  await new Promise(resolve => setImmediate(resolve));
  await t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(result, 'a stalled production temporary-data cleanup reaches a bounded terminal result');
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.cause, primary);
  assert.equal(result.error.errors[0], primary);
  assert.equal(result.error.errors[1]?.code, 'ETIMEDOUT');
  assert.equal(laterCleanupRan, true, 'independent cleanup still runs after a cleanup timeout');
  assert.deepEqual(outcomes, ['timeout']);
  assert.equal(JSON.stringify(outcomes).includes('C:/private'), false);
});

test('updater temporary cleanup retains data until installer cleanup succeeds', async () => {
  const outcomes = [];
  let removed = false;
  await cleanupUpdaterTemporaryData({
    testRoot: 'C:/private/updater-smoke',
    canRemove: async () => false,
    remove: async () => { removed = true; },
    onOutcome: outcome => outcomes.push(outcome),
  });
  assert.equal(removed, false);
  assert.deepEqual(outcomes, ['retained']);
});
