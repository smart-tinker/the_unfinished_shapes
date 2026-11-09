import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { realpath } from 'node:fs/promises';
import { CodexBridge, WORLD_TOOLS } from '../src/codex.mjs';

const cwd = await realpath(process.cwd());
function fixture(handler = () => undefined, timeoutMs = 500) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const requests = [];
  const reply = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const m = JSON.parse(line); requests.push(m);
      if (!m.method || !('id' in m)) continue;
      const response = handler(m, reply);
      if (response === false) continue;
      const result = response ?? ({
        initialize: {}, 'thread/list': {data: [], nextCursor: null},
        'thread/start': { thread: {id: 'new-thread', cwd, status: {type: 'idle'}} },
        'thread/resume': { thread: {id: m.params.threadId, cwd, status: {type: 'idle'}} },
        'thread/read': { thread: {id: m.params.threadId, cwd, status: {type: 'idle'}} },
        'turn/start': {turn: {id: 'turn1', status: 'inProgress'}}, 'turn/interrupt': {},
      }[m.method]);
      queueMicrotask(() => reply({id: m.id, result}));
    }
  });
  let spawnOptions;
  const bridge = new CodexBridge({timeoutMs, spawnProcess: (executable,args,options) => {
    assert.equal(executable, process.execPath); assert.deepEqual(args,['app-server']);
    spawnOptions = options; return child;
  }});
  return {bridge, requests, child, reply, options:()=>spawnOptions,
    start: (extra={}) => bridge.start({codexPath:process.execPath, workspacePath:cwd, ...extra})};
}

test('connect initializes, starts workspace without invoking a model, and whitelists environment', async () => {
  const f = fixture(); const events=[]; f.bridge.on('event',e=>events.push(e));
  const result = await f.start({env:{TUS_WORLD_URL:'http://localhost:1234',TUS_WORLD_TOKEN:'test',UNSAFE_SETTING:'x'}});
  assert.equal(result.threadId,'new-thread');
  assert.deepEqual(f.requests.map(x=>x.method),['initialize','initialized','thread/list','thread/start']);
  assert.equal(f.options().shell,false); assert.equal(f.options().env.TUS_WORLD_TOKEN,'test');
  assert.equal(f.options().env.UNSAFE_SETTING,undefined);
  assert.equal(events.at(-1).type,'connected');
  const params=f.requests.find(x=>x.method==='thread/start').params;
  assert.equal(params.sandbox,'workspace-write'); assert.equal(params.approvalPolicy,'on-request');
  assert.match(params.developerInstructions,/call world_state before changing the world/);
  f.bridge.stop(); assert.equal(f.child.killed,true);
});

test('paginates and requests explicit fresh game thread rather than changing existing history',async()=>{
  const f=fixture(m=>m.method==='thread/list' ? (m.params.cursor ? {data:[{id:'idle',cwd,status:{type:'idle'}}]} : {data:[{id:'busy',cwd,status:{type:'active'}}],nextCursor:'page2'}) : undefined);
  await assert.rejects(f.start(),/New game conversation/);
  assert.equal(f.requests.some(x=>x.method==='thread/resume'),false);
  assert.equal(f.requests.filter(x=>x.method==='thread/list').length,2);
  assert.equal(f.requests.find(x=>x.method==='thread/list').params.sortKey,'updated_at');
  f.bridge.stop();
});

test('saved ID is stable and wrong workspace/active threads fail without fallback',async()=>{
  for (const bad of [{cwd:'/different',status:{type:'idle'}},{cwd,status:{type:'active'}}]) {
    const f=fixture(m=>m.method==='thread/read'?{thread:{id:'saved',...bad}}:undefined);
    await assert.rejects(f.start({threadId:'saved'}));
    assert.equal(f.requests.some(x=>x.method==='thread/start'),false);
    assert.equal(f.child.killed,true);
  }
  const f=fixture(); assert.equal((await f.start({threadId:'saved'})).threadId,'saved');
  assert.equal(f.requests.some(x=>x.method==='thread/list'),false);
  assert.match(f.requests.find(x=>x.method==='thread/resume').params.developerInstructions,/call world_state before changing the world/);
  f.bridge.stop();
});

test('resuming a game conversation restores only user-facing history in chronological order', async () => {
  const pages = [
    { data: [
      { turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Build a bridge' }] } },
      { turnId: 'turn-1', item: { id: 'reasoning-1', type: 'reasoning', summary: 'Never display reasoning' } },
      { turnId: 'turn-1', item: { id: 'tool-1', type: 'dynamicToolCall', tool: 'world_state', arguments: {} } },
      { turnId: 'turn-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'I will build it.' } },
    ], nextCursor: 'items-page-2' },
    { data: [
      { turnId: 'turn-2', item: { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Widen it' }] } },
      { turnId: 'turn-2', item: { id: 'assistant-2', type: 'agentMessage', text: 'The bridge is wider.', phase: 'final_answer' } },
    ], nextCursor: null },
  ];
  const f = fixture(m => m.method === 'thread/items/list' ? (m.params.cursor === 'items-page-2' ? pages[1] : pages[0]) : undefined);
  const events = [];
  f.bridge.on('event', event => events.push(event));
  await f.start({ threadId: 'saved' });
  const history = events.find(event => event.type === 'history');
  assert.deepEqual(history, {
    type: 'history',
    threadId: 'saved',
    messages: [
      { role: 'user', text: 'Build a bridge' },
      { role: 'assistant', text: 'I will build it.' },
      { role: 'user', text: 'Widen it' },
      { role: 'assistant', text: 'The bridge is wider.' },
    ],
  });
  const resume = f.requests.find(request => request.method === 'thread/resume');
  assert.equal(resume.params.excludeTurns, true, 'paginated history is loaded without a deprecated full-thread response');
  const pagesRead = f.requests.filter(request => request.method === 'thread/items/list');
  assert.equal(pagesRead.length, 2);
  assert.ok(pagesRead.every(request => request.params.threadId === 'saved' && request.params.sortDirection === 'asc'));
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false, 'restoring chat must not start another turn');
  f.bridge.stop();
});

test('a history API error keeps the saved conversation connected and reports history unavailable', async () => {
  const f = fixture((message, reply) => {
    if (message.method === 'thread/items/list') {
      queueMicrotask(() => reply({ id: message.id, error: { code: -32601, message: 'Method not found' } }));
      return false;
    }
  });
  const events = [];
  f.bridge.on('event', event => events.push(event));
  const result = await f.start({ threadId: 'saved' });
  assert.equal(result.threadId, 'saved');
  assert.ok(f.bridge.process, 'history failure must not disconnect the conversation');
  assert.deepEqual(events.map(event => event.type), ['connected', 'history']);
  assert.deepEqual(events[1], { type: 'history', threadId: 'saved', available: false, messages: [] });
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  f.bridge.stop();
});

test('explicit send, duplicate send protection, interrupt, completion',async()=>{
  const f=fixture(); await f.start();
  await f.bridge.send('Build a bridge');
  await assert.rejects(f.bridge.send('duplicate'),/already running/);
  assert.equal(await f.bridge.interrupt(),true);
  f.reply({method:'turn/completed',params:{threadId:'new-thread',turn:{id:'turn1'}}});
  assert.equal(f.bridge.turnId,null);
  await f.bridge.send('Next request'); f.bridge.stop();
});

test('server approvals stay pending until an explicit matching response',async()=>{
  const f=fixture(); await f.start(); const events=[]; f.bridge.on('event',e=>events.push(e));
  const before=f.requests.length;
  f.reply({id:77,method:'item/commandExecution/requestApproval',params:{command:'test'}});
  assert.equal(f.requests.length,before); assert.equal(events[0].type,'approval');
  assert.throws(()=>f.bridge.respond(99,{decision:'accept'}),/no longer pending/);
  f.bridge.respond(77,{decision:'decline'});
  assert.deepEqual(f.requests.at(-1),{id:77,result:{decision:'decline'}});
  assert.throws(()=>f.bridge.respond(77,{decision:'accept'})); f.bridge.stop();
});

test('malformed protocol, request timeout and exit reject pending requests and disconnect',async()=>{
  const malformed=fixture(()=>false); const p=malformed.start();
  await new Promise(r=>setTimeout(r,10)); malformed.child.stdout.write('not json\n');
  await assert.rejects(p,/malformed/); assert.equal(malformed.child.killed,true);
  const timed=fixture(()=>false,20); await assert.rejects(timed.start(),/timed out/);
  const exited=fixture(request=>{
    if(request.method==='initialize') queueMicrotask(()=>exited.child.emit('exit',1));
    return false;
  });
  await assert.rejects(exited.start(),/exited/);
});

test('invalid paths do not start a process',async()=>{
  const f=fixture(); await assert.rejects(f.start({codexPath:'codex'}),/absolute/);
  await assert.rejects(f.start({workspacePath:'/definitely-not-existing-tus'}));
  assert.equal(f.options(),undefined);
});

test('stop during connection does not resurrect a child process',async()=>{
  const f=fixture(); const promise=f.start(); f.bridge.stop();
  await assert.rejects(promise,/cancelled/); assert.equal(f.options(),undefined);
});

test('completion arriving before turn start response does not leave bridge busy',async()=>{
  const f=fixture((m,reply)=>{
    if(m.method==='turn/start') {
      reply({method:'turn/completed',params:{threadId:'new-thread',turn:{id:'turn1'}}});
      return {turn:{id:'turn1',status:'inProgress'}};
    }
  });
  await f.start(); await f.bridge.send('Hello'); assert.equal(f.bridge.turnId,null);
  await f.bridge.send('Again'); f.bridge.stop();
});

test('fresh game thread registers dynamic tools without selecting arbitrary history',async()=>{
  const f=fixture(); await f.start({newGameThread:true});
  assert.equal(f.requests.some(m=>m.method==='thread/list'),false);
  const init=f.requests.find(m=>m.method==='initialize'); assert.equal(init.params.capabilities.experimentalApi,true);
  const start=f.requests.find(m=>m.method==='thread/start');
  assert.deepEqual(start.params.dynamicTools.map(t=>t.name),['world_state','world_build','world_command']);
  assert.ok(start.params.dynamicTools.every(t=>t.type==='function' && t.inputSchema.type==='object'));
  f.bridge.stop();
});

test('dynamic tools route separately with exact arguments and structured response',async()=>{
  const f=fixture(); await f.start({newGameThread:true}); await f.bridge.send('Build a port');
  const events=[];f.bridge.on('event',e=>events.push(e));
  const args={command:{type:'build',objectType:'port',position:{x:0,y:0,z:0}}};
  f.reply({id:88,method:'item/tool/call',params:{threadId:'new-thread',turnId:'turn1',callId:'call',tool:'world_command',arguments:args}});
  assert.deepEqual(events[0],{type:'tool',id:88,name:'world_command',arguments:args,threadId:'new-thread',turnId:'turn1'});
  f.bridge.respond(88,{success:true,contentItems:[{type:'inputText',text:'{"revision":1}'}]});
  assert.equal(f.requests.at(-1).result.success,true); f.bridge.stop();
});

test('tool calls cannot run outside an explicit turn, from another thread or namespace',async()=>{
  const f=fixture(); await f.start(); const events=[];f.bridge.on('event',e=>events.push(e));
  const params={threadId:'new-thread',turnId:'turn1',callId:'call',tool:'world_state',arguments:{}};
  f.reply({id:91,method:'item/tool/call',params});
  assert.equal(f.requests.at(-1).result.success,false); assert.equal(events.length,0);
  await f.bridge.send('Read the world');
  for(const overrides of [{threadId:'other'},{namespace:'other'},{tool:'exec_anything'},{turnId:'other'}]) {
    f.reply({id:92,method:'item/tool/call',params:{...params,...overrides}});
    assert.equal(f.requests.at(-1).result.success,false);
  }
  assert.equal(events.length,0);f.bridge.stop();
});

test('world tool schema exposes explicit flat operations without ownership mutation',()=>{
 const command=WORLD_TOOLS.find(t=>t.name==='world_command').inputSchema.properties.command;
 assert.equal(command.type,'object');assert.equal(command.oneOf,undefined);assert.equal(command.anyOf,undefined);
 assert.deepEqual(command.properties.type.enum,['move','update','remove']);
 assert.match(command.properties.type.description,/move the player only/);
 assert.deepEqual(command.required,['type']);
 assert.equal(command.additionalProperties,false);assert.equal(command.properties.ownerId,undefined);
 assert.deepEqual(command.properties.expected.properties.position.properties.x,{type:'number'});
 assert.equal(command.properties.expected.additionalProperties,false);
 assert.match(command.properties.expected.description,/Required for update/);
 assert.equal(command.properties.objectType,undefined);
});

test('world_build requires every design field and general command cannot advertise build',()=>{
 const build=WORLD_TOOLS.find(t=>t.name==='world_build').inputSchema;
 assert.deepEqual(build.required,['objectType','position','size','color']);assert.equal(build.additionalProperties,false);
 assert.deepEqual(build.properties.objectType.enum,['block','bridge','port']);assert.equal(build.properties.color.type,'string');
 const command=WORLD_TOOLS.find(t=>t.name==='world_command').inputSchema.properties.command;
 assert.equal(command.properties.type.enum.includes('build'),false);
});
