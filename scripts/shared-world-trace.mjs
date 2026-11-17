const finiteNumber = value => Number.isFinite(value) ? value : null;

const moveSkipReasons = new Set(['move-running', 'stationary', 'no-player', 'no-bridge']);
const moveResults = new Set(['accepted', 'stale', 'rejected', 'request-failed']);

export function safeJumpTrace({ spaceKeydown, jumpRequested, firstMoveJump, firstMoveSkip, firstMoveResult, serverPlayer } = {}) {
  return {
    spaceKeydown: spaceKeydown === true,
    jumpRequested: typeof jumpRequested === 'boolean' ? jumpRequested : null,
    firstMoveJump: typeof firstMoveJump === 'boolean' ? firstMoveJump : null,
    firstMoveSkip: moveSkipReasons.has(firstMoveSkip) ? firstMoveSkip : null,
    firstMoveResult: moveResults.has(firstMoveResult) ? firstMoveResult : null,
    serverPosition: {
      x: finiteNumber(serverPlayer?.position?.x),
      y: finiteNumber(serverPlayer?.position?.y),
      z: finiteNumber(serverPlayer?.position?.z),
    },
    serverVelocityY: finiteNumber(serverPlayer?.velocityY),
  };
}
