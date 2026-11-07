import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';
function activityHarness() {
  const h = rendererHarness(); h.context.busy = true; h.load('const toolRows =', 'let streamMessage ='); h.run("activityThread('thread-1');startActivity()");
  h.tool = event => { h.context.event = {id:'tool-1',threadId:'thread-1',turnId:'turn-1',...event}; h.run('toolActivity(event)'); };
  h.notify = (method, params) => { Object.assign(h.context, { method, params }); h.run('notificationActivity(method,params)'); };
  return h;
}
test('activity shows requested command intent and only structured result evidence', () => {
  const h = activityHarness();
  h.tool({ type: 'tool-start', name: 'world_command', arguments: { command: { type: 'update', secret: 'SECRET' } } });
  assert.equal(h.element('agent-intent').textContent, 'Edit shape requested.');
  assert.equal(h.element('agent-actions').children[0].dataset.status, 'running');
  h.tool({ type: 'tool-result', name: 'world_command', arguments: { command: { type: 'update' } }, result: { success: true, contentItems: [{ type: 'inputText', text: '{"revision":7,"token":"SECRET"}' }] } });
  assert.equal(h.element('agent-actions').children[0].textContent, 'Edit shape · completed · revision 7');
  assert.equal(h.text().includes('SECRET'), false);
});
test('failed and malformed tool outcomes do not expose raw output or claim success', () => {
  const h = activityHarness();
  h.tool({ type: 'tool-result', name: 'world_command', arguments: 'SECRET INVALID JSON', result: { success: false, contentItems: [{ type: 'inputText', text: 'SECRET raw output' }] } });
  assert.equal(h.element('agent-actions').children[0].dataset.status, 'failed');
  assert.equal(h.text().includes('SECRET'), false);
  assert.match(h.element('agent-stop-reason').textContent, /turn may continue/);
});
test('explicit public plan is visible, private reasoning and summaries are ignored', () => {
  const h = activityHarness();
  for (const method of ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded']) h.notify(method, { delta: 'PRIVATE REASONING', text: 'PRIVATE REASONING' });
  h.notify('item/completed', { item: { id: 'reasoning-1', type: 'reasoning', text: 'PRIVATE REASONING', summary: ['PRIVATE REASONING'] } });
  assert.equal(h.text().includes('PRIVATE REASONING'), false);
  assert.equal(h.element('agent-actions').children.length, 0);
  h.notify('turn/plan/updated', { plan: [{ step: 'Move the selected block', status: 'pending' }] });
  assert.equal(h.element('agent-plan').children[0].textContent, 'Move the selected block (pending)');
  assert.equal(h.element('agent-plan').hidden, false);
});
test('command results expose category and exit code, not command text or file content', () => {
  const h = activityHarness();
  h.notify('item/started', { item: { id: 'cmd-1', type: 'commandExecution', command: 'SECRET' } });
  h.notify('item/completed', { item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', exitCode: 3, aggregatedOutput: 'SECRET' } });
  assert.equal(h.element('agent-actions').children[0].dataset.status, 'failed');
  assert.match(h.element('agent-actions').children[0].textContent, /exit 3/);
  assert.equal(h.text().includes('SECRET'), false);
});
test('turn stop reason distinguishes interruption, error, completion and unknown outcome', () => {
  const h = activityHarness();
  h.run('stopRequested=true'); h.notify('turn/completed', { turn: { status: 'interrupted' } });
  assert.match(h.element('agent-stop-reason').textContent, /at your request/);
  h.notify('turn/completed', { turn: { status: 'failed', error: { message: 'internal detail' } } });
  assert.equal(h.element('activity-state').textContent, 'Failed');
  h.notify('turn/completed', { turn: { status: 'completed' } });
  assert.match(h.element('agent-stop-reason').textContent, /does not mean code changes were deployed/);
  h.notify('turn/completed', { turn: {} });
  assert.match(h.element('agent-stop-reason').textContent, /did not provide a recognized/);
});
test('new request clears previous action list and caps event history', () => {
  const h = activityHarness(); for (let i = 0; i < 45; i++) h.tool({ type: 'tool-start', name: 'world_state', id: `tool-${i}` });
  assert.equal(h.element('agent-actions').children.length, 40);
  h.run('startActivity()'); assert.equal(h.element('agent-actions').children.length, 0);
  assert.equal(h.element('activity-state').textContent, 'Requested');
});

test('same-label tools correlate by request id even when results finish out of order', () => {
  const h = activityHarness();
  for (const id of ['first','second']) h.tool({ type: 'tool-start', id, name: 'world_state' });
  h.tool({ type: 'tool-result', id:'second', name:'world_state', result:{success:false} });
  h.tool({ type: 'tool-result', id:'first', name:'world_state', result:{success:true} });
  assert.equal(h.element('agent-actions').children.length,2);
  assert.equal(h.element('agent-actions').children[0].dataset.status,'completed');
  assert.equal(h.element('agent-actions').children[1].dataset.status,'failed');
});
test('late prior-turn and foreign-thread results cannot enter a new request activity', () => {
  const h = activityHarness(); h.tool({ type:'tool-start',name:'world_state' });
  h.run('startActivity()');
  h.tool({ type:'tool-result',name:'world_state',result:{success:true} });
  h.tool({ type:'tool-start',name:'world_state',threadId:'foreign',turnId:'turn-2' });
  assert.equal(h.element('agent-actions').children.length,0);
  h.tool({ type:'tool-start',name:'world_state',turnId:'turn-2' });
  h.tool({ type:'tool-result',name:'world_state',turnId:'turn-1',result:{success:true} });
  assert.equal(h.element('agent-actions').children.length,1);
  assert.equal(h.element('agent-actions').children[0].dataset.status,'running');
});
