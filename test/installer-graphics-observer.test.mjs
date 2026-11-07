import test from 'node:test';import assert from 'node:assert/strict';
import {preserveGraphicsFailure,checkThenObserve,assertNoCapturedGraphicsFailure} from '../scripts/installer-graphics-observer.mjs';
import {readFileSync} from 'node:fs';import {recoveryInstallerSmoke} from '../scripts/recovery-installer-transform.mjs';
test('instrumentation preserves first assertion identity and never retries, even if diagnostics fail',async()=>{
 const first=Error('WebGL lost');let calls=0,reports=0;
 await assert.rejects(preserveGraphicsFailure(async()=>{calls++;throw first;},async error=>{reports++;assert.equal(error,first);throw Error('GPU info unavailable');}),error=>error===first);
 assert.equal(calls,1);assert.equal(reports,1);
 assert.equal(await preserveGraphicsFailure(async()=>true,()=>assert.fail('No failure report')),true);
});
test('current installer stages receive early hooks and unchanged strict check; RC1 remains fixture only',()=>{
 const script=recoveryInstallerSmoke(readFileSync(new URL('../scripts/windows-installer-smoke.mjs',import.meta.url),'utf8'));
 assert.match(script,/\['clean-rc3', 'migrated-rc3', 'reinstall-rc3'\]/);
 assert.ok(script.indexOf('await observeInstallerLaunch(instance, stage)')<script.indexOf('await instance.firstWindow()'));
 assert.match(script,/graphicsObserver.verify\(\(\) => assertSmokeGraphics\(page, process.platform\)\)/);
 assert.match(script,/stable default user-data path/);
 assert.match(script,/legacy \? null : await observeInstallerLaunch/);
});

test('original check precedes any snapshot; failure never waits for or invokes success observer',async()=>{
 const valid={main:{hooksInstalled:true,processEvents:[],abnormalObserved:false},renderer:{hooksInstalled:true,contextEvents:[],contextLossObserved:false}};
 const order=[];await checkThenObserve(async()=>order.push('check'),async()=>{order.push('snapshot');return valid;});assert.deepEqual(order,['check','snapshot']);
 const failure=Error('original transient failure');let observed=false;
 await assert.rejects(checkThenObserve(async()=>{throw failure;},async()=>{observed=true;return {};}),error=>error===failure);assert.equal(observed,false);
});
test('observed loss and abnormal exits fail despite subsequently healthy samples',()=>{
 const healthy={renderer:{hooksInstalled:true,contextLossObserved:false,context:true,lost:false,renderer:'D3D11',contextEvents:[]},main:{hooksInstalled:true,abnormalObserved:false,processEvents:[]}};
 assertNoCapturedGraphicsFailure(healthy);
 for(const event of [{type:'GPU',reason:'crashed',exitCode:1},{type:'renderer',reason:'oom',exitCode:1}])assert.throws(()=>assertNoCapturedGraphicsFailure({...healthy,main:{...healthy.main,processEvents:[event]}}),/Captured graphics failure/);
 assert.throws(()=>assertNoCapturedGraphicsFailure({...healthy,renderer:{...healthy.renderer,contextEvents:[{type:'webglcontextlost'},{type:'webglcontextrestored'}]}}));
 assert.throws(()=>assertNoCapturedGraphicsFailure({...healthy,main:{...healthy.main,processEvents:[],abnormalObserved:true}}));
 assert.throws(()=>assertNoCapturedGraphicsFailure({...healthy,renderer:{...healthy.renderer,contextLossObserved:true}}));
});

test('missing hooks, setup errors or malformed evidence fail closed after original check',async()=>{
 const valid={main:{hooksInstalled:true,processEvents:[],abnormalObserved:false},renderer:{hooksInstalled:true,contextEvents:[],contextLossObserved:false}};
 for(const evidence of [{},{...valid,hookError:'main failed'},{...valid,pageHookError:'page failed'},{...valid,main:{...valid.main,hooksInstalled:undefined}},{...valid,renderer:{...valid.renderer,hooksInstalled:false}},{...valid,main:{...valid.main,processEvents:undefined}},{...valid,renderer:{...valid.renderer,contextLossObserved:undefined}}]){
  let checked=false;await assert.rejects(checkThenObserve(async()=>{checked=true;},async()=>evidence));assert.equal(checked,true);
 }
});
