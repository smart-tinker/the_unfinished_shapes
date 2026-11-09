// Retain protocol metadata only: never model prompts, reasoning, deltas or headers.
export function createModelDiagnostics(now=Date.now) {
 const started=now();
 const state={requests:[],logTimings:[]};
 function request() {
  const item={startedMs:now()-started,requestBytes:0,responseBytes:0,status:null,eventCounts:{},itemTypes:{},firstByteMs:null,lastEventMs:null};
  if(state.requests.length<8)state.requests.push(item);
  let pending='';
  function event(block) {
   const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
   if(!data || data==='[DONE]')return;
   let value;try{value=JSON.parse(data);}catch{return;}
   const type=value.type;
   if(typeof type!=='string' || !/^response\.[a-z_.]+$/.test(type) || type.length>80)return;
   if(Object.keys(item.eventCounts).length<40 || type in item.eventCounts)item.eventCounts[type]=(item.eventCounts[type]||0)+1;
   item.lastEventMs=now()-started;
   const itemType=value.item?.type;
   if(['message','function_call','reasoning'].includes(itemType))item.itemTypes[itemType]=(item.itemTypes[itemType]||0)+1;
   const usage=value.response?.usage;
   if(usage) item.usage=Object.fromEntries(['input_tokens','output_tokens','total_tokens'].filter(key=>Number.isFinite(usage[key])).map(key=>[key,usage[key]]));
  }
  return {
   input(chunk){item.requestBytes+=Buffer.byteLength(chunk);},
   status(code){item.status=code;},
   data(chunk){
    item.responseBytes+=Buffer.byteLength(chunk);item.firstByteMs??=now()-started;
    pending+=String(chunk).replace(/\r\n/g,'\n');
    let boundary;while((boundary=pending.indexOf('\n\n'))!==-1){event(pending.slice(0,boundary));pending=pending.slice(boundary+2);}
    if(pending.length>262144){pending='';item.oversizedEventDiscarded=true;}
   },
   end(){if(pending)event(pending);pending='';item.endedMs=now()-started;},
   error(){item.transportError=true;},
  };
 }
 function logLine(line) {
  const match=line.match(/\b(prompt eval time|eval time|total time)\s*=\s*([\d.]+)\s*ms(?:\s*\/\s*(\d+)\s*tokens)?/);
  if(match && state.logTimings.length<20)state.logTimings.push({kind:match[1],milliseconds:Number(match[2]),...(match[3]?{tokens:Number(match[3])}:{})});
 }
 return {request,logLine,result:()=>structuredClone(state)};
}
