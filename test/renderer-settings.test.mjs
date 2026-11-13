import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function settingsHarness(controlState) {
  const h = rendererHarness();
  Object.assign(h.context, { window: { confirm: () => true } });
  const state = JSON.stringify(controlState);
  h.run(`let settings = { workspacePath: '/old-workspace', codexPath: '/codex', serverUrl: 'http://world-a', token: 'session-token', threadId: 'game-thread' };
let connected = true, busy = false, settingsGeneration = 0, worldRevision = 1, objectSnapshot = '', worldState = {}, meId = 'player';
let playerPosition = { x: 1, y: 0, z: 1 }, playerVelocityY = 0, jumpRequested = false, lastPosition = '', latestStateRevision = 1, localMovementVersion = 0;
let scene = null, calls = [], moveStarts = new Map(), movePreview = null, dragCandidate = null, cancelCount = 0, inspectorDirty = false, editing = false;
function cancelMovePreview() { movePreview = null; dragCandidate = null; cancelCount++; }
const liveControls = ${state};
const bridge = {
  readAgentControls: async threadId => { calls.push('read:' + threadId); return liveControls; },
  disconnectCodex: async () => calls.push('disconnect'),
  connectCodex: async () => { calls.push('connect'); return { threadId: 'game-thread', resumed: true }; },
  saveSettings: async () => calls.push('save'),
};
function updateChatControls() {}
async function poll() { calls.push('poll'); }`);
    h.load('function readSettings() {', 'const updateStatus');
  h.element('workspace').value = '/new-workspace';
  h.element('codex').value = '/codex';
  h.element('server-url').value = 'http://world-a';
  h.element('token').value = 'session-token';
  return h;
}

test('connection settings cannot switch worlds while an object update is pending', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, pendingApprovals: 0, goalSupported: true, goal: null });
  h.run('editing = true');
  await assert.rejects(h.run('saveSettings()'), /object update|Apply|finish/i);
  assert.equal(h.run('JSON.stringify(calls)'), '[]', 'the pending Apply is not disconnected or abandoned');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
});

test('changing workspace is blocked while a native Goal is active', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, goalSupported: true, pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } });
  await assert.rejects(h.run('saveSettings()'), /Goal|pause|wait/i);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
  assert.equal(h.run('settings.threadId'), 'game-thread');
  h.run("movePreview = { objectId: 'shape-1' }");
  await assert.rejects(h.run('saveSettings()'), /Goal|pause|wait/i);
  assert.equal(h.run('cancelCount'), 0, 'a rejected connection change preserves the local proposal');
  assert.ok(h.run('movePreview'));
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

for (const [kind, setup] of [
  ['move preview', "movePreview = { objectId: 'shape-1' }"],
  ['inspector edits', 'inspectorDirty = true'],
]) {
  test(`declining a connection change preserves ${kind}`, async () => {
    const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, pendingApprovals: 0, goalSupported: true, goal: null });
    h.run(setup);
    let prompt = '';
    h.context.window.confirm = message => { prompt = message; return false; };
    await assert.rejects(h.run('saveSettings()'), /cancel|discard|preserved/i);
    assert.match(prompt, /unapplied|draft|world/i);
    assert.equal(h.run('settings.workspacePath'), '/old-workspace');
    assert.equal(h.run('settings.threadId'), 'game-thread');
    assert.equal(h.run('cancelCount'), 0);
    assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
    if (kind === 'move preview') assert.ok(h.run('movePreview'));
    else assert.equal(h.run('inspectorDirty'), true);
  });
}

test('an idle conversation can disconnect after fresh state confirms no active Goal or turn', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', goalSupported: true, pendingApprovals: 0, turnId: null, goal: null });
  h.run("movePreview = { objectId: 'shape-1' }");
  await h.run('saveSettings()');
  assert.equal(h.run('settings.workspacePath'), '/new-workspace');
  assert.equal(h.run('settings.threadId'), '');
  assert.equal(h.run('cancelCount'), 1, 'a confirmed connection change discards the local proposal');
  assert.equal(h.run('movePreview'), null);
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread","disconnect","save","poll"]');
});


test('a disconnected Codex path can be changed while preserving the saved conversation', async () => {
  const h = settingsHarness(null);
  h.run('connected = false');
  h.element('workspace').value = '/old-workspace';
  h.element('codex').value = '/new-codex';
  await h.run('saveSettings()');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls)')), ['disconnect', 'save', 'poll']);
  assert.equal(h.run('settings.codexPath'), '/new-codex');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('a disconnected saved conversation cannot change world or workspace settings while state is unknown', async () => {
  const h = settingsHarness(null);
  h.run('connected = false');
  h.element('workspace').value = '/new-workspace';
  await assert.rejects(h.run('saveSettings()'), /Reconnect Codex before changing world or workspace settings/i);
  assert.equal(h.run('JSON.stringify(calls)'), '[]');
  assert.equal(h.run('settings.workspacePath'), '/old-workspace');
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('a disconnected saved conversation cannot combine Codex recovery with world settings changes', async () => {
  const h = settingsHarness(null);
  h.run('connected = false');
  h.element('workspace').value = '/old-workspace';
  h.element('codex').value = '/new-codex';
  h.element('server-url').value = 'http://world-b';
  await assert.rejects(h.run('saveSettings()'), /Reconnect Codex before changing world or workspace settings/i);
  assert.equal(h.run('JSON.stringify(calls)'), '[]');
  assert.equal(h.run('settings.codexPath'), '/codex');
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('changing Codex path while connected still requires a verified idle conversation', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'active', turnId: 'turn-1', pendingApprovals: 0, goalSupported: true, goal: null });
  h.element('workspace').value = '/old-workspace';
  h.element('codex').value = '/new-codex';
  await assert.rejects(h.run('saveSettings()'), /wait for Codex to become idle/i);
  assert.equal(h.run('settings.codexPath'), '/codex');
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('reconnect requires a verified idle Codex conversation even when settings are unchanged', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'unknown', turnId: null, pendingApprovals: 0, goalSupported: true, goal: null });
  h.element('workspace').value = '/old-workspace';
  h.element('settings').close = () => {};
  h.context.addMessage = () => {};
  await h.element('settings-form').listeners.submit({ preventDefault() {} });
  assert.equal(h.run('JSON.stringify(calls)'), '["read:game-thread"]');
  assert.match(h.element('settings-message').textContent, /activity could not be verified|safely reconnect/i);
  assert.equal(h.run('settings.threadId'), 'game-thread');
});

test('Codex recovery guidance follows the live connection state', () => {
  const h = rendererHarness();
  const recovery = h.element('settings-codex-recovery');
  h.context.connected = true;
  h.run("setAgentStatus('Connected · idle')");
  assert.equal(h.element('settings-codex-status').textContent, 'Connected · idle');
  assert.equal(recovery.hidden, true);
  h.run("setAgentStatus('Connected · activity unknown')");
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /activity.*unknown/i);
  h.context.connected = false;
  h.run("setAgentStatus('Codex disconnected')");
  assert.equal(h.element('settings-codex-status').textContent, 'Codex disconnected');
  assert.equal(recovery.hidden, false);
});

test('opening Settings clears stale connection progress, preserves errors, and syncs recovery guidance', () => {
  const h = rendererHarness();
  let opens = 0;
  h.context.connected = true;
  h.context.agentControlState = { threadStatus: 'idle' };
  h.element('settings').showModal = () => { opens++; };
  h.element('settings-codex-recovery').hidden = false;
  h.element('settings-message').textContent = 'Connecting to your Codex app-server…';
  h.load('function openSettings()', 'function readSettings() {');
  h.element('settings-open').listeners.click();
  assert.equal(h.element('settings-message').textContent, '');
  assert.equal(h.element('settings-codex-recovery').hidden, true);
  assert.equal(opens, 1);
  h.element('settings-message').textContent = 'World settings could not be saved';
  h.element('settings-open').listeners.click();
  assert.equal(h.element('settings-message').textContent, 'World settings could not be saved');
  assert.equal(h.element('settings-codex-recovery').hidden, true);
  assert.equal(opens, 2);
  h.context.connected = false;
  h.element('settings-message').textContent = 'Codex executable is unavailable';
  h.element('settings-codex-recovery').hidden = true;
  h.element('updates-notice').listeners.click();
  assert.equal(h.element('settings-message').textContent, 'Codex executable is unavailable');
  assert.equal(h.element('settings-codex-recovery').hidden, false);
  assert.equal(opens, 3);
});


test('saving world settings reports feedback in the World section', async () => {
  const h = settingsHarness({ connected: true, threadId: 'game-thread', threadStatus: 'idle', turnId: null, pendingApprovals: 0, goalSupported: true, goal: null });
  h.element('workspace').value = '/old-workspace';
  h.load("$('save-world').addEventListener", "$('settings-form').addEventListener");
  await h.element('save-world').listeners.click();
  assert.equal(h.element('world-message').textContent, 'World settings saved. Access token is kept only for this session.');
  assert.equal(h.element('settings-message').textContent, '');
});


test('Cancel discards uncommitted settings values without saving them', () => {
  const h = rendererHarness();
  h.run(`let settings = { workspacePath: '/saved-workspace', codexPath: '/saved-codex', serverUrl: 'http://saved-world', token: 'saved-token', lightingQuality: 'reduced', updateChannel: 'prerelease' };
let connected = false;`);
  h.load('function openSettings()', 'function readSettings() {');
  let closeEvents = 0;
  h.element('settings').close = () => {
    closeEvents++;
    h.element('settings').listeners.close?.();
  };
  h.element('workspace').value = '/unsaved-workspace';
  h.element('codex').value = '/unsaved-codex';
  h.element('server-url').value = 'http://unsaved-world';
  h.element('token').value = 'unsaved-token';
  h.element('lighting-quality').value = 'full';
  h.element('update-channel').value = 'stable';
  h.element('update-distribution').value = 'portable';
  h.element('new-game-thread').checked = true;

  h.element('settings-close').listeners.click();

  assert.equal(closeEvents, 1);
  assert.equal(h.element('workspace').value, '/saved-workspace');
  assert.equal(h.element('codex').value, '/saved-codex');
  assert.equal(h.element('server-url').value, 'http://saved-world');
  assert.equal(h.element('token').value, 'saved-token');
  assert.equal(h.element('lighting-quality').value, 'reduced');
  assert.equal(h.element('update-channel').value, 'prerelease');
  assert.equal(h.element('update-distribution').value, 'installer');
  assert.equal(h.element('new-game-thread').checked, false);
});
