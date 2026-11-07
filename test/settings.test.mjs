import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DATA_DIRECTORY,cleanSettings,loadSettings,saveSettings} from '../src/settings.mjs';
test('rc1 settings upgrade preserves workspace, Codex and exact saved conversation without credentials',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-upgrade-'));
 try {
  const legacy={workspacePath:'C:\\Projects\\shapes',codexPath:'C:\\Codex\\codex.exe',threadId:'existing-dialog-1',serverUrl:''};
  await writeFile(path.join(dir,'settings.json'),JSON.stringify(legacy));
  await writeFile(path.join(dir,'world.json'),'world-owned-separately');
  const loaded=await loadSettings(dir);assert.equal(loaded.schemaVersion,1);for(const key of Object.keys(legacy))assert.equal(loaded[key],legacy[key]);
  await saveSettings(dir,{...loaded,token:'DO-NOT-SAVE',apiKey:'NEVER'});
  assert.deepEqual(await loadSettings(dir),loaded);
  assert.equal((await readFile(path.join(dir,'settings.json'),'utf8')).includes('DO-NOT-SAVE'),false);
  assert.equal(await readFile(path.join(dir,'world.json'),'utf8'),'world-owned-separately');
  assert.deepEqual((await readdir(dir)).sort(),['settings.json','world.json']);
  assert.equal(DATA_DIRECTORY,'the-unfinished-shapes');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('invalid or future settings are not overwritten while loading',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-settings-'));
 try {
  for(const value of ['{broken',JSON.stringify({schemaVersion:99})]) {
   await writeFile(path.join(dir,'settings.json'),value);await assert.rejects(loadSettings(dir));assert.equal(await readFile(path.join(dir,'settings.json'),'utf8'),value);
  }
  assert.throws(()=>cleanSettings({serverUrl:'https://user:pass@example.com'}));
  assert.throws(()=>cleanSettings({threadId:{id:'oops'}}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
