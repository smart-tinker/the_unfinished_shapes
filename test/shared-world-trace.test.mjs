import test from 'node:test';
import assert from 'node:assert/strict';
import { safeJumpTrace } from '../scripts/shared-world-trace.mjs';

test('safe jump trace exposes the exact jump POST response and filters private data', () => {
  const trace = safeJumpTrace({
    spaceKeydown: true,
    jumpRequested: true,
    firstMoveJump: true,
    firstMoveResult: 'accepted',
    jumpPostResponse: {
      postAttempted: true, responseReceived: true, outcome: 'accepted',
      serverPosition: { x: 14.68, y: 0, z: 0, token: 'private' },
      serverVelocityY: 0, serverRevision: 42, clientApplied: false,
      error: 'private response detail',
    },
    serverPlayer: { id: 'alice', position: { x: 14.68, y: 0, z: 0, secret: 'private' }, velocityY: 0, token: 'secret' },
    rawText: 'private',
  });
  assert.deepEqual(trace, {
    spaceKeydown: true,
    jumpRequested: true,
    firstMoveJump: true,
    firstMoveSkip: null,
    firstMoveResult: 'accepted',
    jumpPostResponse: {
      postAttempted: true, responseReceived: true, outcome: 'accepted',
      serverPosition: { x: 14.68, y: 0, z: 0 },
      serverVelocityY: 0, serverRevision: 42, clientApplied: false,
    },
    serverPosition: { x: 14.68, y: 0, z: 0 },
    serverVelocityY: 0,
  });
  assert.doesNotMatch(JSON.stringify(trace), /alice|private|secret|token|error/);

  assert.deepEqual(safeJumpTrace({
    spaceKeydown: 'yes',
    jumpRequested: 'yes',
    firstMoveJump: 1,
    firstMoveSkip: 'private detail',
    firstMoveResult: 'PRIVATE_CODE',
    jumpPostResponse: {
      postAttempted: true, responseReceived: true, outcome: 'PRIVATE_CODE', serverPosition: { x: '14.68', y: Infinity, z: NaN },
      serverVelocityY: 'private', serverRevision: 1.5, clientApplied: 'yes',
    },
    serverPlayer: { id: 'alice', position: { x: '14.68', y: Infinity, z: NaN }, velocityY: 'private' },
  }), {
    spaceKeydown: false,
    jumpRequested: null,
    firstMoveJump: null,
    firstMoveSkip: null,
    firstMoveResult: null,
    jumpPostResponse: {
      postAttempted: true, responseReceived: true, outcome: null,
      serverPosition: { x: null, y: null, z: null },
      serverVelocityY: null, serverRevision: null, clientApplied: null,
    },
    serverPosition: { x: null, y: null, z: null },
    serverVelocityY: null,
  });
  assert.equal(safeJumpTrace({ jumpPostResponse: { postAttempted: false } }).jumpPostResponse, null);
});
