import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorldServer } from '../src/server.mjs';
import { createGameToolSession, executeGameTool } from '../src/game-tools.mjs';

test('two approved agent builds retain a shared world across restart and cannot edit each other through agent tools', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tus-two-builders-'));
  const users = { 'synthetic-alice-token': { id: 'alice', role: 'builder' }, 'synthetic-bob-token': { id: 'bob', role: 'builder' } };
  const config = { dataPath: path.join(dir, 'world.json'), users, port: 0 };
  let server = await createWorldServer(config); await server.start();
  const sessions = [];
  t.after(async () => { for (const session of sessions) session.clear(); if (server.listening) await server.shutdown(); await rm(dir, { recursive: true, force: true }); });
  let url = 'http://127.0.0.1:' + server.address().port;
  const connection = id => ({ url, token: 'synthetic-' + id + '-token' });
  const get = async id => { const r = await fetch(url + '/state', { headers: { Authorization: 'Bearer ' + connection(id).token } }); assert.equal(r.status, 200); return r.json(); };
  const build = async id => {
    const threadId = 'thread-' + id, session = createGameToolSession(connection(id));
    sessions.push(session);
    const design = { objectType: 'block', position: { x: id === 'alice' ? 3 : -3, y: 1, z: 4 }, size: { x: 2, y: 2, z: 2 }, color: '#3366cc' };
    const preview = await session.execute({ name: 'world_preview', threadId, arguments: { objects: [design] } });
    assert.equal(preview.success, true);
    const { previewId } = JSON.parse(preview.contentItems.find(item => item.type === 'inputText').text);
    session.decide(previewId, 'apply', threadId);
    return session.execute({ name: 'world_apply', threadId, arguments: { previewId } });
  };
  const results = [await build('alice'), await build('bob')];
  assert.ok(results.every(r => r.success === true));
  const before = await get('alice');
  assert.equal(before.objects.length, 2);
  assert.deepEqual((await get('bob')).objects, before.objects);
  const aliceObject = before.objects.find(o => o.ownerId === 'alice');
  for (const command of [{ type: 'update', id: aliceObject.id, color: '#ff0000', expected: { color: aliceObject.color } }, { type: 'remove', id: aliceObject.id }]) {
    const denied = await executeGameTool({ name: 'world_command', arguments: { command } }, connection('bob'));
    assert.equal(denied.success, false, 'agent must not acquire another player permissions');
    assert.equal(JSON.parse(denied.contentItems.find(item => item.type === 'inputText').text).error, 'forbidden', 'denial must come from server ownership rules');
  }
  const unchanged = await get('bob');
  assert.equal(unchanged.revision, before.revision);
  assert.deepEqual(unchanged.objects, before.objects);
  await server.shutdown(); server = await createWorldServer(config); await server.start();
  url = 'http://127.0.0.1:' + server.address().port;
  for (const id of ['alice', 'bob']) {
    const restored = await get(id);
    assert.equal(restored.me.id, id); assert.deepEqual(restored.objects, before.objects);
  }
});

test('manual and agent clients share movement speed, island bounds, and persisted position',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tus-shared-movement-'));
  const users={'synthetic-alice-token':{id:'alice',role:'builder'},'synthetic-bob-token':{id:'bob',role:'builder'}};
  const config={dataPath:path.join(dir,'world.json'),users,port:0};
  let server=await createWorldServer(config); await server.start();
  t.after(async()=>{if(server.listening)await server.shutdown();await rm(dir,{recursive:true,force:true});});
  let url='http://127.0.0.1:'+server.address().port;
  const connection=id=>({url,token:'synthetic-'+id+'-token'});
  const target={type:'move',position:{x:1000,y:999,z:0}};
  const manual=async()=>{const r=await fetch(url+'/command',{method:'POST',headers:{Authorization:'Bearer '+connection('alice').token,'Content-Type':'application/json'},body:JSON.stringify(target)});assert.equal(r.status,200);return r.json();};
  const agent=async()=>{const r=await executeGameTool({name:'world_command',arguments:{command:target}},connection('bob'));assert.equal(r.success,true);return JSON.parse(r.contentItems.find(item=>item.type==='inputText').text);};
  assert.deepEqual((await manual()).position,{x:0,y:0,z:0});
  assert.deepEqual((await agent()).position,{x:0,y:0,z:0});
  await new Promise(resolve=>setTimeout(resolve,260));
  const [manualStep,agentStep]=await Promise.all([manual(),agent()]);
  assert.deepEqual(agentStep.position,manualStep.position);
  assert.ok(Math.hypot(manualStep.position.x,manualStep.position.z)<=1.25+1e-6,JSON.stringify(manualStep.position));
  assert.equal(manualStep.position.y,0);
  const [aliceState,bobState]=await Promise.all(['alice','bob'].map(async id=>{const r=await fetch(url+'/state',{headers:{Authorization:'Bearer '+connection(id).token}});assert.equal(r.status,200);return r.json();}));
  assert.deepEqual(aliceState.players.find(player=>player.id==='alice').position,manualStep.position);
  assert.deepEqual(bobState.players.find(player=>player.id==='bob').position,agentStep.position);
  await server.shutdown(); server=await createWorldServer(config); await server.start(); url='http://127.0.0.1:'+server.address().port;
  const restored=await (await fetch(url+'/state',{headers:{Authorization:'Bearer '+connection('alice').token}})).json();
  assert.deepEqual(restored.players.find(player=>player.id==='alice').position,manualStep.position);
  assert.deepEqual(restored.players.find(player=>player.id==='bob').position,agentStep.position);
});


test('two clients observe identical door state and the open state survives restart',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'tus-shared-door-'));
 const users={'synthetic-alice-token':{id:'alice',role:'builder'},'synthetic-bob-token':{id:'bob',role:'builder'}};
 const config={dataPath:path.join(dir,'world.json'),users,port:0};
 let server=await createWorldServer(config);await server.start();
 const session=createGameToolSession({url:'http://127.0.0.1:'+server.address().port,token:'synthetic-alice-token'});
 t.after(async()=>{session.clear();if(server.listening)await server.shutdown();await rm(dir,{recursive:true,force:true});});
 let url='http://127.0.0.1:'+server.address().port;
 const state=async id=>{const result=await executeGameTool({name:'world_state',arguments:{}},{url,token:'synthetic-'+id+'-token'});assert.equal(result.success,true);return JSON.parse(result.contentItems[0].text);};
 const preview=await session.execute({name:'world_preview',threadId:'alice-door',arguments:{objects:[
  {objectType:'door',position:{x:0,y:1.5,z:0},size:{x:1,y:3,z:.25},color:'#886644'},
 ]}});
 assert.equal(preview.success,true);
 const {previewId}=JSON.parse(preview.contentItems[0].text);session.decide(previewId,'apply','alice-door');
 assert.equal((await session.execute({name:'world_apply',threadId:'alice-door',arguments:{previewId} })).success,true);
 const before=await state('bob'),door=before.objects.find(object=>object.type==='door');
 assert.equal(door.state,'closed');assert.equal(door.blocksMovement,true);
 const opened=await executeGameTool({name:'world_command',arguments:{command:{type:'set_state',id:door.id,state:'open',expectedVersion:door.version}}},{url,token:'synthetic-alice-token'});
 assert.equal(opened.success,true);
 const [alice,bob]=await Promise.all([state('alice'),state('bob')]);
 for(const world of [alice,bob]){const shared=world.objects.find(object=>object.id===door.id);assert.equal(shared.state,'open');assert.equal(shared.blocksMovement,false);}
 await server.shutdown();server=await createWorldServer(config);await server.start();url='http://127.0.0.1:'+server.address().port;
 for(const id of ['alice','bob']){const restored=await state(id);const shared=restored.objects.find(object=>object.id===door.id);assert.equal(shared.state,'open');assert.equal(shared.version,1);}
});
