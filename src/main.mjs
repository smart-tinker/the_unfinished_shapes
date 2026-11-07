import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CodexBridge } from './codex.mjs';
import { executeGameTool } from './game-tools.mjs';
import { createWorldServer } from './server.mjs';
if(process.env.TUS_DATA_DIR) app.setPath('userData',path.resolve(process.env.TUS_DATA_DIR));
const here = path.dirname(fileURLToPath(import.meta.url));
let win, bridge, localServer, connectedWorld;
if (!app.requestSingleInstanceLock()) app.quit();
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
async function settings() { try { return JSON.parse(await readFile(settingsPath(), 'utf8')); } catch(e) { if(e.code === 'ENOENT') return {}; throw e; } }
function assertSender(event) { if(event.sender !== win.webContents) throw new Error('Untrusted sender'); }
function handle(name, fn) { ipcMain.handle(name, (event,...args) => { assertSender(event); return fn(...args); }); }
function serverUrl(value) { const u = new URL(value); if(!['http:','https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Use an HTTP(S) server origin without credentials or paths'); return u.origin; }
app.whenReady().then(async()=>{
  await mkdir(app.getPath('userData'), {recursive:true});
  const saved = await settings();
  // A fresh local token is session-only and never enables LAN access.
  const localToken = randomBytes(32).toString('hex');
  localServer = await createWorldServer({dataPath:path.join(app.getPath('userData'),'world.json'),users:{[localToken]:{id:'local-player',role:'admin'}},host:'127.0.0.1',port:4317});
  await new Promise((resolve,reject)=>localServer.once('error',reject).listen(0,'127.0.0.1',resolve));
  const localUrl = `http://127.0.0.1:${localServer.address().port}`;
  handle('settings:load', async()=>({...await settings(),serverUrl:saved.serverUrl || localUrl,token:!saved.serverUrl ? localToken : ''}));
  handle('settings:save', async(s)=>{ const clean={workspacePath:String(s.workspacePath||''),codexPath:String(s.codexPath||''),serverUrl:serverUrl(s.serverUrl||localUrl) === localUrl ? '' : serverUrl(s.serverUrl),threadId:String(s.threadId||'')}; await writeFile(settingsPath(),JSON.stringify(clean,null,2),{mode:0o600}); });
  handle('world:request', async({serverUrl:url,token,method='GET',path:route,body})=>{
    if(!['/state','/command'].includes(route)|| !['GET','POST'].includes(method)) throw new Error('Unsupported world request');
    const response=await fetch(serverUrl(url)+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000),redirect:'error'});
    const result=await response.json(); if(!response.ok) throw new Error(result.message||result.error||`HTTP ${response.status}`); return result;
  });
  handle('codex:disconnect',async()=>{await bridge?.stop(); bridge=null; connectedWorld=null;});
  handle('codex:connect',async(s)=>{
    if(bridge) await bridge.stop();
    connectedWorld={url:serverUrl(s.serverUrl),token:String(s.token||'')};
    bridge=new CodexBridge();
    const currentBridge = bridge;
    const world = {...connectedWorld};
    bridge.on('event',async event=>{
      if(event.type !== 'tool') { win?.webContents.send('codex:event',event); return; }
      const result = await executeGameTool(event,world);
      try { currentBridge.respond(event.id,result); } catch { /* Turn may have been interrupted. */ }
    });
    bridge.on('error',error=>win?.webContents.send('codex:event',{type:'error',message:error.message}));
    const result=await bridge.start({codexPath:s.codexPath,workspacePath:s.workspacePath,threadId:s.threadId||undefined,newGameThread:!!s.newGameThread});
    return result;
  });
  handle('codex:send',async text=>{if(!bridge) throw new Error('Connect Codex first');if(typeof text !== 'string'||text.length>32000)throw new Error('Prompt too long');const guide = `You are the player's companion in The Unfinished Shapes. Act only on this request. Use world_state to inspect the world and world_command for existing mechanics. The server enforces permissions. For a missing mechanic explain/specify and implement code in this workspace with tests; never deploy, merge, modify CI permissions or bypass review. Do not assume a source change is deployed. Answer in the player's language.\n\nPlayer request: `; return bridge.send(guide+text);});
  handle('codex:interrupt',()=>bridge?.interrupt());
  handle('codex:respond',(id,result)=>bridge?.respond(id,result));
  win=new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:700,backgroundColor:'#131c24',webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event)=>event.preventDefault());
  await win.loadFile(path.join(here,'index.html'));
}).catch(error=>{console.error(error.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{bridge?.stop();localServer?.close();});
