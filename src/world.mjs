import { randomUUID } from 'node:crypto';
import { movePlayer, playerOccupiesObject, SHAPE_TYPES, SHAPE_DIRECTIONS, SHAPE_DEFAULT_SIZES, shapeDimensionsValid } from './movement.mjs';

export const mechanics = ['block', 'bridge', 'port', 'sign', 'beacon', 'door', 'gate', 'button', ...SHAPE_TYPES];
const physicsDefaults = Object.fromEntries(mechanics.map(type => [type, { blocksMovement: !['sign','beacon','button'].includes(type), supportsPlayer: !['sign','beacon','button','door','gate'].includes(type) }]));
const usePolicies = ['owner_admin','all_players'];
function canUse(actor, object) { return actor.role === 'admin' || object.ownerId === actor.id || object.usePolicy === 'all_players'; }
function requireUseRange(state, actor, object) {
  const position = state.players.find(player => player.id === actor.id)?.position ?? {x:0,y:0,z:0};
  if (Math.hypot(position.x-object.position.x,position.y-object.position.y,position.z-object.position.z) > 3 + 1e-7) fail('out_of_range','Move within 3 world units to use this object.',403);
}
function passageOccupied(state, object, context) {
  const online = new Set(Array.isArray(context?.onlinePlayerIds) ? context.onlinePlayerIds : []);
  const players = new Map(state.players.filter(player => online.has(player.id)).map(player => [player.id,player]));
  for (const id of online) if (!players.has(id)) players.set(id,{id,position:{x:0,y:0,z:0}});
  return [...players.values()].some(player => playerOccupiesObject(player,object));
}
export class WorldError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new WorldError(code, message, status); }
export function vector(value, size = false) {
  if (!value || typeof value !== 'object' || !['x','y','z'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && (size ? value[k] >= 0.25 && value[k] <= 50 : Math.abs(value[k]) <= 1000))) fail('invalid_coordinates', size ? 'Size components must be 0.25–50.' : 'Coordinates must be finite and within ±1000.');
  return { x:value.x, y:value.y, z:value.z };
}
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function emptyWorld() { return { version: 1, revision: 0, objects: [], players: [] }; }
function validLandmarkLabel(value, max, multiline = false) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) && (multiline || !/[\r\n]/.test(value));
}
export function validateWorld(state) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.objects) || state.objects.length > 5000 || !Array.isArray(state.players) || state.players.length > 1000) fail('invalid_state', 'Invalid saved world. Refusing to overwrite it.', 500);
  state = structuredClone(state);
  const ids = new Set();
  for (const o of state.objects) {
    if (!o || typeof o.id !== 'string' || ids.has(o.id) || !mechanics.includes(o.type) || typeof o.ownerId !== 'string' || !/^#[a-f0-9]{6}$/i.test(o.color)) fail('invalid_state', 'Invalid saved object.', 500);
    ids.add(o.id); vector(o.position); vector(o.size, true);
    if (SHAPE_TYPES.includes(o.type) ? (!SHAPE_DIRECTIONS.includes(o.direction) || !shapeDimensionsValid(o.type,o.direction,o.size)) : Object.hasOwn(o,'direction')) fail('invalid_state', 'Invalid saved shape direction or dimensions.', 500);
    if ((o.type === 'sign' && !validLandmarkLabel(o.text,240,true)) || (o.type === 'beacon' && !validLandmarkLabel(o.name,48))) fail('invalid_state','Invalid saved landmark label.',500);
    if (['door','gate'].includes(o.type)) {
      if (!Object.hasOwn(o,'state')) o.state = 'closed';
      if (!['open','closed'].includes(o.state)) fail('invalid_state','Invalid saved door state.',500);
      if (!Object.hasOwn(o,'version')) o.version = 0;
      if (!Number.isSafeInteger(o.version) || o.version < 0) fail('invalid_state','Invalid saved object version.',500);
      if (!Object.hasOwn(o,'usePolicy')) o.usePolicy = 'owner_admin';
      if (!['owner_admin','all_players'].includes(o.usePolicy)) fail('invalid_state','Invalid saved use policy.',500);
    }
    if (o.type === 'button') {
      if (!Object.hasOwn(o,'targetId')) o.targetId = null;
      if (o.targetId !== null && (typeof o.targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(o.targetId))) fail('invalid_state','Invalid saved button target.',500);
      if (!Object.hasOwn(o,'targetState')) o.targetState = 'open';
      if (!['open','closed'].includes(o.targetState)) fail('invalid_state','Invalid saved button target state.',500);
      if (!Object.hasOwn(o,'version')) o.version = 0;
      if (!Number.isSafeInteger(o.version) || o.version < 0) fail('invalid_state','Invalid saved object version.',500);
      if (!Object.hasOwn(o,'usePolicy')) o.usePolicy = 'owner_admin';
      if (!['owner_admin','all_players'].includes(o.usePolicy)) fail('invalid_state','Invalid saved use policy.',500);
    }
    for (const [key, value] of Object.entries(physicsDefaults[o.type])) {
      if (!Object.hasOwn(o, key)) o[key] = ['door','gate'].includes(o.type) && key === 'blocksMovement' ? o.state !== 'open' : value;
      else if (typeof o[key] !== 'boolean') fail('invalid_state', 'Invalid saved object physics.', 500);
    }
    if ((o.type === 'door' || o.type === 'gate') && (o.blocksMovement !== (o.state === 'closed') || o.supportsPlayer)) fail('invalid_state','Door collision must match its saved state.',500);
    if (o.type === 'button' && (o.blocksMovement || o.supportsPlayer)) fail('invalid_state','Buttons cannot block or support player movement.',500);
  }
  const players = new Set();
  for (const p of state.players) {
    if (!p || typeof p.id !== 'string' || players.has(p.id)) fail('invalid_state', 'Invalid saved player.', 500);
    players.add(p.id); vector(p.position);
    if (!Object.hasOwn(p, 'velocityY')) { p.position.y = 0; p.velocityY = 0; }
    else if (typeof p.velocityY !== 'number' || !Number.isFinite(p.velocityY) || Math.abs(p.velocityY) > 20) fail('invalid_state', 'Invalid saved player movement.', 500);
  }
  return state;
}
function buildObject(actor, command, defaultsAllowed = true) {
  if (!mechanics.includes(command.objectType)) fail('new_mechanic_required','This mechanic is not implemented. Develop it in the repository and pass CI before deployment.',409);
  const directional = SHAPE_TYPES.includes(command.objectType);
  if (directional ? !SHAPE_DIRECTIONS.includes(command.direction) : Object.hasOwn(command,'direction')) fail('invalid_direction','Stairs and ramps need one cardinal uphill direction.');
  const defaults = {block:{x:2,y:2,z:2},bridge:{x:10,y:1,z:3},port:{x:12,y:1,z:8},sign:{x:3,y:2,z:.5},beacon:{x:1,y:4,z:1},...SHAPE_DEFAULT_SIZES};
  const position = vector(command.position), size = vector(defaultsAllowed ? command.size ?? defaults[command.objectType] : command.size, true);
  if (directional && !shapeDimensionsValid(command.objectType,command.direction,size)) fail('invalid_shape_dimensions','Stairs need at least 0.5 units of run with rises no higher than 0.5; ramps are limited to 45 degrees.');
  const color = defaultsAllowed ? command.color ?? '#c8a570' : command.color;
  if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) fail('invalid_color','Use a hex color such as #c8a570.');
  const label = command.objectType === 'sign' ? {text:command.text} : command.objectType === 'beacon' ? {name:command.name} : {};
  if ((command.objectType === 'sign' && !validLandmarkLabel(label.text,240,true)) || (command.objectType === 'beacon' && !validLandmarkLabel(label.name,48))) fail('invalid_landmark_label','Sign text must be 1–240 characters; beacon names must be 1–48 single-line characters.');
  return {id:randomUUID(),type:command.objectType,...(directional?{direction:command.direction}:{}),position,size,color,...label,ownerId:actor.id,...physicsDefaults[command.objectType],
    ...(['door','gate'].includes(command.objectType)?{state:'closed',usePolicy:'owner_admin',version:0}:{}),
    ...(command.objectType==='button'?{targetId:null,targetState:'open',usePolicy:'owner_admin',version:0}:{})};
}
export function applyCommand(state, actor, command, deltaSeconds = 0.25, context = {}) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('invalid_command','Command must be an object.');
  if (!actor || !['viewer','builder','admin'].includes(actor.role)) fail('forbidden','Unknown role.',403);
  const next = structuredClone(state);
  let result = {}, changed = true;
  switch (command.type) {
    case 'move': {
      if (Object.keys(command).some(key => !['type','position','jump'].includes(key)) || (Object.hasOwn(command,'jump') && typeof command.jump !== 'boolean')) fail('invalid_command','Move accepts only position and an optional boolean jump request.');
      const requested = vector(command.position);
      let player = next.players.find(p => p.id === actor.id);
      if (!player && next.players.length >= 1000) fail('world_full','Player capacity reached.',409);
      const moved = movePlayer(next,player ?? {position:{x:0,y:0,z:0},velocityY:0},{...command,position:requested},deltaSeconds);
      if (player) { player.position = moved.position; player.velocityY = moved.velocityY; }
      else { player = {id:actor.id,...moved}; next.players.push(player); }
      result = {position:player.position,velocityY:player.velocityY};
      break;
    }
    case 'build': {
      if (actor.role === 'viewer') fail('forbidden','Viewers cannot build.',403);
      if (next.objects.length >= 5000) fail('world_full','Object capacity reached.',409);
      const object = buildObject(actor, command);
      next.objects.push(object); result = {object}; break;
    }
    case 'build_group': {
      if (actor.role === 'viewer') fail('forbidden','Viewers cannot build.',403);
      if (!exactKeys(command, ['type','objects']) || !Array.isArray(command.objects) || command.objects.length < 1 || command.objects.length > 32) fail('invalid_command','Group construction requires 1–32 explicit object designs.');
      if (next.objects.length + command.objects.length > 5000) fail('world_full','Object capacity reached.',409);
      const objects = command.objects.map(design => {
        const directional = SHAPE_TYPES.includes(design?.objectType);
        const keys=['objectType','position','size','color'];
        if(directional)keys.push('direction');
        if(design?.objectType==='sign')keys.push('text');
        if(design?.objectType==='beacon')keys.push('name');
        if (!exactKeys(design, keys) || !exactKeys(design.position,['x','y','z']) || !exactKeys(design.size,['x','y','z'])) fail('invalid_command','Each design needs its mechanic fields and explicit position, size, and color.');
        return buildObject(actor, design, false);
      });
      next.objects.push(...objects); result = {objects}; break;
    }
    case 'move_group': {
      if (Object.keys(command).some(key => !['type','changes'].includes(key)) || !Array.isArray(command.changes) || command.changes.length < 2 || command.changes.length > 32) fail('invalid_command','Group movement requires 2–32 changes.');
      const ids = new Set(), changes = [];
      for (const change of command.changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).length !== 3 || !['id','position','expectedPosition'].every(key => Object.hasOwn(change,key)) ||
            typeof change.id !== 'string' || !change.id || change.id.length > 128 || ids.has(change.id)) fail('invalid_command','Each group change needs a unique ID, position and expectedPosition.');
        ids.add(change.id);
        const object = next.objects.find(item => item.id === change.id);
        if (!object) fail('not_found',`Object ${change.id} not found.`,404);
        if (actor.role !== 'admin' && (actor.role !== 'builder' || object.ownerId !== actor.id)) fail('forbidden',`Only the owner or an admin may move object ${change.id}.`,403);
        const expectedPosition = vector(change.expectedPosition), position = vector(change.position);
        if (!['x','y','z'].every(axis => expectedPosition[axis] === object.position[axis])) fail('conflict',`Object ${change.id} changed since it was read. Refresh before moving the group.`,409);
        changes.push({object,position});
      }
      for (const {object,position} of changes) object.position = position;
      result = {objects:changes.map(({object})=>object)};
      break;
    }
    case 'update': {
      const object = next.objects.find(o => o.id === command.id);
      if (!object) fail('not_found','Object not found.',404);
      if (actor.role !== 'admin' && (actor.role !== 'builder' || object.ownerId !== actor.id)) fail('forbidden','Only the owner or an admin may edit this object.',403);
      const interactive = ['door','gate','button'].includes(object.type), button = object.type === 'button';
      const editable = ['position','size','color',...(interactive?[]:['blocksMovement','supportsPlayer']),...(object.type==='sign'?['text']:[]),...(object.type==='beacon'?['name']:[]),...(interactive?['usePolicy']:[]),...(button?['targetId','targetState']:[])];
      const configFields = ['usePolicy',...(button?['targetId','targetState']:[])];
      if (Object.keys(command).some(key => !['type','id','expected',...editable].includes(key)) || !editable.some(key => Object.hasOwn(command,key))) fail('invalid_command','Update requires editable object fields; identity, state and interactive physics cannot be changed.');
      if ([...configFields,'text','name'].some(key => Object.hasOwn(command,key)) && !Object.hasOwn(command,'expected')) fail('invalid_command','Changing access, button links or landmark labels requires current values in expected.');
      if (Object.hasOwn(command,'expected')) {
        const expected = command.expected;
        const changed = editable.filter(key => Object.hasOwn(command,key));
        if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== changed.length || changed.some(key => !Object.hasOwn(expected,key))) fail('invalid_command','Expected values must cover exactly the edited fields.');
        for (const key of changed) {
          let matches;
          if (key === 'blocksMovement' || key === 'supportsPlayer') {
            if (typeof expected[key] !== 'boolean') fail('invalid_command','Expected physics values must be boolean.');
            matches = expected[key] === object[key];
          } else if (key === 'color') {
            if (typeof expected.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(expected.color)) fail('invalid_color','Expected color must be a hex color.');
            matches = expected.color.toLowerCase() === object.color.toLowerCase();
          } else if (key === 'text' || key === 'name') {
            if (!validLandmarkLabel(expected[key],key==='text'?240:48,key==='text')) fail('invalid_command','Expected landmark label is invalid.');
            matches = expected[key] === object[key];
          } else if (key === 'usePolicy') {
            if (!usePolicies.includes(expected[key])) fail('invalid_command','Expected access policy is invalid.');
            matches = expected[key] === object[key];
          } else if (key === 'targetId') {
            if (expected[key] !== null && (typeof expected[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(expected[key]))) fail('invalid_command','Expected button target is invalid.');
            matches = expected[key] === object[key];
          } else if (key === 'targetState') {
            if (!['open','closed'].includes(expected[key])) fail('invalid_command','Expected button state is invalid.');
            matches = expected[key] === object[key];
          } else {
            const previous = vector(expected[key],key === 'size');
            matches = ['x','y','z'].every(axis => previous[axis] === object[key][axis]);
          }
          if (!matches) fail('conflict','The object changed since it was read. Refresh before editing.',409);
        }
      }
      if (Object.hasOwn(command,'usePolicy') && !usePolicies.includes(command.usePolicy)) fail('invalid_command','Access policy must be owner_admin or all_players.');
      if (Object.hasOwn(command,'targetId') && command.targetId !== null) {
        if (typeof command.targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.targetId)) fail('invalid_target','Button target ID is invalid.');
        if (!next.objects.some(item => item.id === command.targetId && ['door','gate'].includes(item.type))) fail('invalid_target','A button must link to an existing door or gate.',409);
      }
      if (Object.hasOwn(command,'targetState') && !['open','closed'].includes(command.targetState)) fail('invalid_command','Button target state must be open or closed.');
      const before = interactive ? {position:{...object.position},size:{...object.size},usePolicy:object.usePolicy,targetId:object.targetId,targetState:object.targetState} : null;
      if (Object.hasOwn(command,'position')) object.position = vector(command.position);
      if (Object.hasOwn(command,'size')) {
        const size = vector(command.size,true);
        if (SHAPE_TYPES.includes(object.type) && !shapeDimensionsValid(object.type,object.direction,size)) fail('invalid_shape_dimensions','Stairs need at least 0.5 units of run with rises no higher than 0.5; ramps are limited to 45 degrees.');
        object.size = size;
      }
      if (Object.hasOwn(command,'color')) {
        if (typeof command.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(command.color)) fail('invalid_color','Use a hex color such as #c8a570.');
        object.color = command.color;
      }
      for (const key of ['blocksMovement','supportsPlayer']) {
        if (Object.hasOwn(command,key)) {
          if (typeof command[key] !== 'boolean') fail('invalid_command','Object physics values must be boolean.');
          object[key] = command[key];
        }
      }
      for (const key of ['text','name']) if (Object.hasOwn(command,key)) {
        if (!editable.includes(key) || !validLandmarkLabel(command[key],key==='text'?240:48,key==='text')) fail('invalid_landmark_label','Landmark text or name is invalid.');
        object[key] = command[key];
      }
      for (const key of ['usePolicy','targetId','targetState']) if (Object.hasOwn(command,key)) object[key] = command[key];
      if (interactive && (['position','size','usePolicy'].some(key => Object.hasOwn(command,key) && JSON.stringify(object[key]) !== JSON.stringify(before[key])) ||
          (button && ['targetId','targetState'].some(key => Object.hasOwn(command,key) && object[key] !== before[key])))) {
        if (object.version >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted','Object version limit reached.',409);
        object.version++;
      }
      result = {object}; break;
    }
    case 'set_state': {
      if (!exactKeys(command,['type','id','state','expectedVersion']) || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.id) || !['open','closed'].includes(command.state) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) fail('invalid_command','set_state requires an object ID, open/closed state and current object version.');
      const object = next.objects.find(o => o.id === command.id);
      if (!object || !['door','gate'].includes(object.type)) fail('not_found','Door or gate not found.',404);
      if (!canUse(actor,object)) fail('forbidden','You do not have permission to use this door or gate.',403);
      requireUseRange(next,actor,object);
      if (command.expectedVersion > object.version || (object.state !== command.state && command.expectedVersion !== object.version)) fail('conflict','The door or gate changed since it was read. Refresh before using it.',409);
      if (object.state === command.state) changed = false;
      else {
        if (command.state === 'closed' && passageOccupied(next,object,context)) fail('occupied','Cannot close a door or gate while a player occupies its passage.',409);
        if (object.version >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted','Object version limit reached.',409);
        object.state = command.state; object.version++; object.blocksMovement = command.state === 'closed';
      }
      result = {object}; break;
    }
    case 'use': {
      if (!exactKeys(command,['type','id','expectedVersion','expectedTargetVersion']) || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.id) ||
          !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0 || !Number.isSafeInteger(command.expectedTargetVersion) || command.expectedTargetVersion < 0) fail('invalid_command','use requires a button ID and current button and target versions.');
      const button = next.objects.find(o => o.id === command.id);
      if (!button || button.type !== 'button') fail('not_found','Button not found.',404);
      if (!canUse(actor,button)) fail('forbidden','You do not have permission to use this button.',403);
      requireUseRange(next,actor,button);
      if (command.expectedVersion !== button.version) fail('conflict','The button changed since it was read. Refresh before using it.',409);
      if (!button.targetId) fail('invalid_target','The button has no configured target.',409);
      const object = next.objects.find(o => o.id === button.targetId);
      if (!object || !['door','gate'].includes(object.type)) fail('not_found','The button target no longer exists.',404);
      if (!canUse(actor,object)) fail('forbidden','You do not have permission to use the target door or gate.',403);
      if (object.version !== command.expectedTargetVersion && object.state !== button.targetState) fail('conflict','The target changed since it was read. Refresh before using the button.',409);
      if (object.state === button.targetState) changed = false;
      else {
        if (button.targetState === 'closed' && passageOccupied(next,object,context)) fail('occupied','Cannot close a door or gate while a player occupies its passage.',409);
        if (object.version >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted','Object version limit reached.',409);
        object.state = button.targetState; object.version++; object.blocksMovement = button.targetState === 'closed';
      }
      result = {object,button}; break;
    }
    case 'remove': {
      const index = next.objects.findIndex(o => o.id === command.id);
      if (index < 0) fail('not_found','Object not found.',404);
      if (actor.role !== 'admin' && (actor.role !== 'builder' || next.objects[index].ownerId !== actor.id)) fail('forbidden','Only the owner or an admin may remove this object.',403);
      next.objects.splice(index,1); break;
    }
    default: fail('invalid_command','Supported commands: move, move_group, build, build_group, update, set_state, use, remove.');
  }
  if (!changed) return {state:next,result:{revision:state.revision,...result}};
  if (state.revision >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted','World revision limit reached.',409);
  next.revision++;
  return {state:next,result:{revision:next.revision,...result}};
}
