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
