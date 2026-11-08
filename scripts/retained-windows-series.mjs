import {verifyPortable} from './retained-windows-portable.mjs';
import assert from 'node:assert/strict';
import {access,copyFile,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {ASSETS,HARNESS,HELPERS,PLAN,RELEASE,REPO,SOURCE,TAG,TREE,instrument,safeDownloadURL,snapshot,strictPassed} from './retained-windows-core.mjs';
const run=promisify(execFile);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=async file=>sha(await readFile(file));
const root=process.cwd(),candidate=path.join(root,'candidate'),pinned=path.join(root,'pinned-harness');
const output=path.join(root,'retained-evidence'),fixture=path.join(root,'retained-fixture');
const generated=path.join(fixture,'harness');
const ownedPaths=[path.join(process.env.APPDATA||'','the-unfinished-shapes'),path.join(process.env.LOCALAPPDATA||'','Programs','TUS-Installer-Smoke')];
async function absent(file) {try {await access(file);} catch(e) {if(e.code==='ENOENT')return;throw e;}throw Error(`Pre-existing or uncleared test path: ${file}`);}
async function clean() {for(const file of ownedPaths)await absent(file);}
const token=process.env.GITHUB_TOKEN;
// The token is only used against api.github.com here, never passed to a test child.
delete process.env.GITHUB_TOKEN;
async function api(endpoint) {
 const response=await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`,{
  headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error(`GitHub read ${endpoint.split('?')[0]} failed: ${response.status}`);
 return response.json();
}
async function remoteState() {
 const tag=await api(`git/ref/tags/${TAG}`);let object=tag.object;
 for(let i=0;object.type==='tag'&&i<5;i++)object=(await api(`git/tags/${object.sha}`)).object;
 assert.equal(object.type,'commit');assert.equal(object.sha,SOURCE);
 assert.equal((await api(`git/commits/${SOURCE}`)).tree.sha,TREE);
 const rcBranch=await api('git/ref/heads/release/0.1.0-rc3');
 assert.equal(rcBranch.object.type,'commit');assert.equal(rcBranch.object.sha,SOURCE);
 return {...snapshot(await api(`releases/${RELEASE}`),tag),rcBranch};
}
async function download(asset) {
 const file=path.join(fixture,'assets',asset.name);await absent(file);
 const response=await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`,{
  headers:{Authorization:`Bearer ${token}`,Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28'},redirect:'manual',signal:AbortSignal.timeout(300000)});
 let body=response;
 if(response.status===302) {
  const url=safeDownloadURL(response.headers.get('location'));
  // Deliberately new request with no authorization header, no further redirects.
  body=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(300000)});
 }
 if(body.status!==200||!body.body)throw Error(`Asset ${asset.id} download failed: ${body.status}`);
 let count=0;
 await pipeline(body.body,new Transform({transform(chunk,encoding,callback){count+=chunk.length;callback(count>asset.size?Error('Asset exceeds fixed size'):null,chunk);}}),createWriteStream(file,{flags:'wx'}));
 assert.equal(count,asset.size);assert.equal(await hash(file),asset.sha256);return file;
}
async function trial(plan,env) {
 const stdout=createWriteStream(path.join(output,`${plan.id}.stdout.log`),{flags:'wx'});
 const stderr=createWriteStream(path.join(output,`${plan.id}.stderr.log`),{flags:'wx'});
 const started=Date.now();let timedOut=false;
 const child=spawn(process.execPath,[path.join(generated,`${plan.mode}.mjs`)],{cwd:fixture,env,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(stdout);child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(stderr);child.stderr.pipe(process.stderr,{end:false});
 // On timeout, kill only this child's process tree and stop the whole series. Never clean unknown remnants.
 let timer;let code,signal,error;
 try {({code,signal}=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  timer=setTimeout(()=>{timedOut=true;
   execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{timeout:15000},()=>{
    child.stdout.destroy();child.stderr.destroy();child.unref();resolve({code:null,signal:'series-timeout'});
   });
  },12*60*1000);
 }));}catch(e){error=e.message;}finally{clearTimeout(timer);}
 stdout.end();stderr.end();
 await Promise.all([new Promise(resolve=>stdout.closed?resolve():stdout.once('close',resolve)),new Promise(resolve=>stderr.closed?resolve():stderr.once('close',resolve))]);
 return {...plan,status:code===0&&!timedOut&&!error?'passed':'failed',code,signal,error,timedOut,durationMs:Date.now()-started};
}
async function workflowProvenance() {
 const checkout=(await run('git',['-C',path.join(root,'validation'),'rev-parse','HEAD'])).stdout.trim();
 assert.equal(checkout,process.env.GITHUB_SHA);assert.equal(checkout,process.env.GITHUB_WORKFLOW_SHA);
 if(process.env.GITHUB_EVENT_NAME==='pull_request') {
  const parents=(await run('git',['-C',path.join(root,'validation'),'show','-s','--format=%P','HEAD'])).stdout.trim().split(' ');
  assert.deepEqual(parents,[process.env.RETAINED_PR_BASE,process.env.RETAINED_PR_HEAD],'exact PR merge parents');
 } else assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
}
async function candidateUnchanged() {
 await run('git',['-C',candidate,'diff','--exit-code','HEAD','--']);
 assert.equal((await run('git',['-C',candidate,'ls-files','--others','--exclude-standard'])).stdout.trim(),'','No untracked candidate files');
}
if (process.argv.includes('--preflight')) {
 assert.equal(process.env.GITHUB_REPOSITORY,REPO);assert.ok(token);
 await workflowProvenance();await remoteState();console.log('Fixed retained draft, source, tag and assets verified using read-only token.');process.exit(0);
}
const results=PLAN.map(p=>({...p,status:'not-run'}));
let before,identity,initialHashes,finalHashes,blocker,postVerified=false;
try {
 assert.equal(process.platform,'win32');assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_OS,'Windows');
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,REPO);assert.ok(token,'read-only GITHUB_TOKEN required');
 await clean();await absent(fixture);await absent(output);
 await mkdir(output);await mkdir(generated,{recursive:true});await mkdir(path.join(fixture,'assets'));await mkdir(path.join(fixture,'dist','installer'),{recursive:true});
 for(const [dir,commit] of [[candidate,SOURCE],[pinned,HARNESS]])assert.equal((await run('git',['-C',dir,'rev-parse','HEAD'])).stdout.trim(),commit);
 assert.equal((await run('git',['-C',candidate,'rev-parse','HEAD^{tree}'])).stdout.trim(),TREE);
 await workflowProvenance();await candidateUnchanged();before=await remoteState();
 for(const [name,expected] of Object.entries(HELPERS)) {
  // Read canonical git blobs so Windows autocrlf does not change the reviewed harness identity.
  const content=(await run('git',['-C',pinned,'show',`${HARNESS}:scripts/${name}`],{maxBuffer:1024*1024})).stdout;
  assert.equal(sha(content),expected);await writeFile(path.join(generated,name),content);
 }
 await copyFile(new URL('./retained-installed-identity.mjs',import.meta.url),path.join(generated,'retained-installed-identity.mjs'));
 await symlink(path.join(candidate,'node_modules'),path.join(generated,'node_modules'),'junction');
 const transform=await import(pathToFileURL(path.join(generated,'recovery-installer-transform.mjs')));
 const source=await readFile(path.join(candidate,'scripts','windows-installer-smoke.mjs'),'utf8');
 await writeFile(path.join(generated,'strict.mjs'),instrument(transform.recoveryInstallerSmoke(source)));
 await writeFile(path.join(generated,'diagnostic.mjs'),instrument(transform.recoveryInstallerSwiftShader(source)));
 const [installer,zip]=await Promise.all(ASSETS.map(download));
 const usedInstaller=path.join(fixture,'dist','installer',ASSETS[0].name);await copyFile(installer,usedInstaller);
 const extracted=path.join(fixture,'portable');
 const quote=p=>"'"+p.replaceAll("'","''")+"'";
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(extracted)}`],{timeout:180000});
 const app=path.join(extracted,'TheUnfinishedShapes-win32-x64');
 const asar=path.join(app,'resources','app.asar'),exe=path.join(app,'TheUnfinishedShapes.exe');
 identity=await verifyPortable(asar,candidate);
 const hashes=async()=>({installer:await hash(installer),usedInstaller:await hash(usedInstaller),zip:await hash(zip),asar:await hash(asar),executable:await hash(exe)});
 initialHashes=await hashes();assert.equal(initialHashes.usedInstaller,ASSETS[0].sha256);
 const env={...process.env,TUS_RETAINED_ASAR_SHA256:initialHashes.asar,TUS_RETAINED_EXE_SHA256:initialHashes.executable};
 for(let i=0;i<PLAN.length;i++) {
  await clean();assert.deepEqual(await hashes(),initialHashes,'retained identity before trial');
  console.log(JSON.stringify({event:'retained-trial-start',...PLAN[i]}));
  results[i]=await trial(PLAN[i],env);console.log(JSON.stringify({event:'retained-trial-result',...results[i]}));
  // Failure is retained; continue only if the original lifecycle finished cleanup safely.
  if(results[i].timedOut)throw Error('Child timed out: cleanup uncertain, remaining trials not run');
  await clean();assert.deepEqual(await hashes(),initialHashes,'retained identity after trial');
 }
 finalHashes=await hashes();
} catch(e) {blocker=e.message;console.error(`Retained series blocked: ${blocker}`);}
finally {
 if(initialHashes)try {finalHashes={installer:await hash(path.join(fixture,'assets',ASSETS[0].name)),usedInstaller:await hash(path.join(fixture,'dist','installer',ASSETS[0].name)),zip:await hash(path.join(fixture,'assets',ASSETS[1].name)),asar:await hash(path.join(fixture,'portable','TheUnfinishedShapes-win32-x64','resources','app.asar')),executable:await hash(path.join(fixture,'portable','TheUnfinishedShapes-win32-x64','TheUnfinishedShapes.exe'))};assert.deepEqual(finalHashes,initialHashes);}catch(e){blocker=[blocker,`Final local identity: ${e.message}`].filter(Boolean).join('; ');}
 if(before)try {await candidateUnchanged();}catch(e){blocker=[blocker,`Candidate changed: ${e.message}`].filter(Boolean).join('; ');}
 if(before)try {assert.deepEqual(await remoteState(),before,'remote release/tag/assets unchanged');postVerified=true;}catch(e){blocker=[blocker,`Post-series verification: ${e.message}`].filter(Boolean).join('; ');}
 const evidence={schema:1,source:SOURCE,tree:TREE,harness:HARNESS,assets:ASSETS.map(a=>({...a,url:`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`})),release:`https://github.com/${REPO}/releases/tag/${TAG}`,identity,initialHashes,finalHashes,results,blocker,postVerified,strictPassed:strictPassed(results),diagnosticsReplaceStrict:false,
  run:{id:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,url:`https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`,sha:process.env.GITHUB_SHA,workflowRef:process.env.GITHUB_WORKFLOW_REF,workflowSHA:process.env.GITHUB_WORKFLOW_SHA,event:process.env.GITHUB_EVENT_NAME,prHead:process.env.RETAINED_PR_HEAD,prBase:process.env.RETAINED_PR_BASE}};
 console.log(JSON.stringify({event:'retained-series-summary',...evidence}));
 try {await writeFile(path.join(output,'summary.json'),JSON.stringify(evidence,null,2));if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,`## Retained RC3 Windows series\n\nStrict: ${evidence.strictPassed?'5/5 passed':'FAILED / incomplete'}. Diagnostic results never replace strict acceptance.\n\n${results.map(r=>`- ${r.id}: ${r.status}`).join('\n')}\n\nRemote originals unchanged: ${postVerified}. ${blocker||''}\n`);}catch { /* Main log still contains the complete compact summary. */ }
 if(blocker||!postVerified||!evidence.strictPassed||results.some(r=>r.status!=='passed'))process.exitCode=1;
}
