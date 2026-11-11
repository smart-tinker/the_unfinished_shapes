import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const DATA_DIRECTORY = 'the-unfinished-shapes';
export function settingsFile(userData) { return path.join(userData,'settings.json'); }
function string(value,key) {
  if(value === undefined) return '';
  if(typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error(`Invalid saved ${key}.`);
  return value;
}
export function cleanSettings(value = {}) {
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object.');
  if(value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('These settings were created by a newer, incompatible version. They were not changed.');
  const output={schemaVersion:1};
  if(value.updateChannel!==undefined&&!['stable','prerelease'].includes(value.updateChannel))throw new Error('Invalid saved update channel.');
  output.updateChannel=value.updateChannel??'stable';
  if(value.lightingQuality!==undefined&&!['full','reduced'].includes(value.lightingQuality))throw new Error('Invalid saved lighting quality.');
  output.lightingQuality=value.lightingQuality??'full';
  for(const key of ['workspacePath','codexPath','serverUrl','threadId','agentModelId','agentEffort','agentControlThreadId']) output[key]=string(value[key],key);
  if(output.agentModelId && !output.agentControlThreadId) throw new Error('Agent model preferences must be bound to a Codex conversation.');
  if(output.agentEffort && !output.agentModelId) throw new Error('Agent reasoning effort requires a selected model.');
  if(output.agentControlThreadId && !output.agentModelId) throw new Error('Agent model conversation binding requires a selected model.');
  if(output.serverUrl) {
    const url=new URL(output.serverUrl);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Saved server address must be an HTTP(S) origin without credentials.');
    output.serverUrl=url.origin;
  }
  // Allowlist intentionally excludes world tokens and model-provider credentials.
  return output;
}
export function agentModelForThread(value, threadId) {
  if(!threadId || value.agentControlThreadId !== threadId || !value.agentModelId) return null;
  return { model: value.agentModelId, ...(value.agentEffort ? { effort: value.agentEffort } : {}) };
}
export async function loadSettings(userData) {
  try {return cleanSettings(JSON.parse(await readFile(settingsFile(userData),'utf8')));}
  catch(error) {if(error.code === 'ENOENT') return cleanSettings();throw error;}
}
export async function saveSettings(userData,value) {
  const data=cleanSettings(value);
  await mkdir(userData,{recursive:true});
  const destination=settingsFile(userData),temporary=`${destination}.${randomUUID()}.tmp`;
  try {await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,destination);}
  catch(error) {await unlink(temporary).catch(()=>{});throw error;}
  return data;
}
