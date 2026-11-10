import { randomUUID } from 'node:crypto';
import { toolResult } from './codex.mjs';
import { SHAPE_TYPES, SHAPE_DIRECTIONS, shapeDimensionsValid } from './movement.mjs';

// shortcut: cap scene context at 64 objects and 32 players; raise if model requests need a larger view within context limits.
const MAX_SCENE_OBJECTS = 64, MAX_SCENE_PLAYERS = 32;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const validLandmarkLabel = (value,max,multiline=false) => typeof value==='string'&&value.trim().length>0&&[...value].length<=max&&!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)&&(multiline||!/[\r\n]/.test(value));
const inRange=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
function vector(value, limit, minimum = -limit) {
  if (!exactKeys(value, ['x','y','z']) || !['x','y','z'].every(key => Number.isFinite(value[key]) && value[key] >= minimum && value[key] <= limit)) throw new Error('Scene context contains an invalid vector.');
  return { x:value.x, y:value.y, z:value.z };
}
function cameraView(value) {
  if (!exactKeys(value, ['position','target','fov','aspect','near','far','viewport'])) throw new Error('Scene context camera is invalid.');
  const viewport = value.viewport;
  let position, target;
  try { position = vector(value.position, 10000); target = vector(value.target, 10000); }
  catch { throw new Error('Scene context camera vectors must be finite and bounded.'); }
  if (!exactKeys(viewport, ['width','height']) || !Number.isSafeInteger(viewport.width) || viewport.width < 1 || viewport.width > 16384 ||
      !Number.isSafeInteger(viewport.height) || viewport.height < 1 || viewport.height > 16384 ||
      !Number.isFinite(value.fov) || value.fov <= 1 || value.fov >= 179 ||
      !Number.isFinite(value.aspect) || value.aspect < 0.01 || value.aspect > 100 ||
      !Number.isFinite(value.near) || value.near <= 0 ||
      !Number.isFinite(value.far) || value.far <= value.near || value.far > 10000 ||
      Math.hypot(target.x-position.x,target.y-position.y,target.z-position.z) < 1e-6) throw new Error('Scene context camera is invalid.');
  return {position,target,fov:value.fov,aspect:value.aspect,near:value.near,far:value.far,viewport:{...viewport}};
}
// shortcut: use object bounding spheres for frustum inclusion; replace if viewport-edge selections are visibly inaccurate.
function inCameraView(object, camera) {
  const dx=camera.target.x-camera.position.x,dy=camera.target.y-camera.position.y,dz=camera.target.z-camera.position.z;
  const length=Math.hypot(dx,dy,dz),forward={x:dx/length,y:dy/length,z:dz/length};
  const reference=Math.abs(forward.y)>0.999?{x:0,y:0,z:1}:{x:0,y:1,z:0};
  let right={x:forward.y*reference.z-forward.z*reference.y,y:forward.z*reference.x-forward.x*reference.z,z:forward.x*reference.y-forward.y*reference.x};
  const rightLength=Math.hypot(right.x,right.y,right.z);
  right={x:right.x/rightLength,y:right.y/rightLength,z:right.z/rightLength};
  const up={x:right.y*forward.z-right.z*forward.y,y:right.z*forward.x-right.x*forward.z,z:right.x*forward.y-right.y*forward.x};
  const relative={x:object.position.x-camera.position.x,y:object.position.y-camera.position.y,z:object.position.z-camera.position.z};
  const depth=relative.x*forward.x+relative.y*forward.y+relative.z*forward.z;
  const horizontal=relative.x*right.x+relative.y*right.y+relative.z*right.z;
  const vertical=relative.x*up.x+relative.y*up.y+relative.z*up.z;
  const radius=Math.hypot(object.size.x,object.size.y,object.size.z)/2,visibleDepth=Math.max(0,depth);
  const halfHeight=visibleDepth*Math.tan(camera.fov*Math.PI/360);
  return depth+radius>=camera.near&&depth-radius<=camera.far&&Math.abs(vertical)<=halfHeight+radius&&Math.abs(horizontal)<=halfHeight*camera.aspect+radius;
}

export function captureSceneSnapshot(state, view, worldConnectionId) {
  if(!record(state)||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.objects)||state.objects.length>5000||!Array.isArray(state.players)||state.players.length>1000)throw new Error('World state is invalid.');
  const lighting=Object.hasOwn(state,'lighting')?state.lighting:{version:0,ambientIntensity:2.6,sunIntensity:3.1};
  if(!exactKeys(lighting,['version','ambientIntensity','sunIntensity'])||!Number.isSafeInteger(lighting.version)||lighting.version<0||!inRange(lighting.ambientIntensity,0,4)||!inRange(lighting.sunIntensity,0,5))throw new Error('World state contains invalid lighting.');
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(String(worldConnectionId||'')))throw new Error('World connection is invalid.');
  if(!exactKeys(view,['revision','selectedIds','camera'])||!Number.isSafeInteger(view.revision)||view.revision!==state.revision||
      !Array.isArray(view.selectedIds)||view.selectedIds.length>32||!view.selectedIds.every(validId)||new Set(view.selectedIds).size!==view.selectedIds.length)throw new Error('Scene revision or selected IDs are invalid; refresh the world before sending.');
  const camera=cameraView(view.camera),objectIds=new Set();
  const objects=state.objects.map(object=>{
    if(!record(object)||!validId(object.id)||objectIds.has(object.id)||typeof object.type!=='string'||object.type.length>64||
        !validId(object.ownerId)||typeof object.color!=='string'||!/^#[a-f0-9]{6}$/i.test(object.color)||
        typeof object.blocksMovement!=='boolean'||typeof object.supportsPlayer!=='boolean')throw new Error('World state contains an invalid object.');
    objectIds.add(object.id);
    if((object.type==='sign'&&!validLandmarkLabel(object.text,240,true))||(object.type==='beacon'&&!validLandmarkLabel(object.name,48)))throw new Error('World state contains an invalid landmark label.');
    const oriented=SHAPE_TYPES.includes(object.type),doorOrGate=['door','gate'].includes(object.type),lamp=object.type==='lamp',interactive=doorOrGate||object.type==='button'||lamp;
    if(oriented&&!SHAPE_DIRECTIONS.includes(object.direction))throw new Error('World state contains an invalid shape direction.');
    if(interactive&&(!Number.isSafeInteger(object.version)||object.version<0||!['owner_admin','all_players'].includes(object.usePolicy)))throw new Error('World state contains an invalid interactive object version or access policy.');
     if(lamp&&(typeof object.on!=='boolean'||!inRange(object.intensity,.25,4)||!inRange(object.range,2,16)||object.blocksMovement||object.supportsPlayer))throw new Error('World state contains invalid lamp lighting or physics.');
    if(doorOrGate&&!['open','closed'].includes(object.state))throw new Error('World state contains an invalid door or gate state.');
    if(object.type==='button'&&((object.targetId!==null&&(typeof object.targetId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(object.targetId)))||!['open','closed'].includes(object.targetState)))throw new Error('World state contains an invalid button target or state.');
    return {id:object.id,type:object.type,ownerId:object.ownerId,color:object.color,position:vector(object.position,1000),size:vector(object.size,50,0.25),blocksMovement:object.blocksMovement,supportsPlayer:object.supportsPlayer,...(oriented?{direction:object.direction}:{}),...(doorOrGate?{state:object.state}:{}),...(lamp?{on:object.on,intensity:object.intensity,range:object.range}:{}),...(interactive?{usePolicy:object.usePolicy,version:object.version}:{}),...(object.type==='button'?{targetId:object.targetId,targetState:object.targetState}:{}),...(object.type==='sign'?{text:object.text}:{}),...(object.type==='beacon'?{name:object.name}:{})};
  });
  const selectedSet=new Set(view.selectedIds);
  if(view.selectedIds.some(id=>!objectIds.has(id)))throw new Error('A selected object no longer exists; refresh the world before sending.');
  const selected=view.selectedIds.map(id=>objects.find(object=>object.id===id));
  const visible=objects.filter(object=>inCameraView(object,camera));
  const candidates=[...selected,...visible.filter(object=>!selectedSet.has(object.id))];
  const included=candidates.slice(0,MAX_SCENE_OBJECTS).map(object=>({...object,selected:selectedSet.has(object.id),inCameraView:inCameraView(object,camera)}));
  const online=Array.isArray(state.onlinePlayerIds)?new Set(state.onlinePlayerIds):null;
  const playerIds=new Set();
  const players=state.players.filter(player=>!online||online.has(player.id)).map(player=>{
    if(!record(player)||!validId(player.id)||playerIds.has(player.id))throw new Error('World state contains an invalid player.');
    playerIds.add(player.id);
    const result={id:player.id,position:vector(player.position,1000),isSelf:player.id===state.me?.id};
    if(player.velocityY!==undefined){if(!Number.isFinite(player.velocityY)||Math.abs(player.velocityY)>20)throw new Error('World state contains invalid player movement.');result.velocityY=player.velocityY;}
    return result;
  });
  const selfIndex=players.findIndex(player=>player.isSelf);
  if(selfIndex>0)players.unshift(players.splice(selfIndex,1)[0]);
  return {worldConnectionId,revision:state.revision,lighting:{...lighting},selectedIds:[...view.selectedIds],camera,objects:included,totalObjectCount:objects.length,
    includedObjectCount:included.length,objectsTruncated:candidates.length>MAX_SCENE_OBJECTS,players:players.slice(0,MAX_SCENE_PLAYERS),
    totalPlayerCount:players.length,includedPlayerCount:Math.min(players.length,MAX_SCENE_PLAYERS),playersTruncated:players.length>MAX_SCENE_PLAYERS};
}

const BUILD_TYPES = ['block','bridge','port','sign','beacon','door','gate','button','lamp',...SHAPE_TYPES];
function buildDesign(value) {
  if (!record(value)) throw new Error('Invalid object design.');
  const directional = SHAPE_TYPES.includes(value.objectType), labelField=value.objectType==='sign'?'text':value.objectType==='beacon'?'name':null;
  const keys=['objectType','position','size','color',...(directional?['direction']:[]),...(labelField?[labelField]:[])];
  if (!exactKeys(value, keys) || !BUILD_TYPES.includes(value.objectType) || !exactKeys(value.position,['x','y','z']) || !exactKeys(value.size,['x','y','z']) ||
      !['x','y','z'].every(key => Number.isFinite(value.position[key]) && Math.abs(value.position[key]) <= 1000 && Number.isFinite(value.size[key]) && value.size[key] >= .25 && value.size[key] <= 50) ||
      typeof value.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(value.color) ||
      (directional && (!SHAPE_DIRECTIONS.includes(value.direction) || !shapeDimensionsValid(value.objectType,value.direction,value.size))) ||
      (labelField && !validLandmarkLabel(value[labelField],labelField==='text'?240:48,labelField==='text'))) throw new Error('Object design is invalid.');
  return structuredClone(value);
}
async function sendWorldCommand(command, connection) {
  try {
    const response=await fetch(connection.url+'/command',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(5000),redirect:'error'});
    const value=await response.json(); return toolResult(response.ok,value);
  } catch(error) { return toolResult(false,{error:error.message}); }
}
export function createGameToolSession(connection) {
  let pending = null;
  return {
    clear() { pending = null; },
    decide(previewId, decision, threadId) {
      if (typeof previewId !== 'string' || typeof threadId !== 'string' || !pending || pending.previewId !== previewId || pending.threadId !== threadId || pending.attempted) throw new Error('Build preview is no longer available for this conversation.');
      if (decision === 'cancel') { pending = null; return {cancelled:true}; }
      if (decision !== 'apply' || pending.approved) throw new Error('Build preview decision is invalid or already used.');
      pending.approved = true; return {approved:true};
    },
    async execute(event) {
      if (event.name === 'world_preview') {
        if (typeof event.threadId !== 'string' || !exactKeys(event.arguments,['objects']) || !Array.isArray(event.arguments.objects) || event.arguments.objects.length < 1 || event.arguments.objects.length > 32) return toolResult(false,{error:'world_preview requires 1–32 explicit object designs.'});
        try {
          const objects=event.arguments.objects.map(buildDesign), previewId=randomUUID();
          pending={previewId,threadId:event.threadId,objects,approved:false,attempted:false};
          return toolResult(true,{previewId,objects});
        } catch(error) { return toolResult(false,{error:error.message}); }
      }
      if (event.name === 'world_apply') {
        if (!exactKeys(event.arguments,['previewId']) || typeof event.arguments.previewId !== 'string') return toolResult(false,{error:'world_apply requires exactly one previewId.'});
        if (!pending || pending.previewId !== event.arguments.previewId || pending.threadId !== event.threadId) return toolResult(false,{error:'Build preview is missing or belongs to another conversation.'});
        if (!pending.approved) return toolResult(false,{error:'The player must explicitly approve this full preview in the game before Apply.'});
        if (pending.attempted) return toolResult(false,{error:'This approved preview was already attempted; inspect the world before making another proposal.'});
        const current=pending; current.attempted=true;
        try { return await sendWorldCommand({type:'build_group',objects:current.objects},connection); }
        finally { if (pending===current) pending=null; }
      }
      return executeGameTool(event,connection);
    },
  };
}
export async function executeGameTool(event,{url,token,connectionId}) {
  if(!['world_state','world_command'].includes(event.name))return toolResult(false,{error:'Unknown game tool'});
  const isRead=event.name==='world_state';
  const command=event.arguments?.command;
  if(!isRead&&command?.type==='set_lighting')return toolResult(false,{error:'World lighting changes must use the in-game local preview and explicit Apply.'});
  if(!isRead&&['build','build_group'].includes(command?.type))return toolResult(false,{error:'Agent construction must use world_preview, wait for the player to approve it, then call world_apply.'});
  // Flat tool schemas cannot express conditional requirements; never drop edit guards.
  if(!isRead&&command?.type==='update'&&(!command.expected||typeof command.expected!=='object'||Array.isArray(command.expected)||!Object.keys(command.expected).length))return toolResult(false,{error:'Update requires expected original values from world_state for the edited fields. Refresh before editing.'});
  try{
    const response=await fetch(url+(isRead?'/state':'/command'),{method:isRead?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:isRead?undefined:JSON.stringify(command),signal:AbortSignal.timeout(5000),redirect:'error'});
    const value=await response.json();
    if(!response.ok||!isRead)return toolResult(response.ok,value);
    const online=Array.isArray(value.onlinePlayerIds)?new Set(value.onlinePlayerIds):null;
    return toolResult(true,{...value,...(online?{players:value.players.filter(player=>online.has(player.id))}:{}),worldConnectionId:connectionId});
  }catch(error){return toolResult(false,{error:error.message});}
}
