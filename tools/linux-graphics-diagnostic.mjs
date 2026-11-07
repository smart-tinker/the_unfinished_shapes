// Diagnostic only. Never substitutes for the immutable release's own smoke gate.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.env.TUS_DIAGNOSTIC_SOURCE||'');
const sha='867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488';
assert.equal(process.platform,'linux');
assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha);
assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),'e78ce3b60655514fccd8426c0c7b32de710b72be');
assert.equal(execFileSync('git',['-C',root,'diff','HEAD','--','src','package.json','package-lock.json'],{encoding:'utf8'}),'');
const require=createRequire(path.join(root,'package.json'));
const { _electron:electron }=require('playwright-core');
const {extractFile}=await import(require.resolve('@electron/asar'));
const executable=path.join(root,'dist/TheUnfinishedShapes-linux-x64/TheUnfinishedShapes');
const archive=path.join(root,'dist/TheUnfinishedShapes-linux-x64/resources/app.asar');
for(const file of await readdir(path.join(root,'src'),{recursive:true,withFileTypes:true}))if(file.isFile()){
 const filename=path.join(file.parentPath,file.name),relative=path.relative(root,filename);
 assert.deepEqual(extractFile(archive,relative),await readFile(filename),relative);
}
const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const packaged=JSON.parse(extractFile(archive,'package.json'));
for(const key of Object.keys(packaged))assert.deepEqual(packaged[key],sourcePackage[key]);
console.log(JSON.stringify({event:'provenance',sha,version:sourcePackage.version,sourceMatchesPackaged:true,electron:JSON.parse(await readFile(path.join(root,'node_modules/electron/package.json'),'utf8')).version,three:JSON.parse(await readFile(path.join(root,'node_modules/three/package.json'),'utf8')).version}));
const results=[];
for(const kind of ['source','package'])for(const backend of ['default','swiftshader']){
 const profile=await mkdtemp(path.join(os.tmpdir(),'tus-graphics-diagnostic-'));
 // Exactly the existing Linux CI exception, no additional security relaxation.
 const flags=['--no-sandbox',...(backend==='swiftshader'?['--use-gl=angle','--use-angle=swiftshader']:[])];
 const result={kind,backend,flags,passed:false,console:[],pageErrors:[],stderr:''};let app;
 try{
  app=await electron.launch({...(kind==='package'?{executablePath:executable}:{}),cwd:root,args:[...(kind==='source'?[root]:[]),...flags],env:{...process.env,TUS_DATA_DIR:profile,ELECTRON_ENABLE_LOGGING:'1'},timeout:30000});
  app.process().stderr?.on('data',chunk=>{result.stderr=(result.stderr+chunk.toString()).slice(-16000);});
  const page=await app.firstWindow();
  page.on('console',message=>{if(result.console.length<50)result.console.push({type:message.type(),text:message.text().slice(0,2000)});});
  page.on('pageerror',error=>result.pageErrors.push(error.message.slice(0,2000)));
  await page.waitForFunction(()=>document.querySelector('#connection')?.textContent.includes('World connected'),{},{timeout:30000});
  result.sceneError=await page.locator('#scene-error').textContent();
  result.sceneErrorVisible=await page.locator('#scene-error').isVisible();
  result.runtime=await app.evaluate(async({app,BrowserWindow})=>({versions:process.versions,argv:process.argv,gpuFeatureStatus:app.getGPUFeatureStatus(),gpuInfo:await app.getGPUInfo('basic'),rendererSandbox:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox}));
  result.webgl=await page.evaluate(()=>{const canvas=document.querySelector('#viewport canvas');if(!canvas)return {canvas:false};const gl=canvas.getContext('webgl2');if(!gl)return {canvas:true,context:false};const debug=gl.getExtension('WEBGL_debug_renderer_info');return {canvas:true,context:true,vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null};});
  assert.equal(result.sceneErrorVisible,false,result.sceneError);
  assert.equal(result.webgl.context,true,'WebGL2 context required');
  assert.deepEqual(result.pageErrors,[]);
  result.passed=true;
 }catch(error){result.error=String(error.stack||error).slice(0,4000);}
 finally{await app?.close().catch(error=>{result.cleanupError=error.message;result.passed=false;});await rm(profile,{recursive:true,force:true});results.push(result);console.log(JSON.stringify(result));}
}
console.log(JSON.stringify({event:'summary',sha,results:results.map(({kind,backend,passed})=>({kind,backend,passed})),scope:'Graphics startup diagnostics only; not full release smoke or publication authorization'}));
assert.ok(results.every(r=>r.passed),'One or more graphics modes failed; all four outcomes retained above. No fallback converts a failure into a pass.');
