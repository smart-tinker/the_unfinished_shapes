import { toolResult } from './codex.mjs';

// shortcut: cap scene context at 64 objects and 32 players; raise if model requests need a larger view within context limits.
const MAX_SCENE_OBJECTS = 64, MAX_SCENE_PLAYERS = 32;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
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
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(String(worldConnectionId||'')))throw new Error('World connection is invalid.');
  if(!exactKeys(view,['revision','selectedIds','camera'])||!Number.isSafeInteger(view.revision)||view.revision!==state.revision||
      !Array.isArray(view.selectedIds)||view.selectedIds.length>32||!view.selectedIds.every(validId)||new Set(view.selectedIds).size!==view.selectedIds.length)throw new Error('Scene revision or selected IDs are invalid; refresh the world before sending.');
  const camera=cameraView(view.camera),objectIds=new Set();
  const objects=state.objects.map(object=>{
    if(!record(object)||!validId(object.id)||objectIds.has(object.id)||typeof object.type!=='string'||object.type.length>64||
        !validId(object.ownerId)||typeof object.color!=='string'||!/^#[a-f0-9]{6}$/i.test(object.color)||
        typeof object.blocksMovement!=='boolean'||typeof object.supportsPlayer!=='boolean')throw new Error('World state contains an invalid object.');
    objectIds.add(object.id);
    return {id:object.id,type:object.type,ownerId:object.ownerId,color:object.color,position:vector(object.position,1000),size:vector(object.size,50,0.25),blocksMovement:object.blocksMovement,supportsPlayer:object.supportsPlayer};
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
  return {worldConnectionId,revision:state.revision,selectedIds:[...view.selectedIds],camera,objects:included,totalObjectCount:objects.length,
    includedObjectCount:included.length,objectsTruncated:candidates.length>MAX_SCENE_OBJECTS,players:players.slice(0,MAX_SCENE_PLAYERS),
    totalPlayerCount:players.length,includedPlayerCount:Math.min(players.length,MAX_SCENE_PLAYERS),playersTruncated:players.length>MAX_SCENE_PLAYERS};
}

export async function executeGameTool(event,{url,token,connectionId}) {
  if(!['world_state','world_build','world_command'].includes(event.name))return toolResult(false,{error:'Unknown game tool'});
  const isRead=event.name==='world_state';
  let command=event.arguments?.command;
  if(event.name==='world_build'){
    const design=event.arguments,fields=['objectType','position','size','color'];
    if(!design||typeof design!=='object'||Array.isArray(design)||fields.some(key=>!Object.hasOwn(design,key)||design[key]===undefined||design[key]===null)||Object.keys(design).some(key=>!fields.includes(key)))return toolResult(false,{error:'world_build requires exactly objectType, position, size and color. Supply every requested design field explicitly.'});
    command={type:'build',...design};
  }
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
