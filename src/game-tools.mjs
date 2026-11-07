import { toolResult } from './codex.mjs';
export async function executeGameTool(event,{url,token}) {
  if(!['world_state','world_command'].includes(event.name)) return toolResult(false,{error:'Unknown game tool'});
  const isRead=event.name==='world_state';
  try {
    const response=await fetch(url+(isRead?'/state':'/command'),{method:isRead?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:isRead?undefined:JSON.stringify(event.arguments?.command),signal:AbortSignal.timeout(5000),redirect:'error'});
    return toolResult(response.ok,await response.json());
  } catch(error) { return toolResult(false,{error:error.message}); }
}
