import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorldServer} from '../src/server.mjs';
const token='test-only-alice-token';
const users={[token]:{id:'alice',role:'builder'},'test-only-bob-token':{id:'bob',role:'viewer'}};
const command={type:'build',objectType:'port',position:{x:1,y:0,z:1}};
async function fixture(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'shapes-test-')); const dataPath=path.join(dir,'world.json');
 const app=await createWorldServer({dataPath,users,port:0});await app.start();
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
