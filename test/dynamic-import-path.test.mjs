import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
test('resolved asar filenames become file URLs on either platform',()=>{
 for(const file of ['../tools/windows-profile-graphics-diagnostic.mjs','../scripts/recovery-provenance.mjs']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  assert.match(source,/import\(pathToFileURL\(require.resolve\('@electron\/asar'\)\)\.href\)/);
  assert.doesNotMatch(source,/import\(require.resolve\(/);
 }
 // Explicit platform option exercises Windows drive paths even on Linux CI.
 assert.equal(pathToFileURL('D:\\runner work\\node_modules\\@electron\\asar\\lib\\asar.js',{windows:true}).href,'file:///D:/runner%20work/node_modules/@electron/asar/lib/asar.js');
 assert.equal(pathToFileURL('/tmp/runner work/node_modules/@electron/asar/lib/asar.js',{windows:false}).href,'file:///tmp/runner%20work/node_modules/@electron/asar/lib/asar.js');
});
