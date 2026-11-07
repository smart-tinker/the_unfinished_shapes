import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {findCodex} from '../src/codex-discovery.mjs';

function windowsFs(files, directories = {}) {
  const normalize = file => path.win32.normalize(file).toLowerCase();
  const items = new Set(files.map(normalize)), dirs = new Map(Object.entries(directories).map(([p,n])=>[normalize(p),n]));
  const reads=[];
  const absent = () => {throw Object.assign(new Error('missing'),{code:'ENOENT'});};
  return {reads,fs:{
    stat:async file=>{reads.push(file);return items.has(normalize(file))?{isFile:()=>true}:absent();},
    realpath:async file=>items.has(normalize(file))?path.win32.normalize(file):absent(),
    readdir:async file=>{reads.push(file);return dirs.get(normalize(file))||absent();},
    access:async()=>{},
  }};
}

test('finds PATH binary, deduplicates results and never executes it',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tus-discovery-'));
  try {
    const one=path.join(root,'one'),two=path.join(root,'two');await fs.mkdir(one);await fs.mkdir(two);
    const binary=path.join(one,process.platform==='win32'?'codex.exe':'codex');await fs.writeFile(binary,`#!/bin/sh\ntouch '${root}/was-executed'\n`,{mode:0o755});
    if(process.platform!=='win32') await fs.symlink(binary,path.join(two,'codex'));
    const result=await findCodex({platform:process.platform,arch:'x64',env:{PATH:[one,two,one].join(path.delimiter)},home:root});
    const canonicalBinary=await fs.realpath(binary);
    const ours=result.candidates.filter(c=>c.path===canonicalBinary);
    assert.equal(ours.length,1,`Expected one canonical candidate ${canonicalBinary}; found ${JSON.stringify(result.candidates)}`);assert.equal(ours[0].source,'path');
    await assert.rejects(fs.stat(path.join(root,'was-executed')),{code:'ENOENT'});
    assert.ok(result.hints.some(h=>h.includes('does not verify')));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('Windows npm shim resolves native optional package and never returns or reads cmd',async()=>{
  const native='C:\\Users\\Player\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const fixture=windowsFs([native,'C:\\Users\\Player\\AppData\\Roaming\\npm\\codex.cmd']);
  const result=await findCodex({platform:'win32',arch:'x64',env:{Path:'C:\\Users\\Player\\AppData\\Roaming\\npm',APPDATA:'C:\\Users\\Player\\AppData\\Roaming'},home:'C:\\Users\\Player',fs:fixture.fs});
  assert.deepEqual(result.candidates.map(c=>c.path),[native]);
  assert.equal(result.candidates[0].source,'npm');
  assert.equal(fixture.reads.some(p=>p.endsWith('.cmd')),false);
  assert.equal(fixture.reads.some(p=>p.toLowerCase().includes('\\.codex\\')),false);
});

test('Windows nested optional package and legacy vendor layout are supported',async()=>{
  const root='C:\\npm\\node_modules\\@openai\\codex';
  const nested=path.win32.join(root,'node_modules','@openai','codex-win32-arm64','vendor','aarch64-pc-windows-msvc','bin','codex.exe');
  const legacy=path.win32.join(root,'vendor','aarch64-pc-windows-msvc','codex','codex.exe');
  const fixture=windowsFs([nested,legacy]);
  const result=await findCodex({platform:'win32',arch:'arm64',env:{PATH:'C:\\npm'},home:'C:\\User',fs:fixture.fs});
  assert.deepEqual(new Set(result.candidates.map(c=>c.path)),new Set([nested,legacy]));
});

test('Windows desktop GUI excluded, bundled CLI and VS Code candidates labelled',async()=>{
  const local='C:\\Users\\Player\\AppData\\Local';
  const desktop=path.win32.join(local,'Programs','Codex');
  const cli=path.win32.join(desktop,'resources','codex.exe');
  const extensionRoot='C:\\Users\\Player\\.vscode\\extensions';
  const extension='openai.chatgpt-1.0.0-win32-x64';
  const vscode=path.win32.join(extensionRoot,extension,'bin','win32-x64','codex.exe');
  const fixture=windowsFs([path.win32.join(desktop,'Codex.exe'),cli,vscode],{[extensionRoot]:[extension,'other.extension-1.0.0','../outside']});
  const result=await findCodex({platform:'win32',arch:'x64',env:{PATH:desktop,LOCALAPPDATA:local},home:'C:\\Users\\Player',fs:fixture.fs});
  assert.deepEqual(result.candidates.map(c=>c.path),[cli,vscode]);
  assert.deepEqual(result.candidates.map(c=>c.source),['desktop','vscode']);
});

test('search rejects relative PATH entries and bounds directory enumeration',async()=>{
  const local='C:\\Local'; const root=path.win32.join(local,'OpenAI','Codex','bin');
  const entries=Array.from({length:300},(_,i)=>String(i));
  const fixture=windowsFs([],{[root]:entries});
  const result=await findCodex({platform:'win32',arch:'x64',env:{PATH:'relative;;.;C:\\safe',LOCALAPPDATA:local},home:'C:\\User',fs:fixture.fs});
  assert.equal(result.incomplete,true);assert.equal(result.candidates.length,0);
  assert.ok(result.hints.some(h=>h.includes('No Codex executable')));
  assert.ok(fixture.reads.every(p=>path.win32.isAbsolute(p)));
  assert.ok(fixture.reads.filter(p=>p.startsWith(root)&&p.endsWith('codex.exe')).length<=13);
});

test('permission errors are reported as incomplete rather than empty authoritative result',async()=>{
  const fixture=windowsFs([]);fixture.fs.stat=async()=>{throw Object.assign(new Error('private details'),{code:'EACCES'});};
  const result=await findCodex({platform:'win32',env:{PATH:'C:\\blocked'},home:'C:\\User',fs:fixture.fs});
  assert.equal(result.incomplete,true);assert.equal(result.candidates.length,0);
  assert.equal(JSON.stringify(result).includes('private details'),false);
});

test('Unix npm symlink resolves native executable instead of JS launcher',async()=>{
  const root='/installation';
  const bin=root+'/bin',pkg=root+'/lib/node_modules/@openai/codex';
  const native=pkg+'/vendor/x86_64-unknown-linux-musl/bin/codex';
  const launcher=pkg+'/bin/codex.js';
  const files=new Set([bin+'/codex',launcher,native]);
  const missing=()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});};
  const fake={stat:async p=>files.has(p)?{isFile:()=>true}:missing(),realpath:async p=>p===bin+'/codex'?launcher:p,access:async()=>{},readdir:async()=>[]};
  const result=await findCodex({platform:'linux',arch:'x64',env:{PATH:bin},home:root,fs:fake});
  assert.deepEqual(result.candidates.map(c=>c.path),[native]);
});

test('Windows automatic discovery rejects UNC and device namespaces before filesystem calls',async()=>{
  const blocked = [
    String.raw`\\server\share`, String.raw`\\?\C:\Codex`, String.raw`\\.\C:\Codex`,
    '//server/share', '//?/C:/Codex', '//./C:/Codex', String.raw`\root-relative`,
  ];
  const reads=[];
  const fail=async file=>{reads.push(file);throw new Error('Unexpected filesystem access');};
  const result=await findCodex({platform:'win32',arch:'x64',env:{PATH:blocked.join(';'),APPDATA:blocked[0],LOCALAPPDATA:blocked[1],ProgramFiles:blocked[2]},home:blocked[0],fs:{stat:fail,readdir:fail,realpath:fail,access:fail}});
  assert.deepEqual(reads,[]);assert.deepEqual(result.candidates,[]);
});
