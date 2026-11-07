import {hasAbnormalGraphicsExit} from '../tools/windows-graphics-outcome.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../tools/windows-profile-graphics-diagnostic.mjs',import.meta.url),'utf8');
test('diagnostic preserves exact source and real fixture, separates backend and profile cases',()=>{
 assert.match(script,/867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488/);assert.match(script,/5ae62bdb9b61ae2a6c4317ec55c9a0aa66cb6621866c41293bdae7d3e633d110/);
 assert.match(script,/\['default','swiftshader'\]/);assert.match(script,/\['clean','settings-only','full-legacy-profile','data-only-fresh-profile','clean-live-build'\]/);
 assert.match(script,/window.tus.request\(\{\.\.\.s,path:'\/command'/);
 assert.match(script,/Clean live-build must start with healthy graphics/);
 assert.match(script,/child-process-gone/);assert.match(script,/webglcontextlost/);
 assert.match(script,/assert.deepEqual\(result.contextLossEvents,\[\]/);
 assert.doesNotMatch(script,/enable-unsafe|disable-web-security|gh release/);
});

test('abnormal graphics exit remains failure even when later samples recover',()=>{
 for(const type of ['GPU','renderer'])for(const reason of ['crashed','oom','killed','launch-failed'])assert.equal(hasAbnormalGraphicsExit([{type,reason,exitCode:1}]),true);
 assert.equal(hasAbnormalGraphicsExit([{type:'GPU',reason:'crashed',exitCode:0},{type:'GPU',reason:'clean-exit',exitCode:0}]),true);
 assert.equal(hasAbnormalGraphicsExit([{type:'GPU',reason:'clean-exit',exitCode:0}]),false);
 assert.equal(hasAbnormalGraphicsExit([]),false);
});
test('readiness and profile identity precede writes and live graphics samples; capture bounded',()=>{
 assert.match(script,/Only test-owned userData may be used/);
 assert.ok(script.indexOf("Only test-owned userData")<script.indexOf('const built=await page.evaluate'));
 assert.ok(script.indexOf("textContent.includes('World connected')")<script.indexOf("if(kind==='clean-live-build')"));
 assert.match(script,/rendererErrors.length<40/);assert.match(script,/tusDiagnosticCrashes.length<40/);
 assert.match(script,/observationLimit:/);assert.match(script,/result.passed=false;result.crashEvidenceUnavailable=true/);
});
