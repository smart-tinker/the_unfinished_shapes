export const WORLD_SIZE = 48;
export const WALK_SPEED = 5;
export const SHAPE_TYPES = ['stairs','ramp'];
export const SHAPE_DIRECTIONS = ['north','east','south','west'];
export const SHAPE_DEFAULT_SIZES = {stairs:{x:8,y:2,z:4},ramp:{x:4,y:2,z:8}};
const PLAYER_RADIUS = 0.32;
const PLAYER_HEIGHT = 1.62;
const JUMP_SPEED = 9.5;
const GRAVITY = 18;
const MAX_STEP_HEIGHT = 0.5;
const EPSILON = 1e-7;

export function shapeDimensionsValid(type, direction, size) {
  if (type === 'stairs') return size.y <= 2;
  if (type === 'ramp') return size.y <= (direction === 'east' || direction === 'west' ? size.x : size.z);
  return true;
}

function islandPosition(start, requested) {
  const limit = WORLD_SIZE / 2 - PLAYER_RADIUS;
  if (start > limit) return Math.min(start, Math.max(limit, requested));
  if (start < -limit) return Math.max(start, Math.min(-limit, requested));
  return Math.max(-limit, Math.min(limit, requested));
}
function movementDestination(start, requested, duration) {
  const x = islandPosition(start.x, requested.x), z = islandPosition(start.z, requested.z);
  const dx = x - start.x, dz = z - start.z, distance = Math.hypot(dx, dz);
  const scale = distance > WALK_SPEED * duration && distance > 0 ? WALK_SPEED * duration / distance : 1;
  return { x: start.x + dx * scale, z: start.z + dz * scale };
}
function overlapsTop(object, x, z) {
  return Math.abs(x - object.position.x) < object.size.x / 2 + PLAYER_RADIUS &&
    Math.abs(z - object.position.z) < object.size.z / 2 + PLAYER_RADIUS;
}
function shapeHeightAt(object, x, z) {
  if (!SHAPE_DIRECTIONS.includes(object.direction) ||
      Math.abs(x - object.position.x) > object.size.x / 2 + PLAYER_RADIUS ||
      Math.abs(z - object.position.z) > object.size.z / 2 + PLAYER_RADIUS) return null;
  const runAxis = object.direction === 'east' || object.direction === 'west' ? 'x' : 'z';
  const run = object.size[runAxis], center = object.position[runAxis], coordinate = runAxis === 'x' ? x : z;
  const progress = (object.direction === 'east' || object.direction === 'south')
    ? (coordinate - (center - run / 2)) / run
    : ((center + run / 2) - coordinate) / run;
  const t = Math.max(0, Math.min(1, progress)), bottom = object.position.y - object.size.y / 2;
  if (object.type === 'ramp') return bottom + object.size.y * t;
  return bottom + object.size.y * Math.min(4, Math.floor(t * 4) + 1) / 4;
}
function surfaceAt(object, x, z) {
  if (!object.supportsPlayer) return null;
  if (SHAPE_TYPES.includes(object.type)) return shapeHeightAt(object, x, z);
  return overlapsTop(object, x, z) ? object.position.y + object.size.y / 2 : null;
}
function supportAt(objects, x, z, y) {
  let support = Math.abs(y) < EPSILON ? 0 : null;
  for (const object of objects) {
    const surface = surfaceAt(object, x, z);
    if (surface !== null && Math.abs(y - surface) < EPSILON) support = Math.max(support ?? 0, surface);
  }
  return support;
}
function reachableSurfaceAt(objects, x, z, y) {
  let support = y >= -MAX_STEP_HEIGHT - EPSILON && y <= MAX_STEP_HEIGHT + EPSILON ? 0 : null;
  for (const object of objects) {
    const surface = surfaceAt(object, x, z);
    if (surface !== null && surface >= y - MAX_STEP_HEIGHT - EPSILON && surface <= y + MAX_STEP_HEIGHT + EPSILON) {
      support = Math.max(support ?? -Infinity, surface);
    }
  }
  return support;
}
function landingAt(objects, x, z, fromY, toY) {
  let landing = fromY >= 0 && toY <= 0 ? 0 : null;
  for (const object of objects) {
    const surface = surfaceAt(object, x, z);
    if (surface !== null && surface <= fromY + EPSILON && surface >= toY - EPSILON) landing = Math.max(landing ?? -Infinity, surface);
  }
  return landing;
}
function ceilingAt(objects, x, z, fromY, toY) {
  let ceiling = null;
  for (const object of objects) {
    const bottom = object.position.y - object.size.y / 2;
    if (object.blocksMovement && overlapsTop(object, x, z) && fromY + PLAYER_HEIGHT <= bottom + EPSILON && toY + PLAYER_HEIGHT >= bottom - EPSILON) {
      ceiling = Math.min(ceiling ?? Infinity, bottom - PLAYER_HEIGHT);
    }
  }
  return ceiling;
}
function intersectsVertically(object, y) {
  const bottom = object.position.y - object.size.y / 2;
  const top = object.position.y + object.size.y / 2;
  return y < top - EPSILON && y + PLAYER_HEIGHT > bottom + EPSILON;
}
function sweepAxis(objects, position, axis, destination) {
  const other = axis === 'x' ? 'z' : 'x';
  const direction = Math.sign(destination - position[axis]);
  if (!direction) return position[axis];
  let resolved = destination;
  for (const object of objects) {
    if (!object.blocksMovement) continue;
    if (SHAPE_TYPES.includes(object.type)) {
      const surface = shapeHeightAt(object, axis === 'x' ? resolved : position.x, axis === 'z' ? resolved : position.z);
      if (surface === null || surface <= position.y + MAX_STEP_HEIGHT + EPSILON) continue;
      const half = object.size[axis] / 2 + PLAYER_RADIUS;
      const low = object.position[axis] - half, high = object.position[axis] + half, start = position[axis];
      if (direction > 0 && start <= low && resolved > low) resolved = Math.min(resolved, low);
      else if (direction < 0 && start >= high && resolved < high) resolved = Math.max(resolved, high);
      continue;
    }
    if (!intersectsVertically(object, position.y)) continue;
    const otherHalf = object.size[other] / 2 + PLAYER_RADIUS;
    if (Math.abs(position[other] - object.position[other]) >= otherHalf - EPSILON) continue;
    const half = object.size[axis] / 2 + PLAYER_RADIUS;
    const low = object.position[axis] - half, high = object.position[axis] + half;
    const start = position[axis];
    if (start > low + EPSILON && start < high - EPSILON) {
      // Let a player already inside legacy geometry move out, but stop at the first clear face.
      resolved = direction > 0 ? Math.min(resolved, high) : Math.max(resolved, low);
    } else if (direction > 0 && start <= low && resolved > low) resolved = Math.min(resolved, low);
    else if (direction < 0 && start >= high && resolved < high) resolved = Math.max(resolved, high);
  }
  return resolved;
}

/** Resolve a requested X/Z destination with server-owned height and a capped physics step. */
export function movePlayer(world, current, command, deltaSeconds = 0.25) {
  const start = current?.position ?? { x: 0, y: 0, z: 0 };
  const position = { x: start.x, y: start.y, z: start.z };
  let velocityY = current?.velocityY ?? 0;
  const objects = world.objects;
  if (command.jump && supportAt(objects, position.x, position.z, position.y) !== null) velocityY = JUMP_SPEED;

  const duration = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.25)) : 0;
  const destination = movementDestination(start, command.position, duration);
  const steps = Math.max(1, Math.ceil(duration * 60));
  const step = duration / steps;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const grounded = velocityY === 0 && supportAt(objects, position.x, position.z, position.y) !== null;
    const previousX = position.x, previousZ = position.z;
    position.x = sweepAxis(objects, position, 'x', start.x + (destination.x - start.x) * progress);
    position.z = sweepAxis(objects, position, 'z', start.z + (destination.z - start.z) * progress);
    if (!step) continue;

    if (grounded && velocityY === 0) {
      const surface = reachableSurfaceAt(objects, position.x, position.z, position.y);
      if (surface !== null) {
        const ceiling = surface > position.y + EPSILON ? ceilingAt(objects, position.x, position.z, position.y, surface) : null;
        if (ceiling !== null && surface > ceiling + EPSILON) {
          position.x = previousX; position.z = previousZ; continue;
        }
        position.y = surface; continue;
      }
    }
    const support = supportAt(objects, position.x, position.z, position.y);
    if (velocityY === 0 && support !== null) { position.y = support; continue; }
    const fromY = position.y;
    velocityY -= GRAVITY * step;
    const toY = fromY + velocityY * step;
    if (velocityY > 0) {
      const ceiling = ceilingAt(objects, position.x, position.z, fromY, toY);
      if (ceiling !== null) { position.y = ceiling; velocityY = 0; continue; }
    }
    if (velocityY <= 0) {
      const landing = landingAt(objects, position.x, position.z, fromY, toY);
      if (landing !== null) { position.y = landing; velocityY = 0; continue; }
    }
    position.y = Math.max(0, toY);
    if (toY <= 0) velocityY = 0;
  }
  return { position, velocityY };
}
