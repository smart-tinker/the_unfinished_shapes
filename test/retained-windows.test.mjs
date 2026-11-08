import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ASSETS,PLAN,RELEASE,SOURCE,TAG,instrument,safeDownloadURL,snapshot,strictPassed,verifyRelease} from '../scripts/retained-windows-core.mjs';
const release=()=>({id:RELEASE,draft:true,prerelease:true,tag_name:TAG,target_commitish:SOURCE,assets:ASSETS.map(a=>({...a,state:'uploaded',digest:`sha256:${a.sha256}`}))});
test('fixed 5+3 plan cannot retry a strict failure into green',()=>{
 assert.equal(PLAN.length,8);assert.deepEqual(PLAN.map(p=>p.mode),['strict','strict','strict','strict','strict','diagnostic','diagnostic','diagnostic']);
 const results=PLAN.map(p=>({...p,status:'passed'}));assert.equal(strictPassed(results),true);
 results[0].status='failed';results.push({...PLAN[0],status:'passed'});assert.equal(strictPassed(results),false);
 results[0].status='not-run';assert.equal(strictPassed(results),false);
 assert.equal(strictPassed([]),false);
});
test('release and assets fail closed on changed identities',()=>{
 verifyRelease(release());
 for(const mutate of [r=>r.draft=false,r=>r.target_commitish='main',r=>r.assets[0].digest='sha256:wrong',r=>r.assets[1].size++,r=>r.assets.pop(),r=>r.assets[0].state='new']){
  const r=release();mutate(r);assert.throws(()=>verifyRelease(r));
 }
 const r=release();r.assets[0].download_count=1;const first=snapshot(r,{sha:SOURCE});r.assets[0].download_count=2;assert.deepEqual(snapshot(r,{sha:SOURCE}),first);
 r.body='changed';assert.notDeepEqual(snapshot(r,{sha:SOURCE}),first);
});
test('signed downloads only use reviewed HTTPS origin without userinfo',()=>{
 assert.equal(safeDownloadURL('https://release-assets.githubusercontent.com/x?signature=secret').hostname,'release-assets.githubusercontent.com');
 for(const url of ['http://release-assets.githubusercontent.com/x','https://evil.example/x','https://api.github.com/x','https://user@release-assets.githubusercontent.com/x','https://release-assets.githubusercontent.com:444/x'])assert.throws(()=>safeDownloadURL(url));
});
test('identity instrumentation is exact, retains sandbox flags, and always attempts close',()=>{
 const source="async function launch(executablePath) {\n args: ['--no-sandbox'];\n}\nasync function close() { await instance?.close(); instance = null; }";
 const result=instrument(source);assert.ok(result.includes("args: ['--no-sandbox']"));assert.ok(result.includes("verifyInstalledIdentity(activeRC3, 'before-launch')"));
 assert.ok(result.includes('try { await instance?.close(); instance = null; } finally'));
 assert.ok(result.indexOf('catch (error) { identityError = error; }')<result.indexOf('await instance?.close()'));
 assert.throws(()=>instrument(source+source));assert.throws(()=>instrument('changed source'));
});
test('workflow has no writes, builds, uploads, arbitrary inputs or self-hosted runner',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/rc3-retained-windows.yml',import.meta.url),'utf8');
 assert.match(workflow,/runs-on: windows-latest/);assert.match(workflow,/contents: read/);assert.match(workflow,/actions: read/);
 assert.doesNotMatch(workflow,/contents: write|actions: write|upload-artifact|npm run (package|installer)|inputs:|self-hosted|pull_request_target/);
 assert.equal((workflow.match(/persist-credentials: false/g)||[]).length,3);
 assert.ok(workflow.indexOf('--preflight')<workflow.indexOf('npm ci'));
});
test('identity failure does not prevent closing Electron',async()=>{
 const source="async function launch(executablePath) {}\nasync function close() { await instance?.close(); instance = null; }";
 const transformed=instrument(source);
 const closeBody=transformed.slice(transformed.indexOf('async function close()'));
 const {runInNewContext}=await import('node:vm');
 let closes=0;const failure=Error('identity mismatch');
 const context={activeRC3:'installed.exe',instance:{close:async()=>{closes++;}},verifyInstalledIdentity:async()=>{throw failure;}};
 const close=runInNewContext(`${closeBody}; close`,context);
 await assert.rejects(close(),error=>error===failure);assert.equal(closes,1);
});
