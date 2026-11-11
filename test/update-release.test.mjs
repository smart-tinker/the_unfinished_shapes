import {test} from 'node:test';
import assert from 'node:assert/strict';

async function updater(){return import('../src/update-release.mjs');}

test('parses historical RC tags and compares RC numbers numerically',async()=>{
 const {parseReleaseTag,compareReleaseVersions}=await updater();
 assert.equal(parseReleaseTag('v0.1.0-rc11').prereleaseNumber,11);
 assert.equal(parseReleaseTag('0.1.0-rc.11').prereleaseNumber,11);
 assert.equal(compareReleaseVersions('v0.1.0-rc10','0.1.0-rc.9'),1);
 assert.equal(compareReleaseVersions('0.1.0','v0.1.0-rc11'),1);
 assert.equal(parseReleaseTag('archive/v0.1.0-rc11'),null);
});

test('chooses latest published stable and prerelease independently of API order',async()=>{
 const {selectReleaseCandidates}=await updater();
 const release=(tag_name,prerelease,draft=false)=>({tag_name,prerelease,draft,html_url:'https://github.com/smart-tinker/the_unfinished_shapes/releases/tag/'+tag_name});
 const result=selectReleaseCandidates([
  release('v0.1.0-rc9',true),
  release('v0.1.0-rc11',true),
  release('v0.1.0-rc10',true),
  release('v1.0.0',false),
  release('v9.0.0',false,true),
  release('archive/v8.0.0',false),
  release('v7.0.0-preview.1',true),
  release('v2.0.0',true)
 ]);
 assert.equal(result.stable.tag_name,'v1.0.0');
 assert.equal(result.prerelease.tag_name,'v0.1.0-rc11');
});

test('reports no candidate when every release is a draft or has an unsupported tag',async()=>{
 const {selectReleaseCandidates}=await updater();
 assert.deepEqual(selectReleaseCandidates([
  {tag_name:'v9.0.0',draft:true,prerelease:false},
  {tag_name:'archive/v8.0.0',draft:false,prerelease:false}
 ]),{stable:null,prerelease:null});
});

test('labels older candidates as downgrades and equal versions as current',async()=>{
 const {releaseRelation}=await updater();
 assert.equal(releaseRelation('v0.1.0-rc10','0.1.0-rc.11'),'downgrade');
 assert.equal(releaseRelation('v0.1.0-rc11','0.1.0-rc.11'),'current');
 assert.equal(releaseRelation('v0.1.0','0.1.0-rc.11'),'update');
});
