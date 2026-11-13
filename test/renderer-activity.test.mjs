import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';
function activityHarness() {
  const h = rendererHarness(); h.context.busy = true; h.load('const toolRows =', 'let streamMessage ='); h.run("activityThread('thread-1');startActivity()");
  h.context.agentBuildPreview=null;h.context.previews=[];h.context.cleared=[];
  h.context.showAgentBuildPreview=(value,threadId)=>h.context.previews.push({value,threadId});
  h.context.clearAgentBuildPreview=message=>h.context.cleared.push(message);
  h.context.updateAgentBuildPreviewControls=()=>{};
  h.tool = event => { h.context.event = {id:'tool-1',threadId:'thread-1',turnId:'turn-1',...event}; h.run('toolActivity(event)'); };
  h.notify = (method, params) => { Object.assign(h.context, { method, params }); h.run('notificationActivity(method,params)'); };
  return h;
}
function historyRendererHarness() {
  const h = rendererHarness();
  h.run("let settings = { threadId: 'saved' }; let connected = true; let busy = false;");
  h.load('function addMessage(text, kind = \'system\') {', 'function updateAgentControlButtons() {');
  h.load('function codexEvent(event) {', 'try { initScene(); }');
  return h;
}
test('restores only matching user-facing chat history from a resumed conversation', () => {
  const h = historyRendererHarness();
  h.run(`codexEvent({type:'history',threadId:'saved',available:true,messages:[
    {role:'user',text:'Build the bridge'},
    {role:'assistant',text:'The bridge is ready.'},
    {role:'reasoning',text:'Never display private reasoning'},
  ]})`);
  assert.deepEqual(h.element('chat').children.map(message => [message.className, message.textContent]), [
    ['chat-message user', 'Build the bridge'],
    ['chat-message assistant', 'The bridge is ready.'],
  ]);
  h.run(`codexEvent({type:'history',threadId:'stale',available:true,messages:[{role:'assistant',text:'Stale conversation'}]})`);
  assert.equal(h.element('chat').children.length, 2, 'history from another conversation cannot replace the current chat');
});

test('history replacement avoids duplicates and reports unavailable saved history', () => {
  const h = historyRendererHarness();
  h.run("addMessage('stale cached entry', 'assistant')");
  const history = { type: 'history', threadId: 'saved', available: true, messages: [{ role: 'assistant', text: 'Restored reply' }] };
  h.context.history = history; h.run('codexEvent(history)');
  h.run('codexEvent(history)');
  assert.deepEqual(h.element('chat').children.map(message => message.textContent), ['Restored reply']);
  h.run("codexEvent({type:'history',threadId:'saved',available:false,messages:[]})");
  assert.deepEqual(h.element('chat').children.map(message => [message.className, message.textContent]), [
    ['chat-message system', 'Saved Codex chat history is unavailable.'],
  ]);
});

test('truncated restored chat tells the player older messages remain in Codex', () => {
  const h = historyRendererHarness();
  h.run(`codexEvent({type:'history',threadId:'saved',available:true,truncated:true,messages:[{role:'assistant',text:'Recent reply'}]})`);
  assert.deepEqual(h.element('chat').children.map(message => [message.className, message.textContent]), [
    ['chat-message assistant', 'Recent reply'],
    ['chat-message system', 'Showing recent game chat; older messages remain in Codex.'],
  ]);
});

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

test('world_preview is shown as a local pending set and never claims a server build', () => {
  const h = activityHarness(), design = { objectType:'port', position:{x:12,y:0.5,z:-8}, size:{x:12,y:1,z:8}, color:'#c8a570' };
  const args = { objects:[design] }, response = { previewId:'preview-1', objects:[design] };
  h.tool({ type:'tool-start', name:'world_preview', arguments:args });
  assert.equal(h.element('agent-intent').textContent, 'Preview construction set requested.');
  h.tool({ type:'tool-result', name:'world_preview', arguments:args, result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(response)}]} });
  assert.deepEqual(h.context.previews, [{value:response,threadId:'thread-1'}]);
  assert.equal(h.element('agent-actions').children[0].textContent, 'Complete set previewed locally · waiting for your decision');
  assert.equal(h.element('agent-actions').children[0].dataset.status, 'completed');
  assert.equal(h.context.cleared.length, 0);
});
test('world_apply confirms only a server-returned object set and revision', () => {
  const h = activityHarness();
  h.context.agentBuildPreview = {status:{}};
  h.tool({type:'tool-start',name:'world_apply',arguments:{previewId:'preview-1'}});
  h.tool({type:'tool-result',name:'world_apply',arguments:{previewId:'preview-1'},result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({revision:9,objects:[{id:'port-1',type:'port',position:{x:12,y:0.5,z:-8}}]})}]}});
  assert.equal(h.context.cleared.length,1);
  assert.match(h.context.cleared[0],/Server confirmed 1 object.*revision 9/);
  assert.equal(h.element('agent-actions').children[0].textContent,'Server confirmed 1 approved object · revision 9');
  assert.equal(h.element('agent-actions').children[0].dataset.status,'completed');
});
test('world_apply never confirms malformed output, empty sets, or failed requests', () => {
  for(const result of [
    {success:true,contentItems:[{type:'inputText',text:'{"revision":11}'}]},
    {success:true,contentItems:[{type:'inputText',text:'not JSON'}]},
    {success:true,contentItems:[{type:'inputText',text:'{"revision":11,"objects":[]}'}]},
    {success:false,contentItems:[{type:'inputText',text:'{"revision":11,"objects":[{"id":"x"}]}'}]},
  ]) {
    const h=activityHarness();h.context.agentBuildPreview={status:{textContent:''}};
    h.tool({type:'tool-result',name:'world_apply',arguments:{previewId:'preview-1'},result});
    assert.notEqual(h.element('agent-actions').children[0].dataset.status,'completed');
    assert.equal(h.context.cleared.length,0);
  }
});
test('construction intent uses a fixed label and never exposes arguments', () => {
  const h=activityHarness();h.tool({type:'tool-start',name:'world_preview',arguments:{objects:[{objectType:'SECRET',position:{x:'SECRET',y:0,z:0},color:'SECRET'}]}});
  assert.equal(h.element('agent-intent').textContent,'Preview construction set requested.');
  assert.equal(h.text().includes('SECRET'),false);
});

test('game guide requires in-game approval before the agent applies its preview', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /To construct, call world_preview with the complete set and ask the player to review it/);
  assert.match(main, /Never call world_apply until the player explicitly clicks the in-game Apply button/);
  assert.match(main, /call it exactly once with only the returned previewId/);
  assert.match(main, /Confirm construction only from a successful world_apply server result containing the created objects/);
  assert.match(main, /never build directly or create a new conversation automatically/);
});

function goalContextRendererHarness() {
  const h = rendererHarness();
  h.run("let agentControlState = null, goalMessageContextId = 'goal-1', settings = { threadId: 'saved', agentControlThreadId: 'saved', agentModelId: '', agentEffort: '' }, connected = true, busy = false; function populateAgentEfforts() {} function updateAgentControlButtons() {}");
  h.load('function renderAgentControls(state) {', 'async function refreshAgentControls() {');
  return h;
}
test('a completed native Goal no longer tags later assistant messages as Goal updates', () => {
  const h = goalContextRendererHarness();
  h.run(`renderAgentControls({
    threadId: 'saved', threadStatus: 'idle', pendingApprovals: 0, turnId: null,
    runtime: null, currentModel: null, currentEffort: null, goalSupported: true,
    models: [], goal: { id: 'goal-1', status: 'completed', objective: 'Build the test object' },
  })`);
  assert.equal(h.run('goalMessageContextId'), null);
});


test('refreshing paused Goal controls preserves the in-flight Goal turn context', () => {
  const h = goalContextRendererHarness();
  h.run('busy = true');
  h.run(`renderAgentControls({
    threadId: 'saved', threadStatus: 'active', pendingApprovals: 0, turnId: 'turn-1',
    runtime: null, currentModel: null, currentEffort: null, goalSupported: true,
    models: [], goal: { id: 'goal-1', status: 'paused', objective: 'Build the test object' },
  })`);
  assert.equal(h.run('goalMessageContextId'), 'goal-1');
});

function goalNotificationRendererHarness() {
  const h = rendererHarness();
  h.run("let settings = { threadId: 'saved' }, agentControlState = { goal: { id: 'goal-1', status: 'active' } }, goalMessageContextId = 'goal-1', connected = true, busy = false, agentControlRead = 0; function addMessage() {} function refreshAgentControls() {} function notificationActivity() {} function updateChatControls() {}");
  h.load('function codexEvent(event) {', 'try { initScene(); }');
  return h;
}
test('a completed Goal notification immediately clears Goal message context', () => {
  const h = goalNotificationRendererHarness();
  h.run(`codexEvent({ type: 'notification', method: 'thread/goal/updated', params: {
    threadId: 'saved', goal: { id: 'goal-1', status: 'completed' },
  } })`);
  assert.equal(h.run('goalMessageContextId'), null);
});
