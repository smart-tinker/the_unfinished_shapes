import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmQuitIfUnsafe } from '../src/quit-guard.mjs';

const idle = () => ({
  connected: true,
  thread: { status: { type: 'idle' } },
  turnId: null,
  pendingApprovals: 0,
  goal: null,
});

test('an idle conversation with no Goal or approvals closes without a prompt', async () => {
  let confirmations = 0;
  assert.equal(await confirmQuitIfUnsafe(idle(), async () => { confirmations++; return false; }), true);
  assert.equal(confirmations, 0);
});

test('any remaining native Goal requires an explicit quit decision', async () => {
  for (const status of ['active', 'paused']) {
    let confirmations = 0;
    const state = { ...idle(), goal: { id: 'goal-1', status } };
    assert.equal(await confirmQuitIfUnsafe(state, async received => {
      confirmations++;
      assert.equal(received, state);
      return false;
    }), false);
    assert.equal(confirmations, 1);
  }
});

test('an active turn or pending approval requires an explicit quit decision', async () => {
  for (const state of [
    { ...idle(), thread: { status: { type: 'active' } }, turnId: 'turn-1' },
    { ...idle(), pendingApprovals: 1 },
  ]) {
    let confirmations = 0;
    assert.equal(await confirmQuitIfUnsafe(state, async () => { confirmations++; return false; }), false);
    assert.equal(confirmations, 1);
  }
});

test('unknown or disconnected Codex state requires an explicit quit decision', async () => {
  for (const state of [null, { connected: false }, { ...idle(), thread: { status: { type: 'unknown' } } }]) {
    let confirmations = 0;
    assert.equal(await confirmQuitIfUnsafe(state, async () => { confirmations++; return false; }), false);
    assert.equal(confirmations, 1);
  }
});

test('explicit confirmation is the only way to quit with unsafe state', async () => {
  assert.equal(await confirmQuitIfUnsafe({ ...idle(), goal: { id: 'goal-1', status: 'active' } }, async () => true), true);
});
