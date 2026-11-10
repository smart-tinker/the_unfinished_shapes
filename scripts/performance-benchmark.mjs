import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { createWorldServer } from '../src/server.mjs';
import { closeSmokeApp, observeGraphics, withSmokeCleanup } from './graphics-smoke.mjs';

const sourceSha = process.env.GITHUB_SHA || '';
const headSha = process.env.TUS_BENCHMARK_HEAD_SHA || sourceSha;
const executable = process.env.TUS_SMOKE_EXECUTABLE;
if (process.env.CI !== 'true' || process.env.RUNNER_OS !== 'Linux' || process.env.TUS_BENCHMARK !== '1' ||
    !/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{40}$/.test(headSha) || !executable ||
    !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run only from the bounded packaged Linux GitHub Actions step.');
await access(path.resolve(executable));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const electronVersion = JSON.parse(await readFile(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8')).version;
const scenarios = [{objects:25,clients:1},{objects:100,clients:1},{objects:300,clients:1},{objects:100,clients:2}];

function summary(values, name) {
  assert.ok(Array.isArray(values) && values.length > 0, name + ' produced no samples');
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0), name + ' contains invalid samples');
  const sorted = [...values].sort((a,b) => a-b);
  const at = p => sorted[Math.ceil(sorted.length*p)-1];
  const result = {count:sorted.length,min:sorted[0],p50:at(.5),p95:at(.95),max:sorted.at(-1)};
  assert.ok(result.p95 >= result.p50, name + ' has inconsistent percentiles');
  return result;
}
function seedWorld(objectCount, clientCount) {
  const players = [{id:'alice',position:{x:-22,y:0,z:-22},velocityY:0}];
  if (clientCount === 2) players.push({id:'bob',position:{x:22,y:0,z:22},velocityY:0});
  const columns = Math.ceil(Math.sqrt(objectCount));
  const objects = Array.from({length:objectCount},(_,i)=>({
    id:'object-'+i,type:'block',
    position:{x:-18+(i%columns)*2.1,y:1,z:-18+Math.floor(i/columns)*2.1},
    size:{x:.8,y:2,z:.8},color:i%2?'#aabbcc':'#c8a570',ownerId:'alice',
    blocksMovement:true,supportsPlayer:true,
  }));
  return {version:1,revision:0,objects,players};
}
function sleep(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
async function measureFrames(page,durationMs) {
  const values=await page.evaluate(duration=>new Promise(resolve=>{
    const samples=[];let previous=null,done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(safety);resolve(samples);};
    const safety=setTimeout(finish,duration+2500),started=performance.now();
    const frame=now=>{
      if(done)return;
      if(previous!==null)samples.push(now-previous);
      previous=now;
      if(now-started>=duration)finish();else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }),durationMs);
  assert.ok(values.length>0,'the packaged renderer produced no animation-frame samples');
  assert.ok(values.every(value=>Number.isFinite(value)&&value>0),'renderer frame samples must be finite and positive');
  return values;
}
async function waitForRevision(page,revision) {
  await page.waitForFunction(target=>{
    const text=document.querySelector('#revision')?.textContent||'';
    return Number(text.match(/\d+/)?.[0]||-1)>=target;
  },revision,{timeout:10000});
}
async function launch(ctx,id) {
  const token=ctx.tokens[id];
  const app=await electron.launch({
    executablePath:path.resolve(executable),
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--tus-smoke-confirm-quit'],
    env:{...process.env,TUS_DATA_DIR:path.join(ctx.dir,'client-'+id)},timeout:30000,
  });
  const client={id,app,page:null,graphics:null};
  ctx.clients.push(client);
  client.page=await app.firstWindow();
  client.graphics=await observeGraphics(client.page,{label:id});
  await client.page.waitForFunction(()=>document.querySelector('#build-version')?.getAttribute('title')!=='Loading build metadata',null,{timeout:10000});
  assert.equal(await client.page.locator('#build-version').innerText(),'v'+packageJson.version+' · '+sourceSha.slice(0,7));
  await client.page.locator('#settings-open').click();
  await client.page.locator('#server-url').fill(ctx.url);
  await client.page.locator('#token').fill(token);
  await client.page.locator('#save-world').click();
  await client.page.waitForFunction(()=>document.querySelector('#settings-message')?.textContent.toLowerCase().includes('saved'),null,{timeout:10000});
  await client.page.locator('#settings-close').click();
  await client.page.waitForFunction(()=>document.querySelector('#connection')?.textContent.includes('World connected'),null,{timeout:15000});
  assert.equal(await client.page.locator('#role').textContent(),'Role: builder');
  return client;
}
async function getState(ctx,id) {
  const started=performance.now();
  const response=await fetch(ctx.url+'/state',{headers:{Authorization:'Bearer '+ctx.tokens[id]},signal:AbortSignal.timeout(10000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  const elapsedMs=performance.now()-started;
  assert.equal(response.status,200,'state poll must succeed');
  const state=JSON.parse(bytes.toString('utf8'));
  assert.equal(state.objects.length,ctx.objectCount);
  return {client:id,elapsedMs,bytes:bytes.length};
}
async function postCommand(ctx,id,body) {
  const started=performance.now();
  const response=await fetch(ctx.url+'/command',{method:'POST',headers:{Authorization:'Bearer '+ctx.tokens[id],'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  const elapsedMs=performance.now()-started;
  assert.equal(response.status,200,'benchmark command must persist successfully');
  assert.ok(Number.isSafeInteger(result.revision),'command result must include a revision');
  return {elapsedMs,revision:result.revision};
}
async function runScenario(root,scenario) {
  const dir=await mkdtemp(path.join(root,'scenario-'));
  const users={},tokens={alice:randomBytes(24).toString('hex'),bob:randomBytes(24).toString('hex')};
  for(const id of ['alice','bob'])users[tokens[id]]={id,role:'builder'};
  const saves=[],clients=[];
  let world;
  const ctx={dir,users,tokens,clients,saves,objectCount:scenario.objects,url:''};
  return withSmokeCleanup(async()=>{
    await writeFile(path.join(dir,'world.json'),JSON.stringify(seedWorld(scenario.objects,scenario.clients)),{flag:'wx',mode:0o600});
    world=await createWorldServer({dataPath:path.join(dir,'world.json'),users,port:0,onPersistenceSample:sample=>saves.push(sample)});
    const address=await world.start();
    ctx.url='http://127.0.0.1:'+address.port;
    for(const id of scenario.clients===2?['alice','bob']:['alice'])await launch(ctx,id);
    const alice=clients.find(client=>client.id==='alice');
    await alice.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
    await alice.page.evaluate(()=>document.activeElement?.blur());
    await alice.page.waitForFunction(()=>document.hasFocus(),null,{timeout:5000});
    await sleep(2000);
    const gl=await alice.page.evaluate(()=>{
      const canvas=document.querySelector('#viewport canvas'),context=canvas?.getContext('webgl2');
      if(!context||context.isContextLost())return null;
      const extension=context.getExtension('WEBGL_debug_renderer_info');
      return {renderer:extension?context.getParameter(extension.UNMASKED_RENDERER_WEBGL):context.getParameter(context.RENDERER),vendor:extension?context.getParameter(extension.UNMASKED_VENDOR_WEBGL):context.getParameter(context.VENDOR),width:canvas.width,height:canvas.height,dpr:devicePixelRatio};
    });
    assert.ok(gl,'benchmark requires the packaged WebGL scene');
    const idleFrames=await measureFrames(alice.page,3000);
    const beforePoll=saves.length,polls=[];
    for(let i=0;i<20;i++)polls.push(...await Promise.all(clients.map(client=>getState(ctx,client.id))));
    assert.equal(saves.length,beforePoll,'GET /state must not persist changes');
    assert.ok(polls.every(sample=>sample.bytes>0),'state responses must not be empty');
    saves.length=0;
    const updateRtt=[],updateFrames=[];
    for(let i=0;i<8;i++){
      const framePromise=measureFrames(alice.page,1200);
      const command=await postCommand(ctx,'alice',{type:'update',id:'object-0',color:i%2?'#c8a570':'#aabbcc'});
      await Promise.all(clients.map(client=>waitForRevision(client.page,command.revision)));
      updateRtt.push(command.elapsedMs);updateFrames.push(...await framePromise);
    }
    const updateSaves=saves.splice(0);
    assert.equal(updateSaves.length,8,'each one-object update must be saved exactly once');
    assert.ok(updateSaves.every(sample=>sample.commandType==='update'&&sample.objects===scenario.objects&&sample.bytes>0));
    saves.length=0;
    const movementRtt=[],movementFramesPromise=measureFrames(alice.page,3000);
    let latestRevision=0;
    for(let i=1;i<=20;i++){
      const command=await postCommand(ctx,'alice',{type:'move',position:{x:-22+i*.2,y:0,z:-22}});
      movementRtt.push(command.elapsedMs);latestRevision=command.revision;
      if(i<20)await sleep(100);
    }
    await Promise.all(clients.map(client=>waitForRevision(client.page,latestRevision)));
    const movementFrames=await movementFramesPromise;
    const movementSaves=saves.splice(0);
    assert.equal(movementSaves.length,20,'each movement request must be saved exactly once');
    assert.ok(movementSaves.every(sample=>sample.commandType==='move'&&sample.objects===scenario.objects&&sample.players===scenario.clients&&sample.bytes>0));
    for(const client of clients)await client.graphics.assertHealthy();
    const saveStats=events=>({
      serializeMs:summary(events.map(event=>event.serializeMs),'persistence serialization'),
      writeMs:summary(events.map(event=>event.writeMs),'temporary-file write'),
      renameMs:summary(events.map(event=>event.renameMs),'atomic rename'),
      bytes:summary(events.map(event=>event.bytes),'persisted state bytes'),
    });
    const raw={
      objects:scenario.objects,clients:scenario.clients,gl,
      pollSamples:polls,updateRttMs:updateRtt,updateFrameIntervalsMs:updateFrames,
      updatePersistence:updateSaves,movementRttMs:movementRtt,movementFrameIntervalsMs:movementFrames,
      movementPersistence:movementSaves,idleFrameIntervalsMs:idleFrames,
    };
    const result={
      objects:scenario.objects,clients:scenario.clients,
      idleFrames:summary(idleFrames,'idle frame time'),
      pollRtt:summary(polls.map(sample=>sample.elapsedMs),'GET /state RTT'),
      pollBytes:summary(polls.map(sample=>sample.bytes),'GET /state bytes'),
      updateRtt:summary(updateRtt,'object update RTT'),
      updateFrames:summary(updateFrames,'frame time during object changes'),
      updatePersistence:saveStats(updateSaves),
      movementRtt:summary(movementRtt,'movement command RTT'),
      movementFrames:summary(movementFrames,'frame time during movement stream'),
      movementPersistence:saveStats(movementSaves),
      raw,
    };
    console.log('TUS_BENCHMARK_SCENARIO '+JSON.stringify(result));
    return result;
  },
  async()=>{const results=await Promise.allSettled(clients.map(client=>closeSmokeApp(client.app,client.graphics,'benchmark cleanup')));const failures=results.filter(value=>value.status==='rejected').map(value=>value.reason);if(failures.length)throw new AggregateError(failures,'Benchmark client cleanup failed');},
  async()=>{if(world?.listening)await world.shutdown();},
  ()=>rm(dir,{recursive:true,force:true}));
}
const root=await mkdtemp(path.join(os.tmpdir(),'tus-benchmark-'));
try{
  const results=[];
  for(const scenario of scenarios)results.push(await runScenario(root,scenario));
  const report={
    sourceSha,headSha,version:packageJson.version,
    environment:{runner:'ubuntu-24.04 ('+process.env.RUNNER_OS+' '+process.env.RUNNER_ARCH+')',os:os.release(),cpu:os.cpus()[0]?.model||'unknown',cpuCount:os.cpus().length,ramBytes:os.totalmem(),node:process.version,electron:electronVersion},
    renderer:'SwiftShader (explicit --use-gl=angle --use-angle=swiftshader)',warmupSeconds:2,
    sceneSizes:scenarios.map(scenario=>scenario.objects),durations:{idleSeconds:3,perObjectUpdateSeconds:1.2,movementStreamSeconds:3},
    scenarios:results,
  };
  console.log('TUS_BENCHMARK_RAW '+JSON.stringify(report));
  const lines=[
    '## Bounded shared-world performance',
    '',
    'Source SHA: '+sourceSha+' | PR head: '+headSha+' | version '+packageJson.version,
    '',
    'Runner: '+report.environment.runner+', '+report.environment.cpuCount+' vCPU, '+report.environment.ramBytes+' bytes RAM, '+report.environment.cpu+'; OS '+report.environment.os+'; Node '+report.environment.node+'; Electron '+report.environment.electron+'.',
    '',
    'Renderer: '+report.renderer+'; '+glDescription(results)+'. Warm-up: 2 s. Fixed synthetic scenes and command counts; no speed threshold is used for PASS.',
    '',
    '| Objects | Clients | State bytes p50 | GET RTT p50/p95 ms | Update RTT p50/p95 ms | Update save p95 serialize/write/rename ms | Update frame p95 ms | Move RTT p50/p95 ms | Move save p95 serialize/write/rename ms | Move frame p95 ms |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(result=>'| '+result.objects+' | '+result.clients+' | '+result.pollBytes.p50+' | '+result.pollRtt.p50+' / '+result.pollRtt.p95+' | '+result.updateRtt.p50+' / '+result.updateRtt.p95+' | '+result.updatePersistence.serializeMs.p95+' / '+result.updatePersistence.writeMs.p95+' / '+result.updatePersistence.renameMs.p95+' | '+result.updateFrames.p95+' | '+result.movementRtt.p50+' / '+result.movementRtt.p95+' | '+result.movementPersistence.serializeMs.p95+' / '+result.movementPersistence.writeMs.p95+' / '+result.movementPersistence.renameMs.p95+' | '+result.movementFrames.p95+' |'),
    '',
    'Raw sample arrays are in the Actions log in the TUS_BENCHMARK_RAW record. GET /state is a read-only loopback HTTP RTT plus body transfer; JSON parsing is validated but excluded from timing; command RTT includes the server and HTTP path, with serialization, file write and atomic rename timed separately. File writes measure OS API completion and do not imply fsync or physical-media latency. GUI frame intervals are from the actual packaged Electron canvas and use software SwiftShader; they do not represent real-GPU performance.',
    '',
  ];
  await appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n'));
}finally{await rm(root,{recursive:true,force:true});}
function glDescription(results){return results.map(result=>result.objects+' objects: '+result.raw.gl.renderer+' ('+result.raw.gl.width+'x'+result.raw.gl.height+', DPR '+result.raw.gl.dpr+')').join('; ');}
