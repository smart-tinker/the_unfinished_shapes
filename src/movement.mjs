const PLAYER_RADIUS = 0.32;
const PLAYER_HEIGHT = 1.62;
const JUMP_SPEED = 9.5;
const GRAVITY = 18;
const EPSILON = 1e-7;

function overlapsTop(object, x, z) {
  return Math.abs(x - object.position.x) < object.size.x / 2 + PLAYER_RADIUS &&
    Math.abs(z - object.position.z) < object.size.z / 2 + PLAYER_RADIUS;
}
function supportAt(objects, x, z, y) {
  let support = Math.abs(y) < EPSILON ? 0 : null;
  for (const object of objects) {
    const top = object.position.y + object.size.y / 2;
    if (object.supportsPlayer && overlapsTop(object, x, z) && Math.abs(y - top) < EPSILON) support = Math.max(support ?? 0, top);
  }
  return support;
}
function landingAt(objects, x, z, fromY, toY) {
  let landing = fromY >= 0 && toY <= 0 ? 0 : null;
  for (const object of objects) {
    const top = object.position.y + object.size.y / 2;
    if (object.supportsPlayer && overlapsTop(object, x, z) && top <= fromY + EPSILON && top >= toY - EPSILON) landing = Math.max(landing ?? -Infinity, top);
  }
  return landing;
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
    if (!object.blocksMovement || !intersectsVertically(object, position.y)) continue;
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
  const steps = Math.max(1, Math.ceil(duration * 60));
  const step = duration / steps;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    position.x = sweepAxis(objects, position, 'x', start.x + (command.position.x - start.x) * progress);
    position.z = sweepAxis(objects, position, 'z', start.z + (command.position.z - start.z) * progress);
    if (!step) continue;

    const support = supportAt(objects, position.x, position.z, position.y);
    if (velocityY === 0 && support !== null) { position.y = support; continue; }
    const fromY = position.y;
    velocityY -= GRAVITY * step;
    const toY = fromY + velocityY * step;
    if (velocityY <= 0) {
      const landing = landingAt(objects, position.x, position.z, fromY, toY);
      if (landing !== null) { position.y = landing; velocityY = 0; continue; }
    }
    position.y = Math.max(0, toY);
    if (toY <= 0) velocityY = 0;
  }
  return { position, velocityY };
}
