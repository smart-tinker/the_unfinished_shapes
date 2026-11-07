import {pathToFileURL} from 'node:url';
// Diagnostic-only: real RC1 data, exact RC3 package, fresh test-owned profiles.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,copyFile,cp,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {hasAbnormalGraphicsExit} from './windows-graphics-outcome.mjs';
import path from 'node:path';import os from 'node:os';
const run=promisify(execFile),root=path.resolve(process.env.TUS_DIAGNOSTIC_SOURCE||'');
assert.equal(process.platform,'win32');assert.equal(process.env.CI,'true');
assert.equal((await run('git',['-C',root,'rev-parse','HEAD'])).stdout.trim(),'867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488');
assert.equal((await run('git',['-C',root,'rev-parse','HEAD^{tree}'])).stdout.trim(),'e78ce3b60655514fccd8426c0c7b32de710b72be');
assert.equal((await run('git',['-C',root,'diff','HEAD','--'])).stdout,'');
const require=createRequire(path.join(root,'package.json')),{_electron:electron}=require('playwright-core');
const {extractFile}=await import(pathToFileURL(require.resolve('@electron/asar')).href);
const binary=path.join(root,'dist/TheUnfinishedShapes-win32-x64/TheUnfinishedShapes.exe');
const archive=path.join(root,'dist/TheUnfinishedShapes-win32-x64/resources/app.asar');
for(const entry of await readdir(path.join(root,'src'),{recursive:true,withFileTypes:true}))if(entry.isFile()){
 const file=path.join(entry.parentPath,entry.name);assert.deepEqual(extractFile(archive,path.relative(root,file)),await readFile(file));
}
const work=await mkdtemp(path.join(os.tmpdir(),'tus-profile-diagnostic-')),fixture=path.join(work,'real-rc1');await mkdir(fixture);
let app;const outcomes=[];
async function open(executable,profile,extra=[]){
 app=await electron.launch({executablePath:executable,args:['--no-sandbox',...extra],env:{...process.env,TUS_DATA_DIR:profile,ELECTRON_ENABLE_LOGGING:'1'},timeout:45000});
 const actualDataDir=await app.evaluate(({app})=>app.getPath('userData'));
 assert.equal(path.resolve(actualDataDir).toLowerCase(),path.resolve(profile).toLowerCase(),'Only test-owned userData may be used');
 await app.evaluate(({app,BrowserWindow})=>{
  globalThis.tusDiagnosticCrashes=[];globalThis.tusDiagnosticAbnormal=false;
  const record=details=>{const event={time:Date.now(),type:details.type,reason:details.reason,exitCode:details.exitCode};if(/gpu|renderer/i.test(event.type||'')&&(event.reason!=='clean-exit'||event.exitCode!==0))globalThis.tusDiagnosticAbnormal=true;if(globalThis.tusDiagnosticCrashes.length<40)globalThis.tusDiagnosticCrashes.push(event);};
  app.on('child-process-gone',(_event,details)=>record(details));
  const attach=window=>window.webContents.on('render-process-gone',(_event,details)=>record({...details,type:'renderer'}));
  for(const window of BrowserWindow.getAllWindows())attach(window);app.on('browser-window-created',(_event,window)=>attach(window));
 });
 const page=await app.firstWindow();await page.waitForFunction(()=>typeof window.tus?.loadSettings==='function',null,{timeout:30000});return page;
}
async function close(){await app?.close();app=null;}
try{
 const response=await fetch('https://github.com/smart-tinker/the_unfinished_shapes/releases/download/v0.1.0-rc1/TheUnfinishedShapes-0.1-rc1-win32-x64.zip',{signal:AbortSignal.timeout(120000)});assert.ok(response.ok);
 const data=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(data).digest('hex'),'5ae62bdb9b61ae2a6c4317ec55c9a0aa66cb6621866c41293bdae7d3e633d110');
 const {writeFile}=await import('node:fs/promises');const zip=path.join(work,'rc1.zip');await writeFile(zip,data);
 const extracted=path.join(work,'rc1');await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${zip.replaceAll("'","''")}' -DestinationPath '${extracted.replaceAll("'","''")}'`],{timeout:120000});
 let page=await open(path.join(extracted,'TheUnfinishedShapes-win32-x64/TheUnfinishedShapes.exe'),fixture);
 const built=await page.evaluate(async()=>{await window.tus.saveSettings({workspacePath:'C:\\synthetic-workspace',codexPath:'C:\\synthetic-codex.exe',threadId:'synthetic-migration-thread',serverUrl:''});const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/command',method:'POST',body:{type:'build',objectType:'bridge',position:{x:7,y:1,z:0}}});});
 assert.ok(built.object?.id);await close();
 const saved=JSON.parse(await readFile(path.join(fixture,'settings.json'),'utf8')),world=JSON.parse(await readFile(path.join(fixture,'world.json'),'utf8'));assert.equal(saved.threadId,'synthetic-migration-thread');assert.equal('token' in saved,false);assert.deepEqual(world.objects,[built.object]);
 console.log(JSON.stringify({event:'provenance',sourceSHA:'867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488',packagedSourceVerified:true,fixture:'checksum-verified real RC1 public IPC',objects:world.objects.length,appAsarSHA256:createHash('sha256').update(await readFile(archive)).digest('hex')}));
 for(const backend of ['default','swiftshader'])for(const kind of ['clean','settings-only','full-legacy-profile','data-only-fresh-profile','clean-live-build']){
  const profile=path.join(work,`${backend}-${kind}`);await mkdir(profile);
  if(kind==='full-legacy-profile')await cp(fixture,profile,{recursive:true});
  else if(kind!=='clean'&&kind!=='clean-live-build'){await copyFile(path.join(fixture,'settings.json'),path.join(profile,'settings.json'));if(kind==='data-only-fresh-profile')await copyFile(path.join(fixture,'world.json'),path.join(profile,'world.json'));}
  const result={kind,backend,passed:false,graphicsMessages:[],rendererErrors:[],observationLimit:'Events before Playwright returns and hooks attach may be unavailable; no claim of full startup event coverage'};
  try{
   page=await open(binary,profile,backend==='swiftshader'?['--use-gl=angle','--use-angle=swiftshader']:[]);
   page.on('pageerror',error=>{if(result.rendererErrors.length<40)result.rendererErrors.push(error.message.slice(0,1000));});
   const capture=text=>{if(/WebGL|ANGLE|GPU|Context Lost|context lost|SharedImage|D3D/i.test(text)&&result.graphicsMessages.length<40)result.graphicsMessages.push(text.slice(0,1800));};
   page.on('console',message=>capture(message.text()));app.process().stderr?.on('data',chunk=>capture(chunk.toString()));
   await page.evaluate(()=>{window.tusDiagnosticContextLoss=[];document.querySelector('#viewport canvas')?.addEventListener('webglcontextlost',()=>{if(window.tusDiagnosticContextLoss.length<40)window.tusDiagnosticContextLoss.push({time:Date.now(),event:'webglcontextlost'});});});
   await page.waitForFunction(()=>document.querySelector('#connection')?.textContent.includes('World connected') || document.querySelector('#scene-error')?.hidden===false,null,{timeout:30000});
   // The canvas may have been created after the first hook; observe future loss too.
   await page.evaluate(()=>{const canvas=document.querySelector('#viewport canvas');if(canvas&&!canvas.dataset.tusLossHook){canvas.dataset.tusLossHook='true';canvas.addEventListener('webglcontextlost',()=>{if(window.tusDiagnosticContextLoss.length<40)window.tusDiagnosticContextLoss.push({time:Date.now(),event:'webglcontextlost'});});}});
   if(kind==='clean-live-build'){
    result.preBuild=await page.evaluate(()=>{const gl=document.querySelector('#viewport canvas')?.getContext('webgl2');const d=gl?.getExtension('WEBGL_debug_renderer_info');return {context:!!gl,lost:gl?.isContextLost(),renderer:gl?.getParameter(gl.RENDERER),backend:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):null};});
    assert.ok(result.preBuild.context&&!result.preBuild.lost&&result.preBuild.renderer,'Clean live-build must start with healthy graphics');
    const liveBuilt=await page.evaluate(async()=>{const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/command',method:'POST',body:{type:'build',objectType:'bridge',position:{x:7,y:1,z:0}}});});assert.equal(liveBuilt.object?.type,'bridge');
   }
   const state=await page.evaluate(async()=>{const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/state'});});result.objectCount=state.objects.length;
   assert.equal(state.objects.length,kind==='full-legacy-profile'||kind==='data-only-fresh-profile'||kind==='clean-live-build'?1:0);
   if(state.objects.length&&kind!=='clean-live-build')assert.deepEqual(state.objects,[built.object]);
   result.samples=[];
   for(let i=0;i<3;i++){
    await new Promise(resolve=>setTimeout(resolve,1000));
    result.samples.push(await page.evaluate(()=>{const e=document.querySelector('#scene-error'),gl=document.querySelector('#viewport canvas')?.getContext('webgl2');if(!gl)return {sceneError:e?.textContent,context:false};const debug=gl.getExtension('WEBGL_debug_renderer_info');return {sceneError:e?.hidden?'':e?.textContent,time:Date.now(),context:true,lost:gl.isContextLost(),renderer:gl.getParameter(gl.RENDERER),backend:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null};}));
   }
   result.contextLossEvents=await page.evaluate(()=>window.tusDiagnosticContextLoss);
   result.childProcessGone=await app.evaluate(()=>globalThis.tusDiagnosticCrashes);
   result.gpu=await app.evaluate(({app})=>({features:app.getGPUFeatureStatus(),electron:process.versions.electron,chrome:process.versions.chrome}));
   try{result.devices=await app.evaluate(async({app})=>(await app.getGPUInfo('basic')).gpuDevice);}catch(error){result.gpuInfoError=error.message.slice(0,1000);}
   assert.ok(result.samples.every(s=>s.context&&!s.lost&&s.renderer&&!s.sceneError),'Unhealthy/lost WebGL sample');assert.deepEqual(result.rendererErrors,[]);assert.deepEqual(result.contextLossEvents,[],'Context loss events are failures even if rendering later recovers');
   if(backend==='swiftshader')assert.ok(result.samples.every(s=>s.backend?.includes('SwiftShader')));
   assert.equal(hasAbnormalGraphicsExit(result.childProcessGone),false,'Abnormal GPU/renderer process exit');
   assert.equal(await app.evaluate(()=>globalThis.tusDiagnosticAbnormal),false,'Abnormal graphics exit observed');
   result.passed=true;
  }catch(error){result.error=error.message.slice(0,1500);}
  finally{if(app){try{result.childProcessGone=await app.evaluate(()=>globalThis.tusDiagnosticCrashes);if(hasAbnormalGraphicsExit(result.childProcessGone)||await app.evaluate(()=>globalThis.tusDiagnosticAbnormal)){result.passed=false;result.error||='Abnormal graphics process exit';}}catch{result.passed=false;result.crashEvidenceUnavailable=true;}}await close();outcomes.push(result);console.log(JSON.stringify(result));}
 }
 console.log(JSON.stringify({event:'summary',scope:'packaged binary profile/backend isolation, not installer acceptance',outcomes:outcomes.map(({kind,backend,passed})=>({kind,backend,passed}))}));
 assert.ok(outcomes.every(r=>r.passed),'Diagnostic failure retained; no fallback masks default failure');
}finally{await close();await rm(work,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
