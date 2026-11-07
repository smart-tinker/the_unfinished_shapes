import { randomUUID } from 'node:crypto';

export const mechanics = ['block', 'bridge', 'port'];
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
  const ids = new Set();
  for (const o of state.objects) {
    if (!o || typeof o.id !== 'string' || ids.has(o.id) || !mechanics.includes(o.type) || typeof o.ownerId !== 'string' || !/^#[a-f0-9]{6}$/i.test(o.color)) fail('invalid_state', 'Invalid saved object.', 500);
    ids.add(o.id); vector(o.position); vector(o.size, true);
  }
  const players = new Set();
  for (const p of state.players) {
    if (!p || typeof p.id !== 'string' || players.has(p.id)) fail('invalid_state', 'Invalid saved player.', 500);
    players.add(p.id); vector(p.position);
  }
  return state;
}
export function applyCommand(state, actor, command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('invalid_command','Command must be an object.');
  if (!actor || !['viewer','builder','admin'].includes(actor.role)) fail('forbidden','Unknown role.',403);
  const next = structuredClone(state);
  let result = {};
  switch (command.type) {
    case 'move': {
      const position = vector(command.position);
      const player = next.players.find(p => p.id === actor.id);
      if (player) player.position = position;
      else { if (next.players.length >= 1000) fail('world_full','Player capacity reached.',409); next.players.push({id:actor.id,position}); }
      break;
    }
    case 'build': {
      if (actor.role === 'viewer') fail('forbidden','Viewers cannot build.',403);
      if (!mechanics.includes(command.objectType)) fail('new_mechanic_required','This mechanic is not implemented. Develop it in the repository and pass CI before deployment.',409);
      if (next.objects.length >= 5000) fail('world_full','Object capacity reached.',409);
      const defaults = {block:{x:2,y:2,z:2},bridge:{x:10,y:1,z:3},port:{x:12,y:1,z:8}};
      const position = vector(command.position), size = vector(command.size ?? defaults[command.objectType], true);
      const color = command.color ?? '#c8a570';
      if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) fail('invalid_color','Use a hex color such as #c8a570.');
      const object = {id:randomUUID(),type:command.objectType,position,size,color,ownerId:actor.id};
      next.objects.push(object); result = {object}; break;
    }
    case 'remove': {
      const index = next.objects.findIndex(o => o.id === command.id);
      if (index < 0) fail('not_found','Object not found.',404);
      if (actor.role !== 'admin' && (actor.role !== 'builder' || next.objects[index].ownerId !== actor.id)) fail('forbidden','Only the owner or an admin may remove this object.',403);
      next.objects.splice(index,1); break;
    }
    default: fail('invalid_command','Supported commands: move, build, remove.');
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted','World revision limit reached.',409);
  next.revision++;
  return {state:next,result:{revision:next.revision,...result}};
}
