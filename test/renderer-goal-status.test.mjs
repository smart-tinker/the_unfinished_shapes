import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function harness() {
  const h = rendererHarness();
  h.run(`let settings = { threadId: 'thread-1' }, connected = false, busy = false, streamMessage = null, agentControlState = null, goalMessageContextId = null;
    function activityThread() {} function refreshAgentControls() {} function updateChatControls() {}
    function notificationActivity() {} function toolActivity() {} function addMessage() {}`);
  h.load('function codexEvent(event) {', 'try { initScene(); }');
  return h;
}

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

test('disconnect never presents the agent as idle or the Goal as stopped', () => {
  const h = harness();
  h.run("codexEvent({ type: 'connected', threadId: 'thread-1' }); agentControlState = { threadStatus: 'idle', pendingApprovals: 0, goal: { id: 'goal-1', status: 'active' } }; codexEvent({ type: 'disconnected' })");
  assert.equal(h.element('agent-status').textContent, 'Codex disconnected');
});
