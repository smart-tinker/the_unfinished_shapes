import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorldServer} from '../src/server.mjs';
const token='test-only-alice-token';
const users={[token]:{id:'alice',role:'builder'},'test-only-bob-token':{id:'bob',role:'viewer'}};
const command={type:'build',objectType:'port',position:{x:1,y:0,z:1}};
async function fixture(t, options={}) {
 const dir=await mkdtemp(path.join(tmpdir(),'shapes-test-')); const dataPath=path.join(dir,'world.json');
 const app=await createWorldServer({dataPath,users,port:0,...options});await app.start();
 t.after(async()=>{if(app.listening)await app.shutdown();await rm(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${app.address().port}`;
 const send=(body,auth=token)=>fetch(url+'/command',{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {app,url,dataPath,send};
}
test('auth, persisted builds, and concurrent updates',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.url+'/state')).status,401);
 assert.equal((await f.send(command,'test-only-bob-token')).status,403);
 const results=await Promise.all(Array.from({length:10},()=>f.send(command)));
 assert.ok(results.every(r=>r.status===200));
 const state=await (await fetch(f.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json();
 assert.equal(state.revision,10);assert.equal(state.objects.length,10);assert.equal(state.me.id,'alice');
 assert.equal(JSON.parse(await readFile(f.dataPath,'utf8')).revision,10);
 await f.app.shutdown();
 const restarted=await createWorldServer({dataPath:f.dataPath,users,port:0});await restarted.start();
 const saved=await (await fetch(`http://127.0.0.1:${restarted.address().port}/state`,{headers:{Authorization:`Bearer ${token}`}})).json();
 assert.equal(saved.objects.length,10);await restarted.shutdown();
});
test('HTTP build_group is atomic, visible to another client, and survives restart',async t=>{
 const f=await fixture(t);
 const objects=[
  {objectType:'block',position:{x:0,y:1,z:0},size:{x:2,y:2,z:2},color:'#123456'},
  {objectType:'bridge',position:{x:8,y:1,z:0},size:{x:10,y:1,z:3},color:'#654321'},
 ];
 const response=await f.send({type:'build_group',objects});
 assert.equal(response.status,200);
 const applied=await response.json();assert.equal(applied.revision,1);assert.equal(applied.objects.length,2);
 assert.deepEqual(applied.objects.map(object=>object.ownerId),['alice','alice']);
 const visible=await (await fetch(f.url+'/state',{headers:{Authorization:'Bearer test-only-bob-token'}})).json();
 assert.deepEqual(visible.objects,applied.objects);assert.equal(visible.revision,1);
 const invalid=await f.send({type:'build_group',objects:[objects[0],{...objects[1],objectType:'unknown'}]});
 assert.equal(invalid.status,409);
 const saved=JSON.parse(await readFile(f.dataPath,'utf8'));
 assert.equal(saved.revision,1);assert.deepEqual(saved.objects,applied.objects);
 await f.app.shutdown();
 const restarted=await createWorldServer({dataPath:f.dataPath,users,port:0});await restarted.start();
 try {
  const restored=await (await fetch('http://127.0.0.1:'+restarted.address().port+'/state',{headers:{Authorization:'Bearer '+token}})).json();
  assert.equal(restored.revision,1);assert.deepEqual(restored.objects,applied.objects);
 } finally {await restarted.shutdown();}
});

test('failed validation leaves revision unchanged',async t=>{
 const f=await fixture(t);const response=await f.send({...command,objectType:'not-implemented'});
 assert.equal(response.status,409);assert.equal((await response.json()).error,'new_mechanic_required');
 const state=await (await fetch(f.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json();assert.equal(state.revision,0);
});
test('corrupt state is never recreated',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'shapes-corrupt-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const dataPath=path.join(dir,'world.json');await writeFile(dataPath,'corrupt');
 await assert.rejects(()=>createWorldServer({dataPath,users,port:0}));assert.equal(await readFile(dataPath,'utf8'),'corrupt');
});
test('invalid server role/token configuration rejected',async()=>{
 await assert.rejects(()=>createWorldServer({dataPath:'/tmp/not-written',users:{weak:{id:'a',role:'admin'}}}));
});
test('two authenticated clients see same world and ownership is enforced',async t=>{
 const f=await fixture(t);
 const built=await (await f.send(command)).json();
 const visible=await (await fetch(f.url+'/state',{headers:{Authorization:'Bearer test-only-bob-token'}})).json();
 assert.equal(visible.objects[0].id,built.object.id);assert.equal(visible.me.id,'bob');
 assert.equal((await f.send({type:'remove',id:built.object.id},'test-only-bob-token')).status,403);
 assert.equal((await f.send({type:'remove',id:built.object.id})).status,200);
});
test('storage failure does not publish an in-memory change',async t=>{
 const f=await fixture(t);
 // Turn the intended parent directory into a file after initialization.
 const parent=path.dirname(f.dataPath);await rm(parent,{recursive:true});await writeFile(parent,'not a directory');
 const response=await f.send(command);assert.equal(response.status,500);
 const state=await (await fetch(f.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json();assert.equal(state.revision,0);assert.equal(state.objects.length,0);
});
test('HTTP update persists edits visible to other clients, denial leaves state unchanged',async t=>{
 const f=await fixture(t);const built=await (await f.send(command)).json();const edit={type:'update',id:built.object.id,position:{x:10,y:2,z:9},size:{x:4,y:2,z:7},color:'#aabbcc',blocksMovement:false,supportsPlayer:false,expected:{position:built.object.position,size:built.object.size,color:built.object.color,blocksMovement:true,supportsPlayer:true}};
 assert.equal((await f.send(edit,'test-only-bob-token')).status,403);
 assert.equal((await f.send({...edit,color:'invalid'})).status,400);
 const changed=await (await f.send(edit)).json();assert.equal(changed.revision,2);
 const visible=await (await fetch(f.url+'/state',{headers:{Authorization:'Bearer test-only-bob-token'}})).json();assert.deepEqual(visible.objects[0],changed.object);
 const saved=JSON.parse(await readFile(f.dataPath,'utf8'));assert.deepEqual(saved.objects[0],changed.object);assert.equal(saved.revision,2);
});
test('two clients racing edits cannot overwrite stale fields',async t=>{
 const f=await fixture(t);const built=await (await f.send(command)).json();
 const id=built.object.id, expected={color:built.object.color};
 const responses=await Promise.all(['#123456','#abcdef'].map(color=>f.send({type:'update',id,color,expected})));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 const saved=JSON.parse(await readFile(f.dataPath,'utf8'));assert.equal(saved.revision,2);
 const conflict=responses.find(r=>r.status===409);assert.equal((await conflict.json()).error,'conflict');
});


test('HTTP movement enforces collision and server-owned height for every caller',async t=>{
 const f=await fixture(t);
 const built=await (await f.send({type:'build',objectType:'block',position:{x:3,y:1,z:0},size:{x:2,y:2,z:2}})).json();
 const spawn=await (await f.send({type:'move',position:{x:0,y:999,z:0}})).json();
 assert.deepEqual(spawn.position,{x:0,y:0,z:0});
 const hit=await (await f.send({type:'move',position:{x:10,y:999,z:0}})).json();
 assert.ok(hit.position.x<1.7,JSON.stringify(hit.position));
 assert.equal(hit.position.y,0);
 assert.equal(hit.velocityY,0);
 const saved=JSON.parse(await readFile(f.dataPath,'utf8'));
 assert.deepEqual(saved.players.find(player=>player.id==='alice').position,hit.position);
 const invalid=await f.send({type:'move',position:{x:0,y:0,z:0},jump:'true'});
 assert.equal(invalid.status,400);
 assert.equal((await invalid.json()).error,'invalid_command');
 assert.equal(JSON.parse(await readFile(f.dataPath,'utf8')).revision,hit.revision);
});


test('legacy out-of-bounds player and objects survive server restart without teleporting the player',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'shapes-legacy-edge-'));
 const dataPath=path.join(dir,'world.json');
 const legacy={version:1,revision:7,
  objects:[{id:'legacy-remote',type:'block',position:{x:500,y:1,z:-400},size:{x:2,y:2,z:2},color:'#c8a570',ownerId:'alice'}],
  players:[{id:'alice',position:{x:31,y:0,z:0},velocityY:0}]};
 await writeFile(dataPath,JSON.stringify(legacy));
 let app=await createWorldServer({dataPath,users,port:0}); await app.start();
 t.after(async()=>{if(app.listening)await app.shutdown();await rm(dir,{recursive:true,force:true});});
 let url=`http://127.0.0.1:${app.address().port}`;
 const state=async()=>{const r=await fetch(url+'/state',{headers:{Authorization:`Bearer ${token}`}});assert.equal(r.status,200);return r.json();};
 const sendMove=async x=>{const r=await fetch(url+'/command',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({type:'move',position:{x,y:0,z:0}})});assert.equal(r.status,200);return r.json();};
 let saved=await state();
 assert.deepEqual(saved.objects[0].position,{x:500,y:1,z:-400});
 assert.deepEqual(saved.players[0].position,{x:31,y:0,z:0});
 assert.deepEqual((await sendMove(32)).position,{x:31,y:0,z:0});
 await new Promise(resolve=>setTimeout(resolve,260));
 const recovered=await sendMove(29.5);
 assert.ok(recovered.position.x<31,JSON.stringify(recovered.position));
 assert.ok(recovered.position.x>=29.75-1e-6,JSON.stringify(recovered.position));
 await app.shutdown();
 app=await createWorldServer({dataPath,users,port:0}); await app.start(); url=`http://127.0.0.1:${app.address().port}`;
 saved=await state();
 assert.deepEqual(saved.objects[0].position,{x:500,y:1,z:-400});
 assert.deepEqual(saved.players.find(player=>player.id==='alice').position,recovered.position);
});

test('reports persistence phase timings only after the atomic world write when observed',async t=>{
 const samples=[];const f=await fixture(t,{onPersistenceSample:sample=>samples.push(sample)});
 const response=await f.send(command);assert.equal(response.status,200);
 assert.equal(samples.length,1);
 const sample=samples[0];
 assert.equal(sample.commandType,'build');assert.equal(sample.objects,1);assert.equal(sample.players,0);
 assert.equal(sample.bytes,Buffer.byteLength(await readFile(f.dataPath,'utf8')));
 for(const phase of ['serializeMs','writeMs','renameMs'])assert.ok(Number.isFinite(sample[phase])&&sample[phase]>=0,phase);
});


test('stair and ramp directions are shared by clients and survive a server restart',async t=>{
 const f=await fixture(t);
 const shapes=[
  {type:'build',objectType:'stairs',direction:'east',position:{x:10,y:1,z:0},size:{x:8,y:2,z:4}},
  {type:'build',objectType:'ramp',direction:'north',position:{x:0,y:1,z:10},size:{x:4,y:2,z:8}},
 ];
 const created=[];
 for(const shape of shapes){
  const response=await f.send(shape);assert.equal(response.status,200);
  created.push((await response.json()).object);
 }
 const read=async url=>fetch(url+'/state',{headers:{Authorization:'Bearer test-only-bob-token'}}).then(response=>response.json());
 const visible=await read(f.url);
 assert.deepEqual(visible.objects,created);
 assert.deepEqual(JSON.parse(await readFile(f.dataPath,'utf8')).objects,created);
 await f.app.shutdown();
 const restarted=await createWorldServer({dataPath:f.dataPath,users,port:0});await restarted.start();
 try {
  const restored=await read(`http://127.0.0.1:${restarted.address().port}`);
  assert.deepEqual(restored.objects,created);
 } finally {await restarted.shutdown();}
});

test('HTTP group movement is atomic, persisted once, and visible to both clients',async t=>{
 const carolToken='test-only-carol-builder-token';
 const f=await fixture(t,{users:{...users,[carolToken]:{id:'carol',role:'builder'}}});
 const aliceA=await (await f.send({type:'build',objectType:'block',position:{x:0,y:1,z:0}})).json();
 const aliceB=await (await f.send({type:'build',objectType:'bridge',position:{x:4,y:.5,z:0}})).json();
 const bobObject=await (await f.send({type:'build',objectType:'block',position:{x:8,y:1,z:0}},carolToken)).json();
 const read=async auth=>fetch(f.url+'/state',{headers:{Authorization:'Bearer '+auth}}).then(response=>response.json());
 const before=await read(token);
 const changes=[aliceA.object,aliceB.object].map(object=>({
  id:object.id,
  position:{x:object.position.x+2,y:object.position.y,z:object.position.z-1},
  expectedPosition:object.position,
 }));
 const denied=await f.send({type:'move_group',changes:[...changes,{
  id:bobObject.object.id,position:{x:10,y:1,z:-1},expectedPosition:bobObject.object.position,
 }]});
 assert.equal(denied.status,403);
 const unchanged=await Promise.all([read(token),read('test-only-bob-token')]);
 for(const state of unchanged) {
  assert.equal(state.revision,before.revision);
  assert.deepEqual(state.objects.map(object=>object.position),before.objects.map(object=>object.position));
 }
 const accepted=await f.send({type:'move_group',changes});
 assert.equal(accepted.status,200);
 const result=await accepted.json();
 assert.equal(result.revision,before.revision+1);
 assert.equal(result.objects.length,2);
 const after=await Promise.all([read(token),read('test-only-bob-token')]);
 assert.deepEqual(after[0].objects,after[1].objects);
 assert.deepEqual(after[0].objects.filter(object=>[aliceA.object.id,aliceB.object.id].includes(object.id)).map(object=>object.position),[
  {x:2,y:1,z:-1},{x:6,y:.5,z:-1},
 ]);
 const saved=JSON.parse(await readFile(f.dataPath,'utf8'));
 assert.equal(saved.revision,before.revision+1);
 assert.deepEqual(saved.objects,after[0].objects);
});

test('button use checks both access policies, server position, idempotent target state, and never retargets',async t=>{
 const f=await fixture(t);
 const response=async body=>{const r=await f.send(body,'test-only-bob-token');return {r,value:await r.json()};};
 const door=(await (await f.send({type:'build',objectType:'door',position:{x:4,y:1.5,z:0},size:{x:1.5,y:3,z:.25}})).json()).object;
 const second=(await (await f.send({type:'build',objectType:'gate',position:{x:6,y:1,z:0},size:{x:2,y:2,z:.5}})).json()).object;
 const button=(await (await f.send({type:'build',objectType:'button',position:{x:1,y:.25,z:0},size:{x:.5,y:.5,z:.25}})).json()).object;
 const configure=await f.send({type:'update',id:button.id,targetId:door.id,targetState:'open',usePolicy:'all_players',
  expected:{targetId:null,targetState:'open',usePolicy:'owner_admin'}});
 assert.equal(configure.status,200);
 const savedButton=await configure.json();
 const use={type:'use',id:button.id,expectedVersion:savedButton.object.version,expectedTargetVersion:0};
 let denied=await response(use);
 assert.equal(denied.r.status,403);assert.equal(denied.value.error,'forbidden','a public button cannot open a private target');
 const publicDoorUpdate=await f.send({type:'update',id:door.id,usePolicy:'all_players',expected:{usePolicy:'owner_admin'}});
 const publicDoor=(await publicDoorUpdate.json()).object;
 const useAfterPolicy={...use,expectedTargetVersion:publicDoor.version};
 const first=await response(useAfterPolicy);
 assert.equal(first.r.status,200);assert.equal(first.value.object.state,'open');assert.equal(first.value.object.version,2);
 const duplicate=await response(useAfterPolicy);
 assert.equal(duplicate.r.status,200);assert.equal(duplicate.value.revision,first.value.revision);
 const remote=(await (await f.send({type:'build',objectType:'button',position:{x:8,y:.25,z:0},size:{x:.5,y:.5,z:.25}})).json()).object;
 const remoteConfig=await f.send({type:'update',id:remote.id,targetId:door.id,targetState:'closed',usePolicy:'all_players',
  expected:{targetId:null,targetState:'open',usePolicy:'owner_admin'}});
 const remoteObject=(await remoteConfig.json()).object;
 const far=await response({type:'use',id:remote.id,expectedVersion:remoteObject.version,expectedTargetVersion:first.value.object.version});
 assert.equal(far.r.status,403);assert.equal(far.value.error,'out_of_range');
 const spoof=await response({type:'use',id:remote.id,expectedVersion:remoteObject.version,expectedTargetVersion:first.value.object.version,position:{x:8,y:0,z:0}});
 assert.equal(spoof.r.status,400);assert.equal(spoof.value.error,'invalid_command');
 await f.send({type:'remove',id:door.id});
 const missing=await response(useAfterPolicy);
 assert.equal(missing.r.status,404);assert.equal(missing.value.error,'not_found');
 const state=await (await fetch(f.url+'/state',{headers:{Authorization:'Bearer test-only-bob-token'}})).json();
 assert.equal(state.objects.find(o=>o.id===second.id).state,'closed');
 assert.equal(state.objects.find(o=>o.id===button.id).targetId,door.id);
});

test('closing an open doorway is denied while an online player occupies the passage',async t=>{
 const f=await fixture(t);
 await f.send({type:'move',position:{x:0,y:0,z:0}});
 const door=(await (await f.send({type:'build',objectType:'door',position:{x:0,y:1.5,z:0},size:{x:1,y:3,z:.25}})).json()).object;
 const open=await f.send({type:'set_state',id:door.id,state:'open',expectedVersion:0});
 assert.equal(open.status,200);
 const closed=await f.send({type:'set_state',id:door.id,state:'closed',expectedVersion:1});
 assert.equal(closed.status,409);assert.equal((await closed.json()).error,'occupied');
 await new Promise(resolve=>setTimeout(resolve,260));
 const moved=await f.send({type:'move',position:{x:2,y:0,z:0}});
 assert.equal(moved.status,200);
 const safe=await f.send({type:'set_state',id:door.id,state:'closed',expectedVersion:1});
 assert.equal(safe.status,200);assert.equal((await safe.json()).object.state,'closed');
});
