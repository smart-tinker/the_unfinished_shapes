import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listPublishedReleases,selectReleaseAsset} from '../src/update-release.mjs';

const response=(status,body,headers={})=>({ok:status>=200&&status<300,status,headers:{get:key=>headers[key.toLowerCase()]??null},json:async()=>body});
const release=(tag_name,assets=[])=>({tag_name,prerelease:tag_name.includes('-rc'),draft:false,assets});

test('release discovery paginates the official API and returns independent channels',async()=>{
 const calls=[];
 const result=await listPublishedReleases(async(url,options)=>{
  const parsed=new URL(url),page=Number(parsed.searchParams.get('page'));
  calls.push({url,options});
  if(parsed.origin!=='https://api.github.com'||parsed.pathname!=='/repos/smart-tinker/the_unfinished_shapes/releases')throw new Error('unexpected release endpoint');
  if(page===1)return response(200,Array.from({length:100},(_,i)=>({...release('v9.0.'+i),draft:true})));
  return response(200,[release('v0.1.0'),release('v0.1.0-rc11')]);
 });
 assert.equal(calls.length,2);
 assert.equal(calls[0].options.redirect,'error');
 assert.ok(calls[0].options.signal instanceof AbortSignal);
 assert.equal(result.stable.tag_name,'v0.1.0');
 assert.equal(result.prerelease.tag_name,'v0.1.0-rc11');
});

test('rate limits, malformed responses, and excessive pages fail closed',async()=>{
 await assert.rejects(listPublishedReleases(async()=>response(403,{message:'API rate limit exceeded'},{'x-ratelimit-remaining':'0'})),/rate limit/i);
 await assert.rejects(listPublishedReleases(async()=>response(200,{releases:[]})),/invalid releases/i);
 await assert.rejects(listPublishedReleases(async()=>response(200,Array.from({length:100},(_,i)=>release('v1.0.'+i))),{maxPages:1}),/page limit/i);
});

test('selects only exact OS, architecture, and package type assets',()=>{
 const version='0.1.0-rc.11',tag='v0.1.0-rc11';
 const asset=name=>({name,size:42,digest:'sha256:'+'a'.repeat(64),browser_download_url:`https://github.com/smart-tinker/the_unfinished_shapes/releases/download/${tag}/${name}`});
 const item=release(tag,[
  asset(`TheUnfinishedShapes-${version}-Setup-x64.exe`),
  asset(`TheUnfinishedShapes-${version}-win32-x64.zip`),
  asset(`TheUnfinishedShapes-${version}-linux-x64.tar.gz`),
  asset(`TheUnfinishedShapes-${version}-darwin-arm64.zip`)
 ]);
 assert.equal(selectReleaseAsset(item,{platform:'win32',architecture:'x64',distribution:'installer'}).name,`TheUnfinishedShapes-${version}-Setup-x64.exe`);
 assert.equal(selectReleaseAsset(item,{platform:'win32',architecture:'x64',distribution:'portable'}).name,`TheUnfinishedShapes-${version}-win32-x64.zip`);
 assert.equal(selectReleaseAsset(item,{platform:'linux',architecture:'x64',distribution:'archive'}).name,`TheUnfinishedShapes-${version}-linux-x64.tar.gz`);
 assert.equal(selectReleaseAsset(item,{platform:'darwin',architecture:'arm64',distribution:'archive'}).name,`TheUnfinishedShapes-${version}-darwin-arm64.zip`);
 assert.equal(selectReleaseAsset(item,{platform:'darwin',architecture:'x64',distribution:'archive'}),null);
 assert.equal(selectReleaseAsset(item,{platform:'linux',architecture:'x64',distribution:'installer'}),null);
});

test('rejects an asset with missing digest or a non-GitHub download destination',()=>{
 const tag='v0.1.0-rc11',name='TheUnfinishedShapes-0.1.0-rc.11-linux-x64.tar.gz';
 const good={name,size:42,digest:'sha256:'+'a'.repeat(64),browser_download_url:`https://github.com/smart-tinker/the_unfinished_shapes/releases/download/${tag}/${name}`};
 assert.throws(()=>selectReleaseAsset(release(tag,[{...good,digest:null}]),{platform:'linux',architecture:'x64',distribution:'archive'}),/digest/i);
 assert.throws(()=>selectReleaseAsset(release(tag,[{...good,browser_download_url:'https://attacker.example/package'}]),{platform:'linux',architecture:'x64',distribution:'archive'}),/official GitHub/i);
});
