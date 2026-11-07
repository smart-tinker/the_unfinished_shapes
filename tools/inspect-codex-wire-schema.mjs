// Schema observation only: real Codex + intentionally rejecting HTTP stub, no model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexBridge, WORLD_TOOLS } from '../src/codex.mjs';

const executable=process.env.TUS_TEST_CODEX;
assert.ok(executable && path.isAbsolute(executable),'Set TUS_TEST_CODEX to official installed Codex.');
const directory=await mkdtemp(path.join(tmpdir(),'tus-wire-schema-'));
const home=path.join(directory,'home'),workspace=path.join(directory,'workspace');
await mkdir(home,{mode:0o700});await mkdir(workspace,{mode:0o700});
let resolveCapture,rejectCapture,child,bridge,timer;
const capture=new Promise((resolve,reject)=>{resolveCapture=resolve;rejectCapture=reject;});
capture.catch(()=>{});
const server=http.createServer(async(req,res)=>{
 if(req.url?.startsWith('/v1/models')) {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'schema-observer',object:'model',owned_by:'local-diagnostic'}]}));return;}
 if(req.method==='POST' && req.url==='/v1/responses') {
  try {
   let body='';for await(const chunk of req){body+=chunk;if(body.length>8*1024*1024)throw new Error('Diagnostic request too large.');}
   const parsed=JSON.parse(body);resolveCapture(parsed.tools);
  } catch(error){rejectCapture(error);}
 }
 res.writeHead(400,{'Content-Type':'application/json'});
 res.end(JSON.stringify({error:{type:'diagnostic_only',message:'Schema captured. This endpoint deliberately performs no inference.'}}));
});
function findTool(value,name) {
 if(Array.isArray(value))return value.flatMap(item=>findTool(item,name));
 if(!value || typeof value!=='object')return [];
 if(value.name===name && (value.parameters || value.inputSchema))return [value.parameters ?? value.inputSchema];
 return Object.values(value).flatMap(item=>findTool(item,name));
}
function variants(schema) {
 const command=schema?.properties?.command;
 if(command?.oneOf)return command.oneOf.map(branch=>({
  type:branch.properties?.type?.const ?? branch.properties?.type?.enum?.[0],
  required:branch.required ?? [],fields:Object.keys(branch.properties ?? {}).sort(),
 }));
 return (command?.properties?.type?.enum ?? []).map(type=>({type,required:command.required ?? [],fields:Object.keys(command.properties ?? {}).sort()}));
}

try {
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;
 await writeFile(path.join(home,'config.toml'),`model = "schema-observer"\nmodel_provider = "schema_observer"\n[model_providers.schema_observer]\nname = "Schema observation only, no inference"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
 bridge=new CodexBridge({timeoutMs:20000,spawnProcess:(exe,args,options)=>(child=spawn(exe,args,{...options,env:{PATH:process.env.PATH,HOME:directory,USERPROFILE:directory,TMPDIR:directory,TEMP:directory,TMP:directory,CODEX_HOME:home,NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1'}}))});
 bridge.on('event',event=>{if(event.type==='disconnected')rejectCapture(new Error(event.message));});
 timer=setTimeout(()=>rejectCapture(new Error('Schema capture timed out after 45 seconds.')),45000);
 await bridge.start({codexPath:executable,workspacePath:workspace,newGameThread:true});
 bridge.send('Schema observation only. Describe how world_command builds a block; do not execute commands.').catch(rejectCapture);
 const tools=await capture;
 const schemas=findTool(tools,'world_command');
 assert.equal(schemas.length,1,'Expected one emitted world_command parameter schema.');
 const original=WORLD_TOOLS.find(tool=>tool.name==='world_command').inputSchema;
 assert.ok(variants(original).length>0,'Original operation schema could not be summarized.');
 const evidence={kind:'schema-observation-only',realModel:false,boundary:'real Codex app-server → local rejecting HTTP stub',originalSchema:original,emittedSchema:schemas[0],originalVariants:variants(original),emittedVariants:variants(schemas[0])};
 console.log(JSON.stringify(evidence,null,2));
 if(process.env.TUS_TEST_REPORT)await writeFile(process.env.TUS_TEST_REPORT,JSON.stringify(evidence,null,2)+'\n');
 assert.deepEqual(evidence.emittedVariants,evidence.originalVariants,'Codex changed command variant types, fields or requirements before the provider boundary.');
} finally {
 clearTimeout(timer);
 let close;
 if(child && child.exitCode===null && child.signalCode===null)close=new Promise(resolve=>child.once('close',resolve));
 bridge?.stop();
 if(close){let deadline;await Promise.race([close,new Promise(resolve=>{deadline=setTimeout(resolve,3000);})]);clearTimeout(deadline);if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
