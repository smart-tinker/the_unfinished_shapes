import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {recoveryInstallerSmoke,assertLegacySnapshot} from '../scripts/recovery-installer-transform.mjs';
const original=readFileSync(new URL('../scripts/windows-installer-smoke.mjs',import.meta.url),'utf8');
for(const ending of ['LF','CRLF'])test(`${ending}: only verified legacy launches omit graphics; current launches stay strict`,()=>{
 const source=original.replace(/\r\n/g,'\n').replace(/\n/g,ending==='CRLF'?'\r\n':'\n');const result=recoveryInstallerSmoke(source);
 assert.equal((result.match(/await launch\(verifiedLegacyExe\)/g)||[]).length,2);
 assert.match(result,/if \(verifiedLegacyExe && executablePath === verifiedLegacyExe\)/);
 assert.ok(result.indexOf("'released RC1 checksum'")<result.indexOf('verifiedLegacyExe = path.join(extracted'));
 assert.match(result,/else \{\n    await assertSmokeGraphics\(page, process.platform\);/);
 assert.match(result,/launch\(path.join\(installDir, 'TheUnfinishedShapes.exe'\)\)/);
 assert.equal((result.match(/page = await launch\(installedExe\);/g)||[]).length,2);
 assert.match(result,/5ae62bdb9b61ae2a6c4317ec55c9a0aa66cb6621866c41293bdae7d3e633d110/);
 assert.match(result,/const legacyBuilt = await page.evaluate/);
 assert.match(result,/return window.tus.request/);
 assert.match(result,/assertLegacySnapshot\(saved, world.objects, legacyBuilt.object, settingsFixture\)/);
 assert.equal((result.match(/await close\(\); await verifyLegacyDisk\(\);/g)||[]).length,2);
 assert.match(result,/await verifyLegacyIPC\(page\); await verifyLegacyDisk\(\);/);
 assert.doesNotMatch(result,/writeFile\(.*world.json/);
});
test('unexpected source or duplicate transform target fails closed',()=>{
 assert.throws(()=>recoveryInstallerSmoke(original.replace('async function launch(executablePath) {','async function changed() {')),/Expected one exact/);
 assert.throws(()=>recoveryInstallerSmoke(original+'\nasync function launch(executablePath) {'),/Expected one exact/);
});

test('wrong migration data, thread identity and token persistence fail',()=>{
 const fixture={workspacePath:'workspace',codexPath:'codex',threadId:'saved-thread'},saved={...fixture,serverUrl:''},built={id:'real-id',type:'bridge',position:{x:7,y:1,z:0}};
 assertLegacySnapshot(saved,[built],built,fixture);
 for(const wrong of [{...saved,threadId:'other'}, {...saved,workspacePath:'other'}, {...saved,codexPath:'other'}, {...saved,token:'must-not-persist'}, {...saved,serverUrl:'http://other'}])assert.throws(()=>assertLegacySnapshot(wrong,[built],built,fixture));
 for(const objects of [[],[{...built,id:'other'}],[{...built,position:{x:8,y:1,z:0}}],[built,built]])assert.throws(()=>assertLegacySnapshot(saved,objects,built,fixture));
});
