import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/rc3-recovery-validation.yml',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const helper=readFileSync(new URL('../scripts/recovery-provenance.mjs',import.meta.url),'utf8');
test('recovery validates fixed rc3 without publication, privileged events or paid storage',()=>{
 assert.match(workflow,/ref: 867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488/);
 assert.match(workflow,/contents: read\n  actions: read/);
 assert.doesNotMatch(workflow,/contents: write|pull_request_target|gh release|upload-artifact|actions\/cache|--force/);
 assert.match(workflow,/actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
 assert.match(workflow,/actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
 assert.match(workflow,/r\.event==='push'.*r\.head_branch==='release\/0\.1\.0-rc3'.*r\.head_sha==='867b5fa/);
});
test('external harness and evidence distinguish source identity from recovery revision and manual GUI attestation',()=>{
 assert.match(helper,/assert\.equal\(revision,process\.env\.RECOVERY_WORKFLOW_SHA/);
 assert.match(helper,/assert\.equal\(git\('diff','HEAD','--'\),''/);
 assert.match(helper,/createRequire\(path\.join\(source,'package.json'\)\)/);
 assert.match(helper,/symlink\(path\.join\(source,'node_modules'\),path\.join\(harness,'node_modules'\)/);
 assert.match(helper,/workflowTree:recoveryTree/);
 assert.match(helper,/vmVerifiedByWorkflow:false,published:false,releaseAuthorizedByValidation:false/);
 assert.doesNotMatch(workflow,/if:.*inputs\.vm_accepted/);
});

test('new workflow has scoped same-repository PR route and records synthetic identity honestly',()=>{
 assert.match(workflow,/pull_request:\n    paths:/);
 assert.match(workflow,/github\.head_ref == 'recovery\/rc3-graphics-validation'/);
 assert.match(workflow,/github\.base_ref == 'release\/0\.1\.0-rc3'/);
 assert.match(workflow,/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
 assert.match(workflow,/fetch-depth: 2/);
 assert.match(helper,/assert\.deepEqual\(parents,\[prBase,prHead\]/);
 assert.match(helper,/prHeadSHA:prHead,prBaseSHA:prBase/);
});
