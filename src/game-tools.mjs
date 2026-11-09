import { toolResult } from './codex.mjs';
export async function executeGameTool(event,{url,token}) {
  if(!['world_state','world_build','world_command'].includes(event.name)) return toolResult(false,{error:'Unknown game tool'});
  const isRead=event.name==='world_state';
  let command=event.arguments?.command;
  if(event.name==='world_build') {
    const design=event.arguments,fields=['objectType','position','size','color'];
    if(!design || typeof design!=='object' || Array.isArray(design) || fields.some(key=>!Object.hasOwn(design,key) || design[key]===undefined || design[key]===null) || Object.keys(design).some(key=>!fields.includes(key))) return toolResult(false,{error:'world_build requires exactly objectType, position, size and color. Supply every requested design field explicitly.'});
    command={type:'build',...design};
  }
  // Flat tool schemas cannot express conditional requirements; never drop edit guards.
  if(!isRead && command?.type==='update' && (!command.expected || typeof command.expected!=='object' || Array.isArray(command.expected) || !Object.keys(command.expected).length)) return toolResult(false,{error:'Update requires expected original values from world_state for the edited fields. Refresh before editing.'});
  try {
    const response=await fetch(url+(isRead?'/state':'/command'),{method:isRead?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:isRead?undefined:JSON.stringify(command),signal:AbortSignal.timeout(5000),redirect:'error'});
    return toolResult(response.ok,await response.json());
  } catch(error) { return toolResult(false,{error:error.message}); }
}
