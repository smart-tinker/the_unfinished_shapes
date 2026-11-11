import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cleanSettings,loadSettings,saveSettings} from '../src/settings.mjs';

test('stable is the default update channel',()=>{
 assert.equal(cleanSettings().updateChannel,'stable');
});

test('explicit prerelease channel survives settings save and load',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tus-update-channel-'));
 try{
  await saveSettings(dir,{updateChannel:'prerelease'});
  assert.equal((await loadSettings(dir)).updateChannel,'prerelease');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unknown update channels are rejected',()=>{
 assert.throws(()=>cleanSettings({updateChannel:'preview'}),/update channel/i);
});
