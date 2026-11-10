import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorldServer} from '../src/server.mjs';
import * as gameTools from '../src/game-tools.mjs';
const {executeGameTool}=gameTools;
test('app-server dynamic tool handler builds through real authoritative HTTP and enforces roles',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-tool-'));
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{'builder-secret-12345':{id:'one',role:'builder'},'viewer-secret-12345':{id:'two',role:'viewer'}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 try {
 const event={name:'world_command',arguments:{command:{type:'build',objectType:'bridge',position:{x:0,y:1,z:0}}}};
 const result=await executeGameTool(event,{url,token:'builder-secret-12345'});assert.equal(result.success,true);
 const denied=await executeGameTool(event,{url,token:'viewer-secret-12345'});assert.equal(denied.success,false);
 const state=await executeGameTool({name:'world_state',arguments:{}},{url,token:'viewer-secret-12345'});
 assert.equal(JSON.parse(state.contentItems[0].text).objects.length,1);
 assert.equal((await executeGameTool({name:'execute_code',arguments:{}},{url,token:'builder-secret-12345'})).success,false);
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('agent update requires expected values before any network request',async(t)=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Network must not be reached.');});
 for(const expected of [undefined,null,[],{},'old']) {
  const result=await executeGameTool({name:'world_command',arguments:{command:{type:'update',id:'one',color:'#ffffff',expected}}},{url:'http://127.0.0.1:1',token:'unused'});
  assert.equal(result.success,false);assert.match(result.contentItems[0].text,/Update requires expected/);
 }
 assert.equal(fetch.mock.callCount(),0);
});

test('flat agent tools preserve server validation and optimistic edit conflicts',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-tool-edit-'));
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{'builder-secret-12345':{id:'one',role:'builder'}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={url:`http://127.0.0.1:${server.address().port}`,token:'builder-secret-12345'};
 const command=c=>executeGameTool({name:'world_command',arguments:{command:c}},connection);
 try {
  const invalid=await command({type:'build',position:{x:0,y:0,z:0}});assert.equal(invalid.success,false);
  const built=await command({type:'build',objectType:'block',position:{x:0,y:0,z:0},color:'#112233'});
  const object=JSON.parse(built.contentItems[0].text).object;
  const edited=await command({type:'update',id:object.id,color:'#334455',expected:{color:'#112233'}});assert.equal(edited.success,true);
  const stale=await command({type:'update',id:object.id,color:'#ffffff',expected:{color:'#112233'}});assert.equal(stale.success,false);assert.match(stale.contentItems[0].text,/conflict/);
  const forbidden=await command({type:'update',id:object.id,color:'#ffffff',ownerId:'other',expected:{color:'#334455'}});assert.equal(forbidden.success,false);
  const state=await executeGameTool({name:'world_state'},connection);
  assert.equal(JSON.parse(state.contentItems[0].text).objects[0].color,'#334455');
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('world_build missing, null or extra design fields never fall back to server defaults',async(t)=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Network must not be reached.');});
 const design={objectType:'block',position:{x:0,y:0,z:0},size:{x:2,y:2,z:2},color:'#3366cc'};
 for(const key of Object.keys(design)) {
  for(const value of [undefined,null]) {
   const result=await executeGameTool({name:'world_build',arguments:{...design,[key]:value}},{url:'http://127.0.0.1:1',token:'unused'});
   assert.equal(result.success,false);assert.match(result.contentItems[0].text,/requires exactly/);
  }
  const missing={...design};delete missing[key];
  assert.equal((await executeGameTool({name:'world_build',arguments:missing},{url:'http://127.0.0.1:1',token:'unused'})).success,false);
 }
 assert.equal((await executeGameTool({name:'world_build',arguments:{...design,type:'move'}},{url:'http://127.0.0.1:1',token:'unused'})).success,false);
 assert.equal(fetch.mock.callCount(),0);
});

test('world_build keeps authoritative validation, roles and explicit nondefault color; legacy build survives',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-build-tool-'));
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{'builder-secret-12345':{id:'one',role:'builder'},'viewer-secret-12345':{id:'two',role:'viewer'}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const connection={url,token:'builder-secret-12345'};
 const design={objectType:'block',position:{x:3,y:1,z:4},size:{x:2,y:2,z:2},color:'#3366cc'};
 try {
  const result=await executeGameTool({name:'world_build',arguments:design},connection);assert.equal(result.success,true);
  const built=JSON.parse(result.contentItems[0].text).object;assert.equal(built.color,'#3366cc');assert.equal(built.ownerId,'one');
  const denied=await executeGameTool({name:'world_build',arguments:design},{url,token:'viewer-secret-12345'});assert.equal(denied.success,false);
  for(const invalid of [{...design,objectType:'unknown'},{...design,color:'invalid'},{...design,position:{x:1e9,y:0,z:0}},{...design,size:{x:0,y:2,z:2}}])assert.equal((await executeGameTool({name:'world_build',arguments:invalid},connection)).success,false);
  const legacy=await executeGameTool({name:'world_command',arguments:{command:{type:'build',objectType:'block',position:{x:0,y:0,z:0}}}},connection);assert.equal(legacy.success,true);assert.equal(JSON.parse(legacy.contentItems[0].text).object.color,'#c8a570');
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});


test('world_build sends stair and ramp direction through server validation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-oriented-build-'));
 const token='builder-secret-12345';
 const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[token]:{id:'alice',role:'builder'}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={url:`http://127.0.0.1:${server.address().port}`,token};
 try {
  const designs=[['stairs','east'],['ramp','north']].map(([objectType,direction],index)=>({objectType,direction,position:{x:index*10,y:1,z:0},size:{x:8,y:2,z:4},color:'#3366cc'}));
  for(const design of designs){
   const result=await executeGameTool({name:'world_build',arguments:design},connection);
   assert.equal(result.success,true,result.contentItems[0].text);
   assert.equal(JSON.parse(result.contentItems[0].text).object.direction,design.direction);
  }
  const missing={...designs[1]};delete missing.direction;
  assert.equal((await executeGameTool({name:'world_build',arguments:missing},connection)).success,false);
  const invalid={...designs[1],direction:'up'};
  assert.equal((await executeGameTool({name:'world_build',arguments:invalid},connection)).success,false);
  const state=JSON.parse((await executeGameTool({name:'world_state'},connection)).contentItems[0].text);
  assert.deepEqual(state.objects.map(({type,direction})=>({type,direction})),[{type:'stairs',direction:'east'},{type:'ramp',direction:'north'}]);
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
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
  try {
    await executeGameTool({name:'world_build',arguments:{objectType:'block',position:{x:0,y:1,z:0},size:{x:1,y:1,z:1},color:'#123456'}},connection);
    const before=JSON.parse((await executeGameTool({name:'world_state'},connection)).contentItems[0].text);
    assert.equal(before.worldConnectionId,'connection-1');
    assert.equal(before.objects.length,1);
    const later=await executeGameTool({name:'world_build',arguments:{objectType:'bridge',position:{x:3,y:1,z:0},size:{x:1,y:1,z:1},color:'#654321'}},connection);
    assert.equal(later.success,true);
    const current=JSON.parse((await executeGameTool({name:'world_state'},connection)).contentItems[0].text);
    assert.equal(current.worldConnectionId,'connection-1');
    assert.ok(current.revision>before.revision);
    assert.equal(current.objects.length,2);
    assert.equal(JSON.stringify(current).includes(connection.token),false);
    const otherWorld=JSON.parse((await executeGameTool({name:'world_state'},{...connection,connectionId:'connection-2'})).contentItems[0].text);
    assert.equal(otherWorld.worldConnectionId,'connection-2');
  } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});;
