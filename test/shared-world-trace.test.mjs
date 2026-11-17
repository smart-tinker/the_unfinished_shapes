import test from 'node:test';
import assert from 'node:assert/strict';
import { safeJumpTrace } from '../scripts/shared-world-trace.mjs';

test('safe jump trace contains only event booleans and finite server coordinates', () => {
  const trace = safeJumpTrace({
    spaceKeydown: true,
    jumpRequested: true,
    firstMoveJump: false,
    firstMoveSkip: 'move-running',
    firstMoveResult: 'accepted',
    serverPlayer: { id: 'alice', position: { x: 14.68, y: 0, z: 0, secret: 'private' }, velocityY: 0, token: 'secret' },
    rawText: 'private',
  });
  assert.deepEqual(trace, {
    spaceKeydown: true,
    jumpRequested: true,
    firstMoveJump: false,
    firstMoveSkip: 'move-running',
    firstMoveResult: 'accepted',
    serverPosition: { x: 14.68, y: 0, z: 0 },
    serverVelocityY: 0,
  });
  assert.doesNotMatch(JSON.stringify(trace), /alice|private|secret|token/);

  assert.deepEqual(safeJumpTrace({
    spaceKeydown: 'yes',
    jumpRequested: 'yes',
    firstMoveJump: 1,
    firstMoveSkip: 'private detail',
    firstMoveResult: 'PRIVATE_CODE',
    serverPlayer: { id: 'alice', position: { x: '14.68', y: Infinity, z: NaN }, velocityY: 'private' },
  }), {
    spaceKeydown: false,
    jumpRequested: null,
    firstMoveJump: null,
    firstMoveSkip: null,
    firstMoveResult: null,
    serverPosition: { x: null, y: null, z: null },
    serverVelocityY: null,
  });
});
