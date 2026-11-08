import assert from 'node:assert/strict';
export const REPO = 'smart-tinker/the_unfinished_shapes';
export const SOURCE = '867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488';
export const TREE = 'e78ce3b60655514fccd8426c0c7b32de710b72be';
export const HARNESS = 'dcb8420326eed026a5397ca20690fb0f30886362';
export const RELEASE = 437834226;
export const TAG = 'v0.1.0-rc3';
export const ASSETS = [
 {id:721891674,name:'TheUnfinishedShapes-0.1.0-rc.3-Setup-x64.exe',size:126814645,sha256:'5a39476abcd28e80df5c4af2f226e95bdcca034b7f085be337a5152c92950164'},
 {id:721891678,name:'TheUnfinishedShapes-0.1.0-rc.3-win32-x64.zip',size:170230698,sha256:'092ebd6e0b69c429c0fd35831582352f149b46577879c51c7df62a5287e558ca'}
];
export const HELPERS = {
 'recovery-installer-transform.mjs':'94aa84387527782f0a018ac64b480c9f08e25f8aa4db79abaecff8c4132c5cd8',
 'installer-graphics-observer.mjs':'4cc4feb951bfed16618fb5a35c27bcf73e81b21d9fb522c2717fd80bd9a015a1',
 'smoke-graphics.mjs':'4624b4d0e9f66b555499b1a2bb3697e823ce04f2e4446a855d08e82cab0091b3'
};
export const PLAN = Object.freeze([
 ...Array.from({length:5},(_,i)=>Object.freeze({id:`strict-${i+1}`,mode:'strict'})),
 ...Array.from({length:3},(_,i)=>Object.freeze({id:`swiftshader-diagnostic-${i+1}`,mode:'diagnostic'}))
]);
export function strictPassed(results) {
 return PLAN.filter(p=>p.mode==='strict').every(p=>results.find(r=>r.id===p.id)?.status==='passed');
}
export function verifyRelease(r) {
 assert.equal(r.id,RELEASE);assert.equal(r.draft,true);assert.equal(r.prerelease,true);
 assert.equal(r.tag_name,TAG);assert.equal(r.target_commitish,SOURCE);
 for(const expected of ASSETS) {
  const actual=r.assets.find(a=>a.id===expected.id);assert.ok(actual,'fixed retained asset exists');
  assert.equal(actual.name,expected.name);assert.equal(actual.size,expected.size);
  assert.equal(actual.state,'uploaded');assert.equal(actual.digest,`sha256:${expected.sha256}`);
 }
}
export function snapshot(r,tag) {
 verifyRelease(r);
 const {id,tag_name,target_commitish,draft,prerelease,name,body,created_at,updated_at}=r;
 return {id,tag_name,target_commitish,draft,prerelease,name,body,created_at,updated_at,tag,
  assets:r.assets.map(({id,name,size,digest,state,created_at,updated_at,url,browser_download_url})=>({id,name,size,digest,state,created_at,updated_at,url,browser_download_url})).sort((a,b)=>a.id-b.id)};
}
export function safeDownloadURL(value) {
 const u=new URL(value);
 assert.equal(u.protocol,'https:');assert.equal(u.hostname,'release-assets.githubusercontent.com');
 assert.equal(u.port,'');assert.equal(u.username,'');assert.equal(u.password,'');
 return u;
}
export function instrument(source) {
 const replace=(old,next)=>{assert.equal(source.split(old).length,2,`Expected unique identity hook: ${old}`);source=source.replace(old,next);};
 replace('async function launch(executablePath) {',`let activeRC3;
async function launch(executablePath) {
  activeRC3 = verifiedLegacyExe && executablePath === verifiedLegacyExe ? null : executablePath;
  if (activeRC3) await verifyInstalledIdentity(activeRC3, 'before-launch');`);
 replace('async function close() { await instance?.close(); instance = null; }',`async function close() {
  let identityError;
  try { if (activeRC3) await verifyInstalledIdentity(activeRC3, 'before-close'); } catch (error) { identityError = error; }
  try { await instance?.close(); instance = null; } finally { if (identityError) throw identityError; }
  if (activeRC3) await verifyInstalledIdentity(activeRC3, 'after-close');
  activeRC3 = null;
}`);
 return "import { verifyInstalledIdentity } from './retained-installed-identity.mjs';\n"+source;
}
