import { randomUUID } from 'node:crypto';
import { movePlayer, SHAPE_TYPES, SHAPE_DIRECTIONS, SHAPE_DEFAULT_SIZES, shapeDimensionsValid } from './movement.mjs';

export const mechanics = ['block', 'bridge', 'port', ...SHAPE_TYPES];
const physicsDefaults = Object.fromEntries(mechanics.map(type => [type, { blocksMovement: true, supportsPlayer: true }]));
export class WorldError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new WorldError(code, message, status); }
export function vector(value, size = false) {
  if (!value || typeof value !== 'object' || !['x','y','z'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && (size ? value[k] >= 0.25 && value[k] <= 50 : Math.abs(value[k]) <= 1000))) fail('invalid_coordinates', size ? 'Size components must be 0.25–50.' : 'Coordinates must be finite and within ±1000.');
  return { x:value.x, y:value.y, z:value.z };
}
export function emptyWorld() { return { version: 1, revision: 0, objects: [], players: [] }; }
export function validateWorld(state) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.objects) || state.objects.length > 5000 || !Array.isArray(state.players) || state.players.length > 1000) fail('invalid_state', 'Invalid saved world. Refusing to overwrite it.', 500);
  state = structuredClone(state);
  const ids = new Set();
  for (const o of state.objects) {
    if (!o || typeof o.id !== 'string' || ids.has(o.id) || !mechanics.includes(o.type) || typeof o.ownerId !== 'string' || !/^#[a-f0-9]{6}$/i.test(o.color)) fail('invalid_state', 'Invalid saved object.', 500);
    ids.add(o.id); vector(o.position); vector(o.size, true);
    if (SHAPE_TYPES.includes(o.type) ? (!SHAPE_DIRECTIONS.includes(o.direction) || !shapeDimensionsValid(o.type,o.direction,o.size)) : Object.hasOwn(o,'direction')) fail('invalid_state', 'Invalid saved shape direction or dimensions.', 500);
    for (const [key, value] of Object.entries(physicsDefaults[o.type])) {
      if (!Object.hasOwn(o, key)) o[key] = value;
      else if (typeof o[key] !== 'boolean') fail('invalid_state', 'Invalid saved object physics.', 500);
    }
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
export function applyCommand(state, actor, command, deltaSeconds = 0.25) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('invalid_command','Command must be an object.');
  if (!actor || !['viewer','builder','admin'].includes(actor.role)) fail('forbidden','Unknown role.',403);
  const next = structuredClone(state);
  let result = {};
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
      if (!mechanics.includes(command.objectType)) fail('new_mechanic_required','This mechanic is not implemented. Develop it in the repository and pass CI before deployment.',409);
      if (next.objects.length >= 5000) fail('world_full','Object capacity reached.',409);
      const directional = SHAPE_TYPES.includes(command.objectType);
      if (directional ? !SHAPE_DIRECTIONS.includes(command.direction) : Object.hasOwn(command,'direction')) fail('invalid_direction','Stairs and ramps need one cardinal uphill direction.');
      const defaults = {block:{x:2,y:2,z:2},bridge:{x:10,y:1,z:3},port:{x:12,y:1,z:8},...SHAPE_DEFAULT_SIZES};
      const position = vector(command.position), size = vector(command.size ?? defaults[command.objectType], true);
      if (directional && !shapeDimensionsValid(command.objectType,command.direction,size)) fail('invalid_shape_dimensions','Stairs are limited to 0.5-unit rises and ramps to a 45-degree slope.');
      const color = command.color ?? '#c8a570';
      if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) fail('invalid_color','Use a hex color such as #c8a570.');
      const object = {id:randomUUID(),type:command.objectType,...(directional?{direction:command.direction}:{}),position,size,color,ownerId:actor.id,...physicsDefaults[command.objectType]};
      next.objects.push(object); result = {object}; break;
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
      const editable = ['position','size','color','blocksMovement','supportsPlayer'];
      if (Object.keys(command).some(key => !['type','id','expected',...editable].includes(key)) || !editable.some(key => Object.hasOwn(command,key))) fail('invalid_command','Update requires position, size or color; identity and mechanic cannot be changed.');
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
          } else {
            const previous = vector(expected[key],key === 'size');
            matches = ['x','y','z'].every(axis => previous[axis] === object[key][axis]);
          }
          if (!matches) fail('conflict','The object changed since it was read. Refresh it before editing.',409);
        }
      }
      if (Object.hasOwn(command,'position')) object.position = vector(command.position);
      if (Object.hasOwn(command,'size')) object.size = vector(command.size,true);
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
      result = {object}; break;
    }
    case 'remove': {
      const index = next.objects.findIndex(o => o.id === command.id);
      if (index < 0) fail('not_found','Object not found.',404);
      if (actor.role !== 'admin' && (actor.role !== 'builder' || next.objects[index].ownerId !== actor.id)) fail('forbidden','Only the owner or an admin may remove this object.',403);
      next.objects.splice(index,1); break;
    }
    default: fail('invalid_command','Supported commands: move, move_group, build, update, remove.');
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted','World revision limit reached.',409);
  next.revision++;
  return {state:next,result:{revision:next.revision,...result}};
}
