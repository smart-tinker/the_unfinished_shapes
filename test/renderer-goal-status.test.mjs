import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function harness() {
  const h = rendererHarness();
  h.run(`let settings = { threadId: 'thread-1' }, connected = false, busy = false, streamMessage = null, agentControlState = null, goalMessageContextId = null, agentControlRead = 0, ordinaryTurn = false;
    let bridge = { sendPrompt: async () => ({ sceneContext: { revision: 1, selectedCount: 0, includedObjectCount: 0, totalObjectCount: 0, truncated: false } }) };
    function sceneContextForPrompt() { return {}; } function startActivity() {}
    function activityThread() {} function refreshAgentControls() {} function updateChatControls() {}
    function notificationActivity() {} function toolActivity() {} function addMessage() {}`);
  h.load("$('chat-form').addEventListener('submit'", "$('interrupt').addEventListener('click'");
  h.load('function codexEvent(event) {', 'try { initScene(); }');
  return h;
}

test('Settings mirrors the live Codex status from the companion panel', () => {
  const h = rendererHarness();
  h.run("let connected = true, busy = false, agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: null }, goalMessageContextId = null; refreshAgentStatus()");
  assert.equal(h.element('agent-status').textContent, 'Connected · idle');
  assert.equal(h.element('settings-codex-status').textContent, 'Connected · idle');
  h.run("connected = false; refreshAgentStatus()");
  assert.equal(h.element('settings-codex-status').textContent, 'Codex disconnected');
});

test('a new Codex connection reports unknown activity until state is confirmed', () => {
  const h = harness();
  h.run("codexEvent({ type: 'connected', threadId: 'thread-1' })");
  assert.equal(h.element('agent-status').textContent, 'Connected · activity unknown');
});

test('the status distinguishes normal turns from an active native Goal', () => {
  const h = harness();
  h.run("codexEvent({ type: 'connected', threadId: 'thread-1' }); agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: null };");
  h.run("codexEvent({ type: 'notification', method: 'turn/started', params: { threadId: 'thread-1' } })");
  assert.equal(h.element('agent-status').textContent, 'Working on your request…');
  h.run("agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } }; busy = false; codexEvent({ type: 'notification', method: 'thread/goal/updated', params: { threadId: 'thread-1', goal: { id: 'goal-1', status: 'active' } } })");
  assert.equal(h.element('agent-status').textContent, 'Native Goal active');
  h.run("codexEvent({ type: 'notification', method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })");
  assert.equal(h.element('agent-status').textContent, 'Native Goal active');
});

test('an ordinary request is not labeled as Goal work while an active Goal exists', async () => {
  const h = harness();
  h.run(`connected = true;
    agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } };
    goalMessageContextId = 'goal-1'; $('prompt').value = 'Inspect this object';
    let capturedMessages = [];
    addMessage = (text, kind = 'system') => { const message = { textContent: text, kind, querySelector: () => null }; capturedMessages.push(message); return message; };`);
  await h.element('chat-form').listeners.submit({ preventDefault() {} });
  h.run("codexEvent({ type: 'notification', method: 'turn/started', params: { threadId: 'thread-1' } })");
  assert.equal(h.element('agent-status').textContent, 'Codex turn in progress');
  h.run("codexEvent({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Here is the result.' } })");
  assert.equal(h.run('capturedMessages[1].kind'), 'assistant');
  h.run("streamMessage = null; codexEvent({ type: 'notification', method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Complete reply.' } } })");
  assert.equal(h.run('capturedMessages[2].kind'), 'assistant');
});

test('disconnect never presents the agent as idle or the Goal as stopped', () => {
  const h = harness();
  h.run("codexEvent({ type: 'connected', threadId: 'thread-1' }); agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } }; codexEvent({ type: 'disconnected' })");
  assert.equal(h.element('agent-status').textContent, 'Codex disconnected · activity unknown');
  assert.equal(h.element('settings-codex-status').textContent, 'Codex disconnected · activity unknown');
});

function goalTurnHarness() {
  const h = harness();
  h.run(`connected = true;
    agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } };
    goalMessageContextId = 'goal-1';
    let capturedMessages = [];
    addMessage = (text, kind = 'system') => { const message = { textContent: text, kind, querySelector: () => null }; capturedMessages.push(message); return message; }`);
  h.run("codexEvent({ type: 'notification', method: 'turn/started', params: { threadId: 'thread-1' } })");
  return h;
}

test('pausing a Goal does not relabel its running turn or replies as ordinary work', () => {
  const h = goalTurnHarness();
  h.run("codexEvent({ type: 'notification', method: 'thread/goal/updated', params: { threadId: 'thread-1', goal: { id: 'goal-1', status: 'paused' } } })");
  assert.equal(h.element('agent-status').textContent, 'Codex turn in progress');
  h.run("codexEvent({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Goal progress.' } })");
  assert.equal(h.run("capturedMessages.some(message => message.kind === 'goal')"), true);
});

test('clearing a Goal does not relabel its running turn or replies as ordinary work', () => {
  const h = goalTurnHarness();
  h.run("codexEvent({ type: 'notification', method: 'thread/goal/cleared', params: { threadId: 'thread-1' } })");
  assert.equal(h.element('agent-status').textContent, 'Codex turn in progress');
  h.run("codexEvent({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Goal progress.' } })");
  assert.equal(h.run("capturedMessages.some(message => message.kind === 'goal')"), true);
});
