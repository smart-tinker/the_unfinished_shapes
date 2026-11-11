import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startupUpdateOptions} from '../src/update-release.mjs';

const release=(tag_name,prerelease)=>({tag_name,prerelease,draft:false});

test('startup offers stable and a newer prerelease as separate choices',()=>{
 const result=startupUpdateOptions({
  stable:release('v1.0.0',false),
  prerelease:release('v1.1.0-rc.2',true),
 },'0.9.0');
 assert.equal(result.stable.release.tag_name,'v1.0.0');
 assert.equal(result.stable.relation,'update');
 assert.equal(result.prerelease.release.tag_name,'v1.1.0-rc.2');
 assert.equal(result.prerelease.relation,'update');
});

test('startup does not offer a prerelease older than stable, and labels a stable downgrade',()=>{
 const result=startupUpdateOptions({
  stable:release('v0.9.0',false),
  prerelease:release('v0.8.0-rc.10',true),
 },'1.0.0');
 assert.equal(result.stable.relation,'downgrade');
 assert.equal(result.prerelease,null);
});

test('startup reports no stable honestly while still offering a newer prerelease',()=>{
 const result=startupUpdateOptions({
  stable:null,
  prerelease:release('v0.1.0-rc.11',true),
 },'0.1.0-rc.10');
 assert.equal(result.stable,null);
 assert.equal(result.prerelease.release.tag_name,'v0.1.0-rc.11');
 assert.equal(result.prerelease.relation,'update');
});

import {readFileSync} from 'node:fs';

test('startup update discovery is non-blocking and has an accessible entry point',()=>{
 const main=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8');
 const preload=readFileSync(new URL('../src/preload.cjs',import.meta.url),'utf8');
 const renderer=readFileSync(new URL('../src/renderer.mjs',import.meta.url),'utf8');
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 assert.match(main,/handle\('updates:startup-check'/);
 assert.match(preload,/checkStartupUpdates:.*updates:startup-check/);
 assert.match(renderer,/void bridge\.checkStartupUpdates\(\)/);
 assert.match(html,/id="updates-notice"[^>]*hidden/);
});
