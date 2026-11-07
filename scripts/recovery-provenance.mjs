// Validation-only recovery for immutable rc3. No network or release mutations.
import {execFileSync} from 'node:child_process';
import {readFile,mkdir,copyFile,symlink,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import {recoveryInstallerSmoke} from './recovery-installer-transform.mjs';
const source=path.resolve('candidate'),harness=path.resolve('recovery-harness');
const sha='867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488',tree='e78ce3b60655514fccd8426c0c7b32de710b72be';
const revision=execFileSync('git',['-C',path.resolve('recovery'),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const recoveryTree=execFileSync('git',['-C',path.resolve('recovery'),'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
assert.equal(revision,process.env.GITHUB_SHA,'Harness checkout must match run revision');
assert.equal(revision,process.env.RECOVERY_WORKFLOW_SHA,'Workflow definition must match harness revision');
let prHead=null,prBase=null;
if(process.env.RECOVERY_EVENT==='pull_request'){
 prHead=process.env.RECOVERY_PR_HEAD;prBase=process.env.RECOVERY_PR_BASE;
 assert.match(prHead||'',/^[a-f0-9]{40}$/);assert.match(prBase||'',/^[a-f0-9]{40}$/);
 const parents=execFileSync('git',['-C',path.resolve('recovery'),'show','-s','--format=%P','HEAD'],{encoding:'utf8'}).trim().split(' ');
 assert.deepEqual(parents,[prBase,prHead],'PR synthetic checkout must merge the event base and reviewed head, in order');
}else assert.equal(process.env.RECOVERY_EVENT,'workflow_dispatch','Unexpected recovery event');
const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),sha);assert.equal(git('rev-parse','HEAD^{tree}'),tree);
assert.equal(git('diff','HEAD','--'),'','Tracked candidate content must remain unchanged');
if(process.argv[2]==='prepare'){
 await mkdir(harness);await symlink(path.join(source,'node_modules'),path.join(harness,'node_modules'),process.platform==='win32'?'junction':'dir');
 for(const name of ['electron-smoke.mjs','smoke-graphics.mjs','recovery-installer-transform.mjs'])await copyFile(new URL(name,import.meta.url),path.join(harness,name));
 let installer=await readFile(path.join(source,'scripts/windows-installer-smoke.mjs'),'utf8');
 installer=recoveryInstallerSmoke(installer);
 await writeFile(path.join(harness,'windows-installer-smoke.mjs'),installer);
}else if(process.argv[2]==='report'){
 const require=createRequire(path.join(source,'package.json')),{extractFile}=await import(require.resolve('@electron/asar'));
 const platform=process.platform,arch=process.arch,folder=path.join(source,'dist',`TheUnfinishedShapes-${platform}-${arch}`);
 const archive=platform==='darwin'?path.join(folder,'TheUnfinishedShapes.app/Contents/Resources/app.asar'):path.join(folder,'resources/app.asar');
 for(const item of await readdir(path.join(source,'src'),{recursive:true,withFileTypes:true}))if(item.isFile()){
  const file=path.join(item.parentPath,item.name);assert.deepEqual(extractFile(archive,path.relative(source,file)),await readFile(file));
 }
 const hashes={};for(const name of await readdir(path.join(source,'dist')))if(/\.(zip|exe|tar\.gz)$/.test(name))hashes[name]=createHash('sha256').update(await readFile(path.join(source,'dist',name))).digest('hex');
 assert.ok(Object.keys(hashes).length,'No packaged deliverables');
 const proof={sourceSHA:sha,sourceTree:tree,workflowRevision:revision,workflowTree:recoveryTree,recoveryEvent:process.env.RECOVERY_EVENT,prHeadSHA:prHead,prBaseSHA:prBase,workflowRef:process.env.GITHUB_WORKFLOW_REF,run:process.env.GITHUB_RUN_ID,platform,arch,node:process.version,electron:JSON.parse(await readFile(path.join(source,'node_modules/electron/package.json'),'utf8')).version,appAsarSHA256:createHash('sha256').update(await readFile(archive)).digest('hex'),artifactSHA256:hashes,operatorVMAttestation:process.env.VM_ACCEPTED==='true',operatorEvidenceReference:process.env.VM_EVIDENCE||null,vmVerifiedByWorkflow:false,published:false,releaseAuthorizedByValidation:false};
 console.log(JSON.stringify(proof,null,2));
}else throw Error('Expected prepare or report');
