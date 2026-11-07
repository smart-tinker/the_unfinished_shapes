// Live CPU acceptance test, separate from npm test; no cloud provider or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { CodexBridge } from '../src/codex.mjs';
import { createWorldServer } from '../src/server.mjs';
import { executeGameTool } from '../src/game-tools.mjs';

const codexPath=process.env.TUS_TEST_CODEX;
const model='qwen3-local-cpu';
const llamaPath=process.env.TUS_TEST_LLAMA;
const modelPath=process.env.TUS_TEST_GGUF;
const base=new URL('http://127.0.0.1:11445');
assert.ok(codexPath && path.isAbsolute(codexPath),'Set TUS_TEST_CODEX to the installed executable absolute path.');
assert.ok(llamaPath && path.isAbsolute(llamaPath),'Set TUS_TEST_LLAMA to the official llama-server executable absolute path.');
assert.ok(modelPath && path.isAbsolute(modelPath),'Set TUS_TEST_GGUF to the local GGUF file absolute path.');
assert.ok(base.protocol==='http:' && ['127.0.0.1','[::1]'].includes(base.hostname) && !base.username && !base.password,'Only literal loopback model endpoints are allowed.');
const timeoutMs=Number(process.env.TUS_TEST_TIMEOUT_MS || 300000);
assert.ok(timeoutMs>=1000 && timeoutMs<=600000,'Timeout must be 1–600 seconds.');
const hash=createHash('sha256');
for await(const chunk of createReadStream(modelPath))hash.update(chunk);
const modelDigest=hash.digest('hex');
const dir=await mkdtemp(path.join(tmpdir(),'tus-local-e2e-'));
const workspace=path.join(dir,'workspace'),home=path.join(dir,'codex-home');
await mkdir(workspace,{mode:0o700});await mkdir(home,{mode:0o700});
await writeFile(path.join(home,'config.toml'),`model = ${JSON.stringify(model)}\nmodel_provider = "local_cpu"\n[model_providers.local_cpu]\nname = "Local CPU test only"\nbase_url = ${JSON.stringify(new URL('/v1',base).href)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const token=randomBytes(24).toString('hex');
const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[token]:{id:'cpu-test-builder',role:'builder'}},port:0});
let bridge,timer,modelProcess;
let modelLog='';
const events=[];const started=Date.now();let failure;
try {
 modelProcess=spawn(llamaPath,['--model',modelPath,'--alias',model,'--host','127.0.0.1','--port','11445','--n-gpu-layers','0','--ctx-size','16384','--threads','2','--parallel','1','--jinja','--reasoning-budget','0'],{stdio:['ignore','pipe','pipe']});
 let modelExit;
 modelProcess.once('error',error=>{modelExit=error.message;});
 modelProcess.once('exit',code=>{modelExit=`exit ${code}`;});
 for(const stream of [modelProcess.stdout,modelProcess.stderr])stream.on('data',chunk=>{modelLog=(modelLog+chunk.toString()).slice(-40000);});
 let ready=false;
 for(let i=0;i<120;i++) {
  if(modelExit)throw new Error(`CPU model server failed: ${modelExit}; ${modelLog.slice(-1500)}`);
  try{const r=await fetch(new URL('/health',base),{signal:AbortSignal.timeout(500),redirect:'error'});if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(ready,'CPU model server did not become ready in 60 seconds.');
 const address=await server.start();
 const connection={url:`http://127.0.0.1:${address.port}`,token};
 bridge=new CodexBridge({timeoutMs:30000,spawnProcess:(exe,args,options)=>spawn(exe,args,{...options,env:{PATH:process.env.PATH,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,CODEX_HOME:home,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}})});
 let resolveDone,rejectDone;
 const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
 // A handler is attached before any operation can reject the completion promise.
 done.catch(()=>{});
 bridge.on('event',event=>{
  if(event.type==='tool') {
   const record={name:event.name,arguments:event.arguments}; events.push(record);
   executeGameTool(event,connection).then(result=>{
    record.success=result.success;
    try {bridge.respond(event.id,result);}catch(error){rejectDone(error);}
   },rejectDone);
  } else if(event.type==='approval') {
   rejectDone(new Error(`Live model requested unexpected approval: ${event.method}`));
  } else if(event.type==='disconnected') rejectDone(new Error(event.message));
  else if(event.type==='notification' && event.method==='turn/completed') {
   if(event.params?.turn?.status==='failed') rejectDone(new Error(`Model turn failed: ${JSON.stringify(event.params.turn.error)}`));else resolveDone();
  }
 });
 await bridge.start({codexPath,workspacePath:workspace,newGameThread:true});
 timer=setTimeout(()=>rejectDone(new Error('Local model E2E exceeded its time budget.')),timeoutMs);
 await bridge.send('Use the world_command tool exactly once to build a block at position x=3, y=1, z=4, size x=2, y=2, z=2, color #c8a570. Do not use shell commands or write code. After the tool succeeds, say done. /no_think');
 await done;
 const state=JSON.parse(await readFile(path.join(dir,'world.json'),'utf8'));
 assert.equal(state.objects.length,1,'Expected exactly one persisted object, not a prose claim.');
 assert.equal(state.objects[0].type,'block');assert.equal(state.objects[0].ownerId,'cpu-test-builder');
 assert.deepEqual(state.objects[0].position,{x:3,y:1,z:4});
 assert.ok(events.some(e=>e.name==='world_command' && e.success),'No successful real-model world tool call.');
 assert.match(modelLog,/CPU.*(buffer|model)|model.*CPU/i,'CPU model allocation not recorded.');
 const evidence={status:'passed',transport:'real Codex app-server → local llama.cpp Responses API → world dynamic tool → persisted server state',model,modelDigest,cpuOnly:true,cpuEvidence:modelLog.split('\n').filter(line=>/CPU.*buffer|offloaded.*layers|build:/i.test(line)).slice(0,12),elapsedMs:Date.now()-started,toolCalls:events,worldRevision:state.revision,object:{type:state.objects[0].type,position:state.objects[0].position,ownerId:state.objects[0].ownerId}};
 console.log(JSON.stringify(evidence,null,2));
 if(process.env.TUS_TEST_REPORT) await writeFile(path.resolve(process.env.TUS_TEST_REPORT),JSON.stringify(evidence,null,2)+'\n');
} catch(error) {
 failure=error;
 const evidence={status:'failed',model,modelDigest,elapsedMs:Date.now()-started,error:error.message,toolCalls:events,cpuInitialization:modelLog.split('\n').filter(line=>/CPU.*buffer|offloaded.*layers|build:/i.test(line)).slice(0,12)};
 console.error(JSON.stringify(evidence));
 if(process.env.TUS_TEST_REPORT) await writeFile(path.resolve(process.env.TUS_TEST_REPORT),JSON.stringify(evidence,null,2)+'\n');
}
finally {clearTimeout(timer);bridge?.stop();modelProcess?.kill();await server.shutdown().catch(()=>{});await rm(dir,{recursive:true,force:true});}
if(failure)process.exitCode=1;
