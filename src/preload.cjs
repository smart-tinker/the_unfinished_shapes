const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('tus',Object.freeze({
findCodex:()=>ipcRenderer.invoke('codex:find'),choosePath:kind=>ipcRenderer.invoke('path:choose',kind),loadSettings:()=>ipcRenderer.invoke('settings:load'),saveSettings:s=>ipcRenderer.invoke('settings:save',s),
disconnectCodex:()=>ipcRenderer.invoke('codex:disconnect'),connectCodex:s=>ipcRenderer.invoke('codex:connect',s),sendPrompt:t=>ipcRenderer.invoke('codex:send',t),interrupt:()=>ipcRenderer.invoke('codex:interrupt'),respond:(id,result)=>ipcRenderer.invoke('codex:respond',id,result),
request:r=>ipcRenderer.invoke('world:request',r),onCodexEvent:callback=>{const fn=(_event,data)=>callback(data);ipcRenderer.on('codex:event',fn);return()=>ipcRenderer.removeListener('codex:event',fn);}
}));
