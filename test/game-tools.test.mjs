import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorldServer} from '../src/server.mjs';
import * as gameTools from '../src/game-tools.mjs';
const {executeGameTool}=gameTools;
async function approvedBuild(session,objects,threadId='thread-1') {
 const preview=await session.execute({name:'world_preview',threadId,arguments:{objects}});
 const proposal=JSON.parse(preview.contentItems[0].text);session.decide(proposal.previewId,'apply',threadId);
 return session.execute({name:'world_apply',threadId,arguments:{previewId:proposal.previewId}});
}
test('agent builds only after an explicit in-game approval and server enforces roles',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-tool-'));
 const users={'builder-secret-12345':{id:'one',role:'builder'},'viewer-secret-12345':{id:'two',role:'viewer'}};
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={url:'http://127.0.0.1:'+server.address().port,token:'builder-secret-12345'};
 const design={objectType:'bridge',position:{x:0,y:1,z:0},size:{x:10,y:1,z:3},color:'#123456'};
 const session=gameTools.createGameToolSession(connection);
 try {
  const preview=await session.execute({name:'world_preview',threadId:'thread-1',arguments:{objects:[design]}});assert.equal(preview.success,true);
  const id=JSON.parse(preview.contentItems[0].text).previewId;
  assert.equal((await (await fetch(connection.url+'/state',{headers:{Authorization:'Bearer '+connection.token}})).json()).objects.length,0);
  session.decide(id,'apply','thread-1');
  const result=await session.execute({name:'world_apply',threadId:'thread-1',arguments:{previewId:id}});assert.equal(result.success,true);
  const deniedSession=gameTools.createGameToolSession({...connection,token:'viewer-secret-12345'});
  const deniedPreview=await deniedSession.execute({name:'world_preview',threadId:'thread-2',arguments:{objects:[design]}});
  deniedSession.decide(JSON.parse(deniedPreview.contentItems[0].text).previewId,'apply','thread-2');
  assert.equal((await deniedSession.execute({name:'world_apply',threadId:'thread-2',arguments:{previewId:JSON.parse(deniedPreview.contentItems[0].text).previewId}})).success,false);
  assert.equal((await executeGameTool({name:'world_command',arguments:{command:{type:'build',...design}}},connection)).success,false);
  assert.equal((await executeGameTool({name:'execute_code',arguments:{}},connection)).success,false);
  const state=await executeGameTool({name:'world_state',arguments:{}},{...connection,token:'viewer-secret-12345'});
  assert.equal(JSON.parse(state.contentItems[0].text).objects.length,1);
 } finally {session.clear();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('agent update requires expected values before any network request',async(t)=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Network must not be reached.');});
 for(const expected of [undefined,null,[],{},'old']) {
  const result=await executeGameTool({name:'world_command',arguments:{command:{type:'update',id:'one',color:'#ffffff',expected}}},{url:'http://127.0.0.1:1',token:'unused'});
  assert.equal(result.success,false);assert.match(result.contentItems[0].text,/Update requires expected/);
 }
 assert.equal(fetch.mock.callCount(),0);
});

test('agent edit tools preserve server validation and optimistic conflicts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tus-tool-edit-'));
  const token='builder-secret-12345';
  const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[token]:{id:'one',role:'builder'}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const connection={url:'http://127.0.0.1:'+server.address().port,token};
  const session=gameTools.createGameToolSession(connection);
  const command=c=>executeGameTool({name:'world_command',arguments:{command:c}},connection);
  try {
   const invalid=await command({type:'build',position:{x:0,y:0,z:0}});assert.equal(invalid.success,false);
   const built=await approvedBuild(session,[{objectType:'block',position:{x:0,y:0,z:0},size:{x:2,y:2,z:2},color:'#112233'}]);
   const object=JSON.parse(built.contentItems[0].text).objects[0];
   const edited=await command({type:'update',id:object.id,color:'#334455',expected:{color:'#112233'}});assert.equal(edited.success,true);
   const stale=await command({type:'update',id:object.id,color:'#ffffff',expected:{color:'#112233'}});assert.equal(stale.success,false);assert.match(stale.contentItems[0].text,/conflict/);
   const forbidden=await command({type:'update',id:object.id,color:'#ffffff',ownerId:'other',expected:{color:'#334455'}});assert.equal(forbidden.success,false);
   const state=await executeGameTool({name:'world_state'},connection);
   assert.equal(JSON.parse(state.contentItems[0].text).objects[0].color,'#334455');
  } finally {session.clear();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
 });

test('world_preview rejects malformed designs without contacting the server',async t=>{
 const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Network must not be reached.');});
 const session=gameTools.createGameToolSession({url:'http://127.0.0.1:1',token:'unused'});
 const design={objectType:'block',position:{x:0,y:0,z:0},size:{x:2,y:2,z:2},color:'#3366cc'};
 const invalid=[
  {...design,position:{x:1e9,y:0,z:0}},{...design,size:{x:0,y:2,z:2}},{...design,color:'invalid'},
  {...design,extra:'field'},{...design,objectType:'unknown'},{...design,position:{x:0,y:0}},
  {...design,objectType:'stairs',direction:'up'},
 ];
 for(const object of invalid){
  const result=await session.execute({name:'world_preview',threadId:'thread-1',arguments:{objects:[object]}});
  assert.equal(result.success,false);
 }
 assert.equal((await session.execute({name:'world_preview',threadId:'thread-1',arguments:{objects:[]}})).success,false);
 assert.equal((await session.execute({name:'world_preview',threadId:'thread-1',arguments:{objects:[design],extra:true}})).success,false);
 assert.equal((await executeGameTool({name:'world_build',arguments:design},{url:'http://127.0.0.1:1',token:'unused'})).success,false);
 assert.equal(fetchMock.mock.callCount(),0);session.clear();
});

test('approved stair and ramp preview applies as one group with saved directions',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-oriented-build-'));
 const token='builder-secret-12345';
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[token]:{id:'alice',role:'builder'}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={url:'http://127.0.0.1:'+server.address().port,token},session=gameTools.createGameToolSession(connection),threadId='thread-1';
 try {
  const designs=[['stairs','east'],['ramp','north']].map(([objectType,direction],index)=>({objectType,direction,position:{x:index*10,y:1,z:0},size:{x:8,y:2,z:4},color:'#3366cc'}));
  const preview=await session.execute({name:'world_preview',threadId,arguments:{objects:designs}});assert.equal(preview.success,true);
  const previewId=JSON.parse(preview.contentItems[0].text).previewId;
  assert.equal((await (await fetch(connection.url+'/state',{headers:{Authorization:'Bearer '+token}})).json()).objects.length,0);
  assert.equal((await session.execute({name:'world_apply',threadId,arguments:{previewId}})).success,false);
  assert.throws(()=>session.decide(previewId,'apply','other-thread'),/thread|conversation/i);
  session.decide(previewId,'apply',threadId);
  const result=await session.execute({name:'world_apply',threadId,arguments:{previewId}});assert.equal(result.success,true);
  assert.deepEqual(JSON.parse(result.contentItems[0].text).objects.map(({type,direction})=>({type,direction})),[{type:'stairs',direction:'east'},{type:'ramp',direction:'north'}]);
  const missing={...designs[1]};delete missing.direction;
  assert.equal((await session.execute({name:'world_preview',threadId,arguments:{objects:[missing]}})).success,false);
  const state=JSON.parse((await executeGameTool({name:'world_state'},connection)).contentItems[0].text);
  assert.deepEqual(state.objects.map(({type,direction})=>({type,direction})),[{type:'stairs',direction:'east'},{type:'ramp',direction:'north'}]);
 } finally {session.clear();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('scene snapshots preserve uphill directions for stair and ramp context',()=>{
 const shapes=[['stairs','east'],['ramp','north']].map(([type,direction],index)=>({...sceneObject(type,{x:index*2,y:1,z:0}),type,direction}));
 const state=sceneWorld(shapes);
 const snapshot=gameTools.captureSceneSnapshot(state,sceneView(), 'connection-1');
 assert.deepEqual(snapshot.objects.map(({type,direction})=>({type,direction})),shapes.map(({type,direction})=>({type,direction})));
});

const sceneCamera = {
  position:{x:0,y:2,z:10}, target:{x:0,y:2,z:0},
  fov:42, aspect:1.5, near:0.1, far:220,
  viewport:{width:900,height:600},
};
const sceneObject = (id, position) => ({
  id, type:'block', ownerId:'alice', color:'#123456',
  position, size:{x:1,y:1,z:1}, blocksMovement:true, supportsPlayer:true,
});
const sceneWorld = (objects, players = []) => ({
  version:1, revision:7, objects,
  players:[{id:'alice',position:{x:0,y:0,z:0},velocityY:0},...players],
  me:{id:'alice',role:'builder'}, mechanics:['block','bridge','port'],
});
const sceneView = (revision=7, selectedIds=[]) => ({revision,selectedIds,camera:structuredClone(sceneCamera)});

test('scene snapshots distinguish camera-frustum objects from selected objects', () => {
  assert.equal(typeof gameTools.captureSceneSnapshot, 'function', 'scene snapshot helper must be implemented');
  const state = sceneWorld([
    sceneObject('visible', {x:0,y:0,z:0}),
    sceneObject('selected-behind-camera', {x:0,y:2,z:12}),
  ]);
  const snapshot = gameTools.captureSceneSnapshot(state, sceneView(7,['selected-behind-camera']), 'connection-1');
  assert.equal(snapshot.worldConnectionId, 'connection-1');
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.selectedIds, ['selected-behind-camera']);
  assert.equal(snapshot.objects.find(o => o.id === 'visible').inCameraView, true);
  assert.equal(snapshot.objects.find(o => o.id === 'selected-behind-camera').inCameraView, false);
  assert.equal(snapshot.objects.find(o => o.id === 'selected-behind-camera').selected, true);
  assert.equal(snapshot.totalObjectCount, 2);
  assert.equal(snapshot.objectsTruncated, false);
  assert.equal(JSON.stringify(snapshot).includes('token'), false);
});

test('scene snapshots bound context and never silently drop selected IDs', () => {
  assert.equal(typeof gameTools.captureSceneSnapshot, 'function', 'scene snapshot helper must be implemented');
  const visible = Array.from({length:70}, (_,i) => sceneObject(`visible-${i}`, {x:(i%5)*0.2,y:2,z:0}));
  const selected = sceneObject('selected-outside-view', {x:100,y:2,z:0});
  const players = Array.from({length:40}, (_,i) => ({id:`player-${i}`,position:{x:i,y:0,z:0}}));
  const snapshot = gameTools.captureSceneSnapshot(sceneWorld([...visible,selected],players), sceneView(7,['selected-outside-view']), 'connection-1');
  assert.equal(snapshot.objects.length, 64);
  assert.equal(snapshot.objectsTruncated, true);
  assert.equal(snapshot.totalObjectCount, 71);
  assert.equal(snapshot.objects.some(o => o.id === 'selected-outside-view' && o.selected), true);
  assert.equal(snapshot.players.length <= 32, true);
  assert.equal(snapshot.playersTruncated, true);
});

test('scene capture rejects stale revisions, invalid cameras, and missing selections', () => {
  assert.equal(typeof gameTools.captureSceneSnapshot, 'function', 'scene snapshot helper must be implemented');
  const state = sceneWorld([sceneObject('existing',{x:0,y:0,z:0})]);
  assert.throws(() => gameTools.captureSceneSnapshot(state, sceneView(6,[]), 'connection-1'), /revision/i);
  assert.throws(() => gameTools.captureSceneSnapshot(state, sceneView(7,['missing']), 'connection-1'), /selected/i);
  const invalid = sceneView();
  invalid.camera.position.x = Infinity;
  assert.throws(() => gameTools.captureSceneSnapshot(state, invalid, 'connection-1'), /camera|finite/i);
});

test('world_state returns the latest authoritative state and scopes it to this connection', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'tus-tool-scene-'));
  const connection={url:'',token:'builder-secret-12345',connectionId:'connection-1'};
  const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[connection.token]:{id:'alice',role:'builder'}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));connection.url=`http://127.0.0.1:${server.address().port}`;
  const session=gameTools.createGameToolSession(connection);
  try {
    await approvedBuild(session,[{objectType:'block',position:{x:0,y:1,z:0},size:{x:1,y:1,z:1},color:'#123456'}]);
    const before=JSON.parse((await executeGameTool({name:'world_state'},connection)).contentItems[0].text);
    assert.equal(before.worldConnectionId,'connection-1');
    assert.equal(before.objects.length,1);
    const later=await approvedBuild(session,[{objectType:'bridge',position:{x:3,y:1,z:0},size:{x:1,y:1,z:1},color:'#654321'}]);
    assert.equal(later.success,true);
    const current=JSON.parse((await executeGameTool({name:'world_state'},connection)).contentItems[0].text);
    assert.equal(current.worldConnectionId,'connection-1');
    assert.ok(current.revision>before.revision);
    assert.equal(current.objects.length,2);
    assert.equal(JSON.stringify(current).includes(connection.token),false);
    const otherWorld=JSON.parse((await executeGameTool({name:'world_state'},{...connection,connectionId:'connection-2'})).contentItems[0].text);
    assert.equal(otherWorld.worldConnectionId,'connection-2');
  } finally {session.clear();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});


test('agent construction remains local until a trusted approval applies the exact set once',async t=>{
 assert.equal(typeof gameTools.createGameToolSession,'function','game tools must expose a per-connection preview approval gate');
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-agent-preview-'));
 const token='builder-secret-preview-12345';
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[token]:{id:'alice',role:'builder'}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={url:`http://127.0.0.1:${server.address().port}`,token,connectionId:'connection-1'};
 const session=gameTools.createGameToolSession(connection),threadId='thread-1';
 const objects=[
  {objectType:'block',position:{x:0,y:1,z:0},size:{x:2,y:2,z:2},color:'#123456'},
  {objectType:'bridge',position:{x:8,y:1,z:0},size:{x:10,y:1,z:3},color:'#654321'},
 ];
 try {
  const preview=await session.execute({name:'world_preview',threadId,arguments:{objects}});
  assert.equal(preview.success,true);
  const proposed=JSON.parse(preview.contentItems[0].text);
  assert.equal(typeof proposed.previewId,'string');assert.deepEqual(proposed.objects,objects);
  const state=await (await fetch(connection.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json();
  assert.equal(state.revision,0);assert.equal(state.objects.length,0);
  const early=await session.execute({name:'world_apply',threadId,arguments:{previewId:proposed.previewId}});
  assert.equal(early.success,false);assert.match(early.contentItems[0].text,/approval/i);
  assert.equal((await (await fetch(connection.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json()).objects.length,0);
  assert.throws(()=>session.decide(proposed.previewId,'apply','another-thread'),/thread|conversation/i);
  session.decide(proposed.previewId,'apply',threadId);
  const applied=await session.execute({name:'world_apply',threadId,arguments:{previewId:proposed.previewId}});
  assert.equal(applied.success,true);const result=JSON.parse(applied.contentItems[0].text);
  assert.equal(result.revision,1);assert.equal(result.objects.length,2);
  assert.deepEqual(result.objects.map(object=>object.ownerId),['alice','alice']);
  assert.equal((await session.execute({name:'world_apply',threadId,arguments:{previewId:proposed.previewId}})).success,false,'an approved preview is one-use');
  assert.equal((await executeGameTool({name:'world_build',arguments:objects[0]},connection)).success,false);
  assert.equal((await executeGameTool({name:'world_command',threadId,arguments:{command:{type:'build',...objects[0]}}},connection)).success,false);
  assert.equal((await executeGameTool({name:'world_command',threadId,arguments:{command:{type:'build_group',objects}}},connection)).success,false);
  const final=await (await fetch(connection.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json();
  assert.equal(final.revision,1);assert.equal(final.objects.length,2);
  const canceled=await session.execute({name:'world_preview',threadId,arguments:{objects:[objects[0]]}});
  const canceledId=JSON.parse(canceled.contentItems[0].text).previewId;
  session.decide(canceledId,'cancel',threadId);
  assert.equal((await session.execute({name:'world_apply',threadId,arguments:{previewId:canceledId}})).success,false);
  const unchanged=await (await fetch(connection.url+'/state',{headers:{Authorization:`Bearer ${token}`}})).json();
  assert.equal(unchanged.revision,1);assert.equal(unchanged.objects.length,2);
 } finally {session.clear();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
