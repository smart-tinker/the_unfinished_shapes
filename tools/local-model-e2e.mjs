// Live CPU acceptance test, separate from npm test; no cloud provider or credentials.
import assert from 'node:assert/strict';
import { assertBuildAcceptance } from './build-acceptance.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { CodexBridge } from '../src/codex.mjs';
import { createWorldServer } from '../src/server.mjs';
import { executeGameTool } from '../src/game-tools.mjs';
import { createCpuEvidence } from './cpu-evidence.mjs';
import { createModelDiagnostics } from './model-diagnostics.mjs';

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

const token=randomBytes(24).toString('hex'), observerToken=randomBytes(24).toString('hex');
const server=await createWorldServer({dataPath:path.join(dir,'world.json'),users:{[token]:{id:'cpu-test-builder',role:'builder'},[observerToken]:{id:'other-player',role:'builder'}},port:0});
let bridge,timer,modelProcess,codexProcess;
const cpuEvidence=createCpuEvidence();
const diagnostics=createModelDiagnostics();
let proxy,stage='initializing';
const events=[];const started=Date.now();let failure;
let assistantText='',turnStatus='not_started',goalAcceptance=null,goalUpdates=[],goalCleared=false;
try {
 modelProcess=spawn(llamaPath,['--model',modelPath,'--alias',model,'--host','127.0.0.1','--port','11445','--n-gpu-layers','0','--ctx-size','16384','--threads','4','--parallel','1','--jinja','--reasoning-budget','0','--temp','0','--seed','42','--log-verbosity','4','--log-colors','off'],{stdio:['ignore','pipe','pipe']});
 let modelExit;
 modelProcess.once('error',error=>{modelExit=error.message;});
 modelProcess.once('exit',code=>{modelExit=`exit ${code}`;});
 for(const stream of [modelProcess.stdout,modelProcess.stderr]) {
  const evidenceStream=cpuEvidence.stream();
  stream.setEncoding('utf8');
  let partial='';
  stream.on('data',chunk=>{
   evidenceStream.write(chunk);
   const lines=(partial+chunk).split('\n');partial=lines.pop().slice(-65536);
   for(const line of lines)diagnostics.logLine(line);
  });
  stream.on('end',()=>evidenceStream.end());
 }
 let ready=false;
 for(let i=0;i<120;i++) {
  if(modelExit)throw new Error(`CPU model server failed: ${modelExit}`);
  try{const r=await fetch(new URL('/health',base),{signal:AbortSignal.timeout(500),redirect:'error'});if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(ready,'CPU model server did not become ready in 60 seconds.');
 stage='model_ready';
 proxy=http.createServer((req,res)=>{
  if(!['/v1/responses','/v1/models'].includes(req.url)){res.writeHead(404);res.end();return;}
  const observation=req.url==='/v1/responses'?diagnostics.request():null;
  const upstream=http.request(new URL(req.url,base),{method:req.method,headers:{'Content-Type':'application/json'}},response=>{
   observation?.status(response.statusCode);res.writeHead(response.statusCode,{'Content-Type':response.headers['content-type']||'application/json'});
   response.setEncoding('utf8');response.on('data',chunk=>observation?.data(chunk));response.on('end',()=>observation?.end());response.pipe(res);
  });
  req.on('data',chunk=>observation?.input(chunk));req.pipe(upstream);
  upstream.on('error',()=>{observation?.error();if(!res.headersSent)res.writeHead(502);res.end();});
  res.on('close',()=>upstream.destroy());
 });
 await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
 const providerBase=`http://127.0.0.1:${proxy.address().port}/v1`;
 await writeFile(path.join(home,'config.toml'),`model = ${JSON.stringify(model)}\nmodel_provider = "local_cpu"\n[model_providers.local_cpu]\nname = "Local CPU test only"\nbase_url = ${JSON.stringify(providerBase)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
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
  else if(event.type==='notification' && event.method==='thread/goal/updated') goalUpdates.push({threadId:event.params?.threadId,status:event.params?.goal?.status});
  else if(event.type==='notification' && event.method==='thread/goal/cleared') goalCleared=true;
  else if(event.type==='notification' && event.method==='turn/started') {turnStatus=event.params?.turn?.status ?? 'inProgress';stage='turn_started';}
  else if(event.type==='notification' && event.method==='item/completed' && event.params?.item?.type==='agentMessage') {
   // Only synthetic test assistant output, never reasoning or arbitrary tool output.
   assistantText=String(event.params.item.text ?? '').replaceAll(token,'[redacted]').slice(0,4000);
  } else if(event.type==='notification' && event.method==='turn/completed') {
   turnStatus=event.params?.turn?.status ?? 'unknown';
   if(event.params?.turn?.status==='failed') rejectDone(new Error(`Model turn failed: ${JSON.stringify(event.params.turn.error)}`));else resolveDone();
  }
 });
 stage='connecting_codex';
 await bridge.start({codexPath,workspacePath:workspace,newGameThread:true});
 stage='native_goal_lifecycle';
 timer=setTimeout(()=>rejectDone(new Error('Local model E2E exceeded its time budget.')),timeoutMs);
 const initialControls=await bridge.readControlState();
 assert.equal(initialControls.goalSupported,true,'the pinned Codex app-server must expose native Goals');
 assert.equal(initialControls.goal,null,'a new game conversation must start without a Goal');
 const design={objectType:'block',position:{x:3,y:1,z:4},size:{x:2,y:2,z:2},color:'#3366cc'};
 const objective=`Build exactly one block matching this design: ${JSON.stringify(design)}. First call world_state once, then call world_build once with these exact arguments. After the server confirms the build, report briefly.`;
 const completionCriteria='Exactly one object matching the supplied design is persisted and visible to another player.';
 const createdGoal=await bridge.createGoal({objective,completionCriteria});
 assert.equal(createdGoal.threadId,initialControls.threadId);
 assert.equal(createdGoal.status,'active');
 assert.ok(createdGoal.objective.includes(`Completion criteria: ${completionCriteria}`));
 assert.equal((await bridge.readControlState()).goal.status,'active');
 await done;
 stage='turn_completed';
 assert.equal(turnStatus,'completed');
 assert.ok(goalUpdates.some(update=>update.threadId===initialControls.threadId&&update.status==='active'),'native Goal updates must be emitted for the active thread');
 await bridge.pauseGoal();
 assert.equal((await bridge.readControlState()).goal.status,'paused');
 await bridge.clearGoal();
 assert.equal((await bridge.readControlState()).goal,null);
 assert.ok(goalUpdates.some(update=>update.status==='paused'),'pausing the Goal must emit its native status update');
 assert.equal(goalCleared,true,'clearing the Goal must emit the native cleared notification');
 goalAcceptance={supported:true,lifecycle:['created_active','native_turn_completed','paused','cleared'],modelTurnStarted:true,goalUpdates,runtime:initialControls.runtime};
 let savedWorld;
 try {savedWorld=await readFile(path.join(dir,'world.json'),'utf8');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 assert.ok(savedWorld,'No world state was persisted: the model did not perform a successful game action.');
 const state=JSON.parse(savedWorld);
 const acceptance=assertBuildAcceptance({events,state,design,ownerId:'cpu-test-builder'});
 const worldInspectionIndex=events.findIndex(event=>event.name==='world_state'&&event.success);const buildIndex=events.findIndex(event=>event.name==='world_build'&&event.success);assert.ok(worldInspectionIndex>=0,'real agent must inspect the world');assert.ok(worldInspectionIndex<buildIndex,'real agent must inspect the world before changing it');
 const observerResponse=await fetch(connection.url+'/state',{headers:{Authorization:'Bearer '+observerToken},signal:AbortSignal.timeout(5000)});
 assert.equal(observerResponse.status,200);
 const observerState=await observerResponse.json();
 assert.equal(observerState.me.id,'other-player');
 assert.deepEqual(observerState.objects,state.objects,'independent player sees the real agent construction');
 assert.equal(cpuEvidence.result().cpuOnly,true,'Positive CPU allocation was not observed, or GPU allocation contradicts CPU-only execution.');
 const evidence={status:'passed',acceptance,nativeGoal:goalAcceptance,transport:'real Codex app-server → local llama.cpp Responses API → world dynamic tool → persisted server state',model,modelDigest,cpuOnly:cpuEvidence.result().cpuOnly,requestedGpuLayers:0,cpuEvidence:cpuEvidence.result(),elapsedMs:Date.now()-started,toolCalls:events,turnStatus,stage,diagnostics:diagnostics.result(),assistantText,worldRevision:state.revision,object:{type:state.objects[0].type,position:state.objects[0].position,ownerId:state.objects[0].ownerId}};
 console.log(JSON.stringify(evidence,null,2));
 if(process.env.TUS_TEST_REPORT) await writeFile(path.resolve(process.env.TUS_TEST_REPORT),JSON.stringify(evidence,null,2)+'\n');
} catch(error) {
 failure=error;
 const evidence={status:'failed',model,modelDigest,elapsedMs:Date.now()-started,error:error.message,toolCalls:events,turnStatus,stage,diagnostics:diagnostics.result(),assistantText,requestedGpuLayers:0,cpuEvidence:cpuEvidence.result()};
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
 for(const action of [()=>stopChild(codexProcess,()=>bridge?.stop()),()=>stopChild(modelProcess,()=>modelProcess.kill()),()=>server.shutdown(),async()=>{if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}},()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})]) {
  try{await action();}catch(error){cleanupErrors.push(error.message);}
 }
 if(cleanupErrors.length){console.error(JSON.stringify({cleanupWarnings:cleanupErrors}));if(!failure)failure=new Error('Acceptance completed but cleanup failed.');}
}
if(failure)process.exitCode=1;
