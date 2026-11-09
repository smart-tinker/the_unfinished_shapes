import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { confirmQuitIfUnsafe, installQuitGuard, isSmokeAutoConfirmQuit } from '../src/quit-guard.mjs';

const idle = () => ({
  connected: true,
  thread: { status: { type: 'idle' } },
  turnId: null,
  pendingApprovals: 0,
  goalSupported: true,
  goal: null,
});

function harness({ state, readState, answer = false }) {
  const app = new EventEmitter(), window = new EventEmitter();
  let quitCalls = 0, cleanupCalls = 0;
  const confirmations = [];
  app.quit = () => { quitCalls++; app.emit('before-quit', { preventDefault() {} }); };
  const attach = installQuitGuard({
    app,
    getWindow: () => window,
    readState: readState || (async () => state),
    confirm: async current => { confirmations.push(current); return answer; },
    cleanup: () => { cleanupCalls++; },
  });
  attach(window);
  return {
    app, window, confirmations,
    counts: () => ({ quitCalls, cleanupCalls }),
    async closeWindow() {
      let prevented = false;
      window.emit('close', { preventDefault() { prevented = true; } });
      await new Promise(resolve => setImmediate(resolve));
      return prevented;
    },
    async requestAppQuit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      await new Promise(resolve => setImmediate(resolve));
      return prevented;
    },
  };
}

test('an idle conversation with no Goal or approvals closes without a prompt', async () => {
  const h = harness({ state: idle() });
  assert.equal(await h.closeWindow(), true);
  assert.deepEqual(h.counts(), { quitCalls: 1, cleanupCalls: 1 });
  assert.equal(h.confirmations.length, 0);
});

test('an idle conversation can close when native Goals are confirmed unsupported', async () => {
  const h = harness({ state: { ...idle(), goalSupported: false } });
  assert.equal(await h.closeWindow(), true);
  assert.deepEqual(h.counts(), { quitCalls: 1, cleanupCalls: 1 });
  assert.equal(h.confirmations.length, 0);
});

test('any remaining native Goal requires an explicit quit decision', async () => {
  for (const status of ['active', 'paused']) {
    const state = { ...idle(), goal: { id: 'goal-1', status } };
    const h = harness({ state, answer: false });
    assert.equal(await h.closeWindow(), true);
    assert.deepEqual(h.counts(), { quitCalls: 0, cleanupCalls: 0 });
    assert.deepEqual(h.confirmations, [state]);
  }
});

test('an active turn or pending approval requires confirmation', async () => {
  for (const state of [
    { ...idle(), thread: { status: { type: 'active' } }, turnId: 'turn-1' },
    { ...idle(), pendingApprovals: 1 },
  ]) {
    const h = harness({ state, answer: false });
    assert.equal(await h.closeWindow(), true);
    assert.deepEqual(h.counts(), { quitCalls: 0, cleanupCalls: 0 });
    assert.deepEqual(h.confirmations, [state]);
  }
});

test('unknown or disconnected Codex state requires confirmation before app quit', async () => {
  for (const state of [null, { connected: false }, { ...idle(), thread: { status: { type: 'unknown' } } }, { ...idle(), goalSupported: null }]) {
    const h = harness({ state, answer: false });
    assert.equal(await h.requestAppQuit(), true);
    assert.deepEqual(h.counts(), { quitCalls: 0, cleanupCalls: 0 });
    assert.deepEqual(h.confirmations, [state]);
  }
});

test('choosing quit anyway allows cleanup; choosing keep-open leaves the app alive', async () => {
  const state = { ...idle(), goal: { id: 'goal-1', status: 'active' } };
  const stay = harness({ state, answer: false });
  await stay.closeWindow();
  assert.deepEqual(stay.counts(), { quitCalls: 0, cleanupCalls: 0 });

  const quit = harness({ state, answer: true });
  await quit.closeWindow();
  assert.deepEqual(quit.counts(), { quitCalls: 1, cleanupCalls: 1 });
});

test('unsafe state and unreadable state both require an explicit decision', async () => {
  const active = { ...idle(), thread: { status: { type: 'active' } }, turnId: 'turn-1' };
  const unknown = await confirmQuitIfUnsafe(null, async () => false);
  const unknownGoalSupport = await confirmQuitIfUnsafe({ ...idle(), goalSupported: null }, async () => false);
  const blocked = await confirmQuitIfUnsafe(active, async () => false);
  const accepted = await confirmQuitIfUnsafe(active, async () => true);
  assert.equal(unknown, false);
  assert.equal(unknownGoalSupport, false);
  assert.equal(blocked, false);
  assert.equal(accepted, true);
});


test('automatic quit confirmation is limited to an explicit CI smoke launch', () => {
  assert.equal(isSmokeAutoConfirmQuit({ CI: 'true' }, ['electron', '--tus-smoke-confirm-quit']), true);
  assert.equal(isSmokeAutoConfirmQuit({ CI: 'false' }, ['electron', '--tus-smoke-confirm-quit']), false);
  assert.equal(isSmokeAutoConfirmQuit({ CI: 'true' }, ['electron']), false);
});


test('shared-world smoke launch explicitly enables CI quit auto-confirm', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/shared-world-smoke.mjs', import.meta.url), 'utf8');
  const args = source.match(/args: \\[\\.\\.\\.\\(executable \\? \\[\\] : \\['\\.'\\]\\), ([^\\]]*)\\]/);
  assert.ok(args, 'shared-world smoke launch arguments are present');
  assert.match(args[1], /--tus-smoke-confirm-quit/);
});
