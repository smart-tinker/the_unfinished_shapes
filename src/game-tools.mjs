import { toolResult } from './codex.mjs';
export async function executeGameTool(event,{url,token}) {
  if(!['world_state','world_command'].includes(event.name)) return toolResult(false,{error:'Unknown game tool'});
  const isRead=event.name==='world_state';
  const command=event.arguments?.command;
  // Flat tool schemas cannot express conditional requirements; never drop edit guards.
  if(!isRead && command?.type==='update' && (!command.expected || typeof command.expected!=='object' || Array.isArray(command.expected) || !Object.keys(command.expected).length)) return toolResult(false,{error:'Update requires expected original values from world_state for the edited fields. Refresh before editing.'});
  try {
    const response=await fetch(url+(isRead?'/state':'/command'),{method:isRead?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:isRead?undefined:JSON.stringify(event.arguments?.command),signal:AbortSignal.timeout(5000),redirect:'error'});
    return toolResult(response.ok,await response.json());
  } catch(error) { return toolResult(false,{error:error.message}); }
}
