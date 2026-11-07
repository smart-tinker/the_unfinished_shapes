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
let bridge,timer,modelProcess,codexProcess;
const cpuInitialization=[];
let modelLog='';
const events=[];const started=Date.now();let failure;
let assistantText='',turnStatus='not_started';
try {
 modelProcess=spawn(llamaPath,['--model',modelPath,'--alias',model,'--host','127.0.0.1','--port','11445','--n-gpu-layers','0','--ctx-size','16384','--threads','4','--parallel','1','--jinja','--reasoning-budget','0','--temp','0','--seed','42'],{stdio:['ignore','pipe','pipe']});
 let modelExit;
 modelProcess.once('error',error=>{modelExit=error.message;});
 modelProcess.once('exit',code=>{modelExit=`exit ${code}`;});
 for(const stream of [modelProcess.stdout,modelProcess.stderr]) {
  let partial='';
  stream.on('data',chunk=>{
   const text=chunk.toString();modelLog=(modelLog+text).slice(-40000);
   const lines=(partial+text).split('\n');partial=lines.pop().slice(-40000);
   for(const line of lines) if(/CPU.*(?:buffer|model)|model.*CPU|offloaded.*layers|build:/i.test(line) && cpuInitialization.length<30) cpuInitialization.push(line);
  });
 }
 let ready=false;
 for(let i=0;i<120;i++) {
  if(modelExit)throw new Error(`CPU model server failed: ${modelExit}; ${modelLog.slice(-1500)}`);
  try{const r=await fetch(new URL('/health',base),{signal:AbortSignal.timeout(500),redirect:'error'});if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(ready,'CPU model server did not become ready in 60 seconds.');
 const address=await server.start();
 const connection={url:`http://127.0.0.1:${address.port}`,token};
 bridge=new CodexBridge({timeoutMs:30000,spawnProcess:(exe,args,options)=>(codexProcess=spawn(exe,args,{...options,env:{PATH:process.env.PATH,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,CODEX_HOME:home,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}}))});
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
  else if(event.type==='notification' && event.method==='item/completed' && event.params?.item?.type==='agentMessage') {
   // Only synthetic test assistant output, never reasoning or arbitrary tool output.
   assistantText=String(event.params.item.text ?? '').replaceAll(token,'[redacted]').slice(0,4000);
  } else if(event.type==='notification' && event.method==='turn/completed') {
   turnStatus=event.params?.turn?.status ?? 'unknown';
   if(event.params?.turn?.status==='failed') rejectDone(new Error(`Model turn failed: ${JSON.stringify(event.params.turn.error)}`));else resolveDone();
  }
 });
 await bridge.start({codexPath,workspacePath:workspace,newGameThread:true});
 timer=setTimeout(()=>rejectDone(new Error('Local model E2E exceeded its time budget.')),timeoutMs);
 const design={command:{type:'build',objectType:'block',position:{x:3,y:1,z:4},size:{x:2,y:2,z:2},color:'#c8a570'}};
 await bridge.send(`Build this supplied design in the game. Call world_command exactly once with these exact JSON arguments: ${JSON.stringify(design)}. The command type must be build, not move. Do not call shell tools, write code, or change the design. After world_command succeeds, say done. /no_think`);
 await done;
 let savedWorld;
 try {savedWorld=await readFile(path.join(dir,'world.json'),'utf8');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 assert.ok(savedWorld,'No world state was persisted: the model did not perform a successful game action.');
 const state=JSON.parse(savedWorld);
 assert.equal(state.objects.length,1,'Expected exactly one persisted object, not a prose claim.');
 assert.equal(state.objects[0].type,'block');assert.equal(state.objects[0].ownerId,'cpu-test-builder');
 assert.deepEqual(state.objects[0].position,{x:3,y:1,z:4});
 assert.deepEqual(state.objects[0].size,{x:2,y:2,z:2});assert.equal(state.objects[0].color,'#c8a570');
 const commands=events.filter(e=>e.name==='world_command');
 assert.equal(commands.length,1,'Expected exactly one model-issued game command.');
 assert.equal(commands[0].success,true,'Real-model game command did not succeed.');
 assert.deepEqual(commands[0].arguments,design,'Model changed the supplied build design.');
 assert.match(cpuInitialization.join('\n'),/CPU.*(buffer|model)|model.*CPU/i,'CPU model allocation not recorded.');
 const evidence={status:'passed',transport:'real Codex app-server → local llama.cpp Responses API → world dynamic tool → persisted server state',model,modelDigest,cpuOnly:true,cpuEvidence:cpuInitialization,elapsedMs:Date.now()-started,toolCalls:events,turnStatus,assistantText,worldRevision:state.revision,object:{type:state.objects[0].type,position:state.objects[0].position,ownerId:state.objects[0].ownerId}};
 console.log(JSON.stringify(evidence,null,2));
 if(process.env.TUS_TEST_REPORT) await writeFile(path.resolve(process.env.TUS_TEST_REPORT),JSON.stringify(evidence,null,2)+'\n');
} catch(error) {
 failure=error;
 const evidence={status:'failed',model,modelDigest,elapsedMs:Date.now()-started,error:error.message,toolCalls:events,turnStatus,assistantText,cpuInitialization:cpuInitialization};
 console.error(JSON.stringify(evidence));
 if(process.env.TUS_TEST_REPORT) await writeFile(path.resolve(process.env.TUS_TEST_REPORT),JSON.stringify(evidence,null,2)+'\n');
}
finally {
 clearTimeout(timer);
 // Wait for child exit before deleting its home; cleanup must not mask test failure.
 const cleanupErrors=[];
 async function stopChild(child,stop) {
  if(!child || child.exitCode!==null || child.signalCode!==null)return;
  let closed=false;const ended=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
  stop();
  async function wait(ms){let timer;await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]);clearTimeout(timer);}
  await wait(5000);
  if(!closed){child.kill('SIGKILL');await wait(1000);}
  if(!closed)throw new Error('Child did not close within the cleanup budget.');
 }
 for(const action of [()=>stopChild(codexProcess,()=>bridge?.stop()),()=>stopChild(modelProcess,()=>modelProcess.kill()),()=>server.shutdown(),()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})]) {
  try{await action();}catch(error){cleanupErrors.push(error.message);}
 }
 if(cleanupErrors.length){console.error(JSON.stringify({cleanupWarnings:cleanupErrors}));if(!failure)failure=new Error('Acceptance completed but cleanup failed.');}
}
if(failure)process.exitCode=1;
