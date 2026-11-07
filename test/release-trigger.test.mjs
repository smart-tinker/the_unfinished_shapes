import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
const release=workflow.split('  release-windows:\n')[1].split('  release-macos:\n')[0];
const condition=release.match(/^    if: (.+)$/m)[1];
test('publication requires explicit exact-branch push or opted-in RC dispatch',()=>{
 const allows=(event,ref,opt=false,privateRepo=false)=>runInNewContext(condition,{github:{event:{repository:{private:privateRepo}},event_name:event,ref},inputs:{publish_rc:opt}},{timeout:100});
 assert.equal(allows('push','refs/heads/publish/0.1.0-rc3'),true);
 assert.equal(allows('workflow_dispatch','refs/heads/release/0.1.0-rc3',true),true);
 for(const event of ['push','pull_request','workflow_dispatch'])for(const ref of ['refs/heads/main','refs/heads/release/0.1.0-rc3','refs/heads/release/other','refs/heads/feature/test','refs/heads/publish/other']){
  if(event==='workflow_dispatch'&&ref==='refs/heads/release/0.1.0-rc3')continue;
  assert.equal(allows(event,ref,true),false,`${event} ${ref}`);
 }
 assert.equal(allows('workflow_dispatch','refs/heads/release/0.1.0-rc3',false),false);
 assert.equal(allows('workflow_dispatch','refs/heads/publish/0.1.0-rc3',true),false);
 assert.equal(allows('push','refs/heads/publish/0.1.0-rc3',false,true),false);
 assert.equal(allows('workflow_dispatch','refs/heads/release/0.1.0-rc3',true,true),false);
});
test('both routes retain RC-head, exact CPU-run, platform and immutable tag gates',()=>{
 assert.match(workflow,/branches: \[main, 'release\/\*\*', 'publish\/0\.1\.0-rc3'\]/);
 assert.match(release,/needs: \[test, windows-installer, macos-native\]/);
 assert.match(release,/git\/ref\/heads\/release\/0\.1\.0-rc3/);
 assert.match(release,/r\.object\?\.type!=='commit' \|\| r\.object\.sha!==process\.env\.GITHUB_SHA/);
 assert.match(release,/x\.head_sha===process\.env\.GITHUB_SHA && x\.status==='completed' && x\.conclusion==='success'/);
 assert.ok(release.indexOf('Require the current accepted RC head')<release.indexOf('Check immutable release version'));
 assert.match(release,/node scripts\/verify-release-tag\.mjs "\$TAG" --create-missing/);
 assert.match(workflow,/node \.\.\/scripts\/verify-release-tag\.mjs "\$TAG"\n          gh release edit/);
});

test('both publication routes serialize the entire workflow without cancellation',()=>{
 const group=workflow.match(/^  group: \$\{\{ (.+) \}\}$/m)[1];
 const cancel=workflow.match(/^  cancel-in-progress: \$\{\{ (.+) \}\}$/m)[1];
 const evaluate=(expression,event,ref,opt=false)=>runInNewContext(expression,{github:{event_name:event,ref},inputs:{publish_rc:opt},format:(pattern,value)=>pattern.replace('{0}',value)},{timeout:100});
 const routes=[['workflow_dispatch','refs/heads/release/0.1.0-rc3',true],['push','refs/heads/publish/0.1.0-rc3',false]];
 for(const route of routes){assert.equal(evaluate(group,...route),'publish-0.1.0-rc3');assert.equal(evaluate(cancel,...route),false);}
 for(const route of [['push','refs/heads/release/0.1.0-rc3',false],['pull_request','refs/pull/17/merge',false],['workflow_dispatch','refs/heads/release/0.1.0-rc3',false]]){
  assert.equal(evaluate(group,...route),`validate-${route[1]}`);assert.equal(evaluate(cancel,...route),true);
 }
});

test('CPU gate accepts exact RC push only, not synthetic PR or foreign branch evidence',()=>{
 const predicate=release.match(/r\.some\(x=>(.+?)\)\)/)[1];
 const sha='a'.repeat(40),base={path:'.github/workflows/local-cpu-model.yml',event:'push',head_branch:'release/0.1.0-rc3',head_sha:sha,status:'completed',conclusion:'success'};
 const accepts=x=>runInNewContext(predicate,{x,process:{env:{GITHUB_SHA:sha}}},{timeout:100});
 assert.equal(accepts(base),true);
 for(const overrides of [{event:'pull_request'},{event:'workflow_dispatch'},{head_branch:'feature/tools'},{head_branch:'publish/0.1.0-rc3'},{head_sha:'b'.repeat(40)},{status:'in_progress'},{conclusion:'failure'},{path:'.github/workflows/other.yml'}])assert.equal(accepts({...base,...overrides}),false,JSON.stringify(overrides));
});
