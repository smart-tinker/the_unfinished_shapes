import {_electron as electron} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,access,realpath} from 'node:fs/promises';
import os from 'node:os';
import {observeGraphics} from './graphics-smoke.mjs';
import path from 'node:path';
const dir=await mkdtemp(path.join(os.tmpdir(),'tus-desktop-'));
const fakeBin=path.join(dir,'bin'),fakeCodex=path.join(fakeBin,'codex'),marker=path.join(dir,'unexpected-codex-run');
await mkdir(fakeBin);await writeFile(fakeCodex,`#!/bin/sh\ntouch '${marker}'\nexit 99\n`,{mode:0o755});
const expectedCodexPath=await realpath(fakeCodex);
const testEnv={...process.env,TUS_DATA_DIR:dir,PATH:fakeBin+path.delimiter+process.env.PATH};
const packagedExecutable=process.env.TUS_SMOKE_EXECUTABLE;
// Preserve the existing Linux CI exception only; native macOS uses its normal sandbox.
const ciFlags=process.platform==='linux'?['--no-sandbox']:[];
const launchOptions={...(packagedExecutable?{executablePath:path.resolve(packagedExecutable)}:{}),args:[...(packagedExecutable?[]:['.']),...ciFlags],env:testEnv,timeout:30000};
let app, graphics;
async function close() {
 const closing=app, observed=graphics;app=null;graphics=null;
 if(!closing) return;
 try {await observed?.assertHealthy();} finally {await closing.close();}
 observed?.assertNoErrors();
}
try {
 app=await electron.launch(launchOptions);
 if(process.platform==='darwin') assert.equal(await app.evaluate(()=>process.argv.includes('--no-sandbox')),false,'native macOS must not disable the sandbox');
 const page=await app.firstWindow();graphics=await observeGraphics(page);
 if(process.platform==='darwin') assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox),true,'native macOS renderer sandbox remains enabled');
 await page.waitForFunction(()=>document.querySelector('#connection')?.textContent.includes('World connected'));
 await graphics.assertHealthy();
 await page.locator('[data-kind="bridge"]').click(); await page.locator('#build-x').fill('3');
 await page.locator('#build-form button').click();
 await page.waitForFunction(()=>document.querySelector('#world-message')?.textContent.includes('placed'));
 let state=await page.evaluate(async()=>{const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/state'});});
 assert.equal(state.objects.length,1);assert.equal(state.objects[0].type,'bridge');
 assert.equal(await page.locator('#send').isDisabled(),true);
 await page.locator('#settings-open').click();assert.equal(await page.locator('#settings').isVisible(),true);
 await page.locator('#settings-close').click();assert.equal(await page.locator('#settings').isVisible(),false);
 await page.locator('#settings-open').click();
 await page.locator('#find-codex').click();
 const candidate=page.locator('.codex-candidate').filter({hasText:expectedCodexPath});await candidate.waitFor();await candidate.click();
 assert.equal(await page.locator('#codex').inputValue(),expectedCodexPath);
 await page.locator('#workspace').fill(dir);await page.locator('#save-world').click();
 await page.waitForFunction(()=>document.querySelector('#settings-message')?.textContent.includes('saved'));
 await page.locator('#settings-close').click();
 await page.evaluate(async()=>{const s=await window.tus.loadSettings();await window.tus.saveSettings({...s,threadId:'smoke-preserved-game-thread'});});
 await assert.rejects(access(marker),'search must not execute discovered files');
 await mkdir('dist',{recursive:true});await page.screenshot({path:'dist/desktop-smoke.png'});
 await close();
 app=await electron.launch(launchOptions);
 const reopened=await app.firstWindow();graphics=await observeGraphics(reopened);await reopened.waitForFunction(()=>document.querySelector('#connection')?.textContent.includes('World connected'));
 state=await reopened.evaluate(async()=>{const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/state'});});
 assert.equal(state.objects.length,1,'world survives desktop restart');
 const restored=await reopened.evaluate(()=>window.tus.loadSettings());assert.equal(restored.codexPath,expectedCodexPath);assert.equal(restored.workspacePath,dir);assert.equal(restored.threadId,'smoke-preserved-game-thread');
 // Removal below exercises the authenticated command API, not canvas selection or the Remove button.
 await reopened.evaluate(async id=>{const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/command',method:'POST',body:{type:'remove',id}});},state.objects[0].id);
 const emptied=await reopened.evaluate(async()=>{const s=await window.tus.loadSettings();return window.tus.request({...s,path:'/state'});});assert.equal(emptied.objects.length,0,'API removal is confirmed by authoritative state read');
 await assert.rejects(access(marker),'restart must not execute a discovered candidate');
 await close();console.log(`${packagedExecutable?'Packaged':'Source'} ${process.platform}/${process.arch} Electron smoke`);console.log('Electron smoke passed: WebGL startup, UI construction, settings repeated/cancel, safe Codex discovery/selection, persisted settings/thread ID/world after restart, authenticated API removal, no unsolicited model call. Canvas selection and graphical removal were not tested.');
} finally {try {await close();} finally {await rm(dir,{recursive:true,force:true});}}
