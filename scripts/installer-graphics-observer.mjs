// Observability only: never retries, changes flags, or converts a failed assertion to success.
export async function preserveGraphicsFailure(check, reportFailure) {
 try { return await check(); }
 catch (firstError) { try { await reportFailure(firstError); } catch { /* Preserve the original failure. */ } throw firstError; }
}
export function assertNoCapturedGraphicsFailure(evidence) {
 if(evidence?.hookError||evidence?.pageHookError)throw new Error('Graphics observation hooks failed');
 if(evidence?.mainError||evidence?.rendererError)throw new Error('Graphics event evidence unavailable after strict check');
 const main=evidence?.main,renderer=evidence?.renderer;
 if(main?.hooksInstalled!==true||renderer?.hooksInstalled!==true||!Array.isArray(main.processEvents)||typeof main.abnormalObserved!=='boolean'||!Array.isArray(renderer.contextEvents)||typeof renderer.contextLossObserved!=='boolean')throw new Error('Graphics observation hooks or evidence missing');
 const lost=evidence?.renderer?.contextEvents?.some(event=>event.type==='webglcontextlost');
 const abnormal=main?.processEvents?.some(event=>/gpu|renderer/i.test(event.type||'')&&(event.reason!=='clean-exit'||event.exitCode!==0));
 if(lost||abnormal||main?.abnormalObserved||evidence?.renderer?.contextLossObserved)throw new Error('Captured graphics failure remains a failure after restoration');
}
export async function checkThenObserve(check,observe) {
 await check();
 const sample=await observe();
 assertNoCapturedGraphicsFailure(sample);
 return sample;
}
const bounded=async task=>Promise.race([task(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Diagnostic observation timed out')),2000);timer.unref?.();})]);
export async function observeInstallerLaunch(app,stage) {
 const evidence={stage,attachedAt:Date.now(),startupCoverage:'Events before Electron launch resolves may be unavailable',stderr:[],console:[],pageErrors:[]};let page;
 const graphics=/gpu|webgl|angle|context|sharedimage|d3d|renderer/i;
 const record=(list,text)=>{if(list.length<30&&graphics.test(text))list.push({time:Date.now(),text:text.slice(0,1800)});};
 app.process().stderr?.on('data',chunk=>record(evidence.stderr,chunk.toString()));
 await bounded(()=>app.evaluate(({app,BrowserWindow})=>{
  globalThis.tusInstallerEvents=[];globalThis.tusInstallerAbnormal=false;
  const record=d=>{if(/gpu|renderer/i.test(d.type||'')&&(d.reason!=='clean-exit'||d.exitCode!==0))globalThis.tusInstallerAbnormal=true;if(globalThis.tusInstallerEvents.length<30)globalThis.tusInstallerEvents.push({time:Date.now(),type:d.type,reason:d.reason,exitCode:d.exitCode});};
  globalThis.tusInstallerHooksInstalled=false;
  app.on('child-process-gone',(_e,d)=>record(d));
  const attach=w=>w.webContents.on('render-process-gone',(_e,d)=>record({...d,type:'renderer'}));
  for(const w of BrowserWindow.getAllWindows())attach(w);app.on('browser-window-created',(_e,w)=>attach(w));globalThis.tusInstallerHooksInstalled=true;
 })).catch(error=>{evidence.hookError=error.message;});
 async function snapshot(label){
  const sample={label,time:Date.now()};
  try{sample.main=await bounded(()=>app.evaluate(({app})=>({electron:process.versions.electron,chrome:process.versions.chrome,gpuFeatures:app.getGPUFeatureStatus(),hooksInstalled:globalThis.tusInstallerHooksInstalled,processEvents:globalThis.tusInstallerEvents,abnormalObserved:globalThis.tusInstallerAbnormal})));}catch(error){sample.mainError=error.message;}
  try{sample.devices=await bounded(()=>app.evaluate(async({app})=>(await app.getGPUInfo('basic')).gpuDevice));}catch(error){sample.gpuError=error.message;}
  if(page)try{sample.renderer=await bounded(()=>page.evaluate(()=>{const e=document.querySelector('#scene-error'),gl=document.querySelector('#viewport canvas')?.getContext('webgl2');const d=gl?.getExtension('WEBGL_debug_renderer_info');return {sceneError:e?.hidden?'':e?.textContent,connected:document.querySelector('#connection')?.textContent.includes('World connected'),context:!!gl,lost:gl?.isContextLost(),vendor:gl?.getParameter(gl.VENDOR),renderer:gl?.getParameter(gl.RENDERER),backend:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):null,hooksInstalled:window.tusInstallerHooksInstalled,contextEvents:window.tusInstallerContextEvents,contextLossObserved:window.tusInstallerContextLost};}));}catch(error){sample.rendererError=error.message;}
  return sample;
 }
 return {
  async attachPage(value){page=value;page.on('console',message=>record(evidence.console,message.text()));page.on('pageerror',error=>{if(evidence.pageErrors.length<30)evidence.pageErrors.push({time:Date.now(),text:error.message.slice(0,1800)});});
   await bounded(()=>page.evaluate(()=>{window.tusInstallerHooksInstalled=false;window.tusInstallerContextEvents=[];window.tusInstallerContextLost=false;const hook=()=>{const c=document.querySelector('#viewport canvas');if(c&&!c.dataset.tusInstallerObserved){c.dataset.tusInstallerObserved='true';for(const type of ['webglcontextlost','webglcontextrestored'])c.addEventListener(type,()=>{if(type==='webglcontextlost')window.tusInstallerContextLost=true;if(window.tusInstallerContextEvents.length<30)window.tusInstallerContextEvents.push({time:Date.now(),type});});}};hook();const observer=new MutationObserver(hook);observer.observe(document.documentElement,{childList:true,subtree:true});window.tusInstallerHooksInstalled=true;})).catch(error=>{evidence.pageHookError=error.message;});
  },
  async verify(check){
   let after;
   await preserveGraphicsFailure(async()=>{after=await checkThenObserve(check,async()=>({...await snapshot('after-strict-assertion'),hookError:evidence.hookError,pageHookError:evidence.pageHookError}));},async error=>{
    evidence.firstFailure={time:Date.now(),message:error.message};
    const first=await snapshot('failure-first-observation');
    console.log(JSON.stringify({event:'installer-graphics-failure',...evidence,first,acceptance:'failed-original-assertion'}));
    await new Promise(resolve=>setTimeout(resolve,750));
    console.log(JSON.stringify({event:'installer-graphics-postfailure',stage,diagnosticOnly:true,acceptance:'still-failed',sample:await snapshot('750ms-after-failure-no-retry')}));
   });
   console.log(JSON.stringify({event:'installer-graphics-pass-observation',...evidence,after}));
  }
 };
}
