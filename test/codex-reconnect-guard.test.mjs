import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge } from '../src/codex.mjs';

const idleState = () => ({ thread: { status: { type: 'idle' } }, turnId: null, goal: null });

test('reconnect guard requires confirmed idle Codex state and catches activity during the read', async () => {
  const bridge = new CodexBridge();
  bridge.readControlState = async () => idleState();
  await bridge.assertIdleForReconnect();

  for (const state of [
    { ...idleState(), thread: { status: { type: 'active' } } },
    { ...idleState(), thread: { status: { type: 'unknown' } } },
    { ...idleState(), turnId: 'turn-1' },
    { ...idleState(), goal: { id: 'goal-1', status: 'paused' } },
  ]) {
    bridge.readControlState = async () => state;
    await assert.rejects(bridge.assertIdleForReconnect(), /not verifiably idle/i);
  }

  bridge.readControlState = async () => {
    bridge.turnId = 'turn-started-during-read';
    return idleState();
  };
  await assert.rejects(bridge.assertIdleForReconnect(), /not verifiably idle/i);

  bridge.turnId = null;
  bridge.sending = true;
  bridge.readControlState = async () => idleState();
  await assert.rejects(bridge.assertIdleForReconnect(), /not verifiably idle/i);

  bridge.sending = false;
  bridge.approvals.add('approval-1');
  await assert.rejects(bridge.assertIdleForReconnect(), /not verifiably idle/i);

  bridge.approvals.clear();
  bridge.goalOperation = true;
  await assert.rejects(bridge.assertIdleForReconnect(), /not verifiably idle/i);
});
