import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorldServer} from '../src/server.mjs';
import {executeGameTool} from '../src/game-tools.mjs';
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
