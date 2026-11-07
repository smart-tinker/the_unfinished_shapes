import test from 'node:test';
import assert from 'node:assert/strict';
import {smokeGraphicsFlags,assertSmokeGraphics} from '../scripts/smoke-graphics.mjs';
const healthy={lost:false,vendor:'WebKit',renderer:'WebKit WebGL',backend:'ANGLE (Google, SwiftShader driver)'};
const page=(evidence=healthy,visible=false)=>({waitForFunction:async()=>{},locator:()=>({textContent:async()=> 'Error creating WebGL context',isVisible:async()=>visible}),evaluate:async()=>evidence});
test('explicit software rendering is Linux CI only; no new unsafe flags',()=>{
 assert.deepEqual(smokeGraphicsFlags('linux'),['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']);
 for(const platform of ['darwin','win32','unknown'])assert.deepEqual(smokeGraphicsFlags(platform),[]);
 assert.equal(smokeGraphicsFlags('linux').some(flag=>flag.includes('unsafe')||flag.includes('disable-web-security')),false);
});
test('graphics gate rejects missing/lost context, null renderer and wrong Linux backend',async()=>{
 await assertSmokeGraphics(page(),'linux');
 for(const evidence of [{error:'missing'}, {...healthy,lost:true},{...healthy,vendor:null},{...healthy,renderer:null},{...healthy,backend:'Mesa llvmpipe'},{...healthy,backend:null}])await assert.rejects(assertSmokeGraphics(page(evidence),'linux'));
 await assert.rejects(assertSmokeGraphics(page(healthy,true),'linux'),/Scene initialization failed: Error creating WebGL context/);
 await assertSmokeGraphics(page({...healthy,backend:'Apple M1'}),'darwin');
 await assertSmokeGraphics(page({...healthy,backend:null}),'win32');
});
