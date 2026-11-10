import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function settingsHarness(controlState) {
  const h = rendererHarness();
  const state = JSON.stringify(controlState);
  h.run(`let settings = { workspacePath: '/old-workspace', codexPath: '/codex', serverUrl: 'http://world-a', token: 'session-token', threadId: 'game-thread' };
let connected = true, busy = false, settingsGeneration = 0, worldRevision = 1, objectSnapshot = '', worldState = {}, meId = 'player';
let playerPosition = { x: 1, y: 0, z: 1 }, playerVelocityY = 0, jumpRequested = false, lastPosition = '', latestStateRevision = 1, localMovementVersion = 0;
let scene = null, calls = [], moveStarts = new Map();
const liveControls = ${state};
const bridge = {
  readAgentControls: async threadId => { calls.push('read:' + threadId); return liveControls; },
  disconnectCodex: async () => calls.push('disconnect'),
  saveSettings: async () => calls.push('save'),
};
function updateChatControls() {}
async function poll() { calls.push('poll'); }`);
    h.load('function readSettings() {', "$('save-world').addEventListener");
  h.element('workspace').value = '/new-workspace';
  h.element('codex').value = '/codex';
  h.element('server-url').value = 'http://world-a';
  h.element('token').value = 'session-token';
  return h;
}

test('changing workspace is blocked while a native Goal is active', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, goalSupported: true, pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } });
  await assert.rejects(h.run('saveSettings()'), /Goal|pause|wait/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('changing workspace is blocked while a paused Goal still has a running turn', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'active', turnId: 'turn-1', goalSupported: true, pendingApprovals: 0, goal: { id: 'goal-1', status: 'paused' } });
  await assert.rejects(h.run('saveSettings()'), /Goal|turn|wait/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
});

test('changing workspace is blocked while a paused Goal would be orphaned', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, goalSupported: true, pendingApprovals: 0, goal: { id: 'goal-1', status: 'paused' } });
  await assert.rejects(h.run('saveSettings()'), /Goal|clear|wait/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
});

test('changing workspace is blocked while Codex has a pending approval', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'active', turnId: 'turn-1', goalSupported: true, pendingApprovals: 1, goal: null });
  await assert.rejects(h.run('saveSettings()'), /approval|wait|idle/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
});

test('changing workspace is blocked if native conversation state cannot be confirmed', async () => {
  const h = settingsHarness({ connected: false, threadId: null });
  await assert.rejects(h.run('saveSettings()'), /Codex|conversation|confirm|connected/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
});

test('changing workspace is blocked when native Goal support cannot be confirmed', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, pendingApprovals: 0, goalSupported: null, goal: null });
  await assert.rejects(h.run('saveSettings()'), /verify|Goal/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('an idle conversation can disconnect when native Goals are confirmed unsupported', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, pendingApprovals: 0, goalSupported: false, goal: null });
  await h.run('saveSettings()');
  assert.equal(h.run('settings.workspacePath'), '/new-workspace');
  assert.equal(h.run('settings.threadId'), '');
});

test('an idle conversation can disconnect after fresh state confirms no active Goal or turn', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', goalSupported: true, pendingApprovals: 0, turnId: null, goal: null });
  await h.run('saveSettings()');
  assert.equal(h.run('settings.workspacePath'), '/new-workspace');
  assert.equal(h.run('settings.threadId'), '');
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread","disconnect","save","poll"]');
});
