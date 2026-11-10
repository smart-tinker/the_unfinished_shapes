import test from 'node:test';
import assert from 'node:assert/strict';
import { placementPosition, positionUpdateCommand } from '../src/placement.mjs';

const moving = { id: 'moving', position: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 } };

test('drag snaps X/Z to the visible grid and keeps the object bottom on ground', () => {
  assert.deepEqual(placementPosition({ x: 1.26, z: -2.76 }, moving, null, 0.5), { x: 1.5, y: 1, z: -3 });
});

test('drag over a supporting top snaps to that exact surface and ignores unsupported tops', () => {
  const supported = { id: 'platform', position: { x: 4, y: 1, z: 0 }, size: { x: 4, y: 2, z: 4 }, supportsPlayer: true };
  assert.deepEqual(placementPosition({ x: 4.26, z: -0.4 }, moving, supported, 1), { x: 4, y: 3, z: 0 });
  assert.deepEqual(placementPosition({ x: 4.26, z: -0.4 }, moving, { ...supported, supportsPlayer: false }, 1), { x: 4, y: 1, z: 0 });
});

test('disabling grid snap preserves pointer coordinates but still applies surface height', () => {
  const supported = { position: { x: 0, y: 2, z: 0 }, size: { x: 4, y: 4, z: 4 }, supportsPlayer: true };
  assert.deepEqual(placementPosition({ x: 1.26, z: -2.76 }, moving, supported, 0), { x: 1.26, y: 5, z: -2.76 });
});

test('selected XY plane snaps horizontal and vertical while preserving depth', () => {
  assert.deepEqual(
    placementPosition({ x: 1.26, y: 4.24, z: 99 }, moving, null, 0.5, 'xy'),
    { x: 1.5, y: 4, z: 0 },
  );
});

test('selected YZ plane snaps vertical and depth while preserving width', () => {
  assert.deepEqual(
    placementPosition({ x: 99, y: 2.24, z: -2.76 }, moving, null, 0.5, 'yz'),
    { x: 0, y: 2, z: -3 },
  );
});

test('apply contains one conditional update and preserves the original server position', () => {
  const next = { x: 8, y: 1, z: -3 };
  const command = positionUpdateCommand(moving, next);
  moving.position.x = 99;
  assert.deepEqual(command, {
    type: 'update', id: 'moving', position: next,
    expected: { position: { x: 0, y: 1, z: 0 } },
  });
  moving.position.x = 0;
});

for (const [axis, point, expected] of [
  ['x', { x: 2.2, y: 9.9, z: 7.2 }, { x: 2, y: 1, z: 0 }],
  ['y', { x: 2.2, y: 9.9, z: 7.2 }, { x: 0, y: 10, z: 0 }],
  ['z', { x: 2.2, y: 9.9, z: 7.2 }, { x: 0, y: 1, z: 7 }],
]) {
  test(`selected ${axis.toUpperCase()} axis snaps only that coordinate`, () => {
    assert.deepEqual(placementPosition(point, object, null, 1, axis), expected);
  });
}
