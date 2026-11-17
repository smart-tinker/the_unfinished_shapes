const finiteNumber = value => Number.isFinite(value) ? value : null;

const moveSkipReasons = new Set(['move-running', 'stationary', 'no-player', 'no-bridge']);
const moveResults = new Set(['accepted', 'stale', 'rejected', 'request-failed']);

function safeJumpPostResponse(response) {
  if (response?.postAttempted !== true) return null;
  const position = response.serverPosition;
  return {
    postAttempted: true,
    responseReceived: response.responseReceived === true,
    outcome: moveResults.has(response.outcome) ? response.outcome : null,
    serverPosition: {
      x: finiteNumber(position?.x),
      y: finiteNumber(position?.y),
      z: finiteNumber(position?.z),
    },
    serverVelocityY: finiteNumber(response.serverVelocityY),
    serverRevision: Number.isSafeInteger(response.serverRevision) ? response.serverRevision : null,
    clientApplied: typeof response.clientApplied === 'boolean' ? response.clientApplied : null,
  };
}

export function safeJumpTrace({ spaceKeydown, jumpRequested, firstMoveJump, firstMoveSkip, firstMoveResult, jumpPostResponse, serverPlayer } = {}) {
  return {
    spaceKeydown: spaceKeydown === true,
    jumpRequested: typeof jumpRequested === 'boolean' ? jumpRequested : null,
    firstMoveJump: typeof firstMoveJump === 'boolean' ? firstMoveJump : null,
    firstMoveSkip: moveSkipReasons.has(firstMoveSkip) ? firstMoveSkip : null,
    firstMoveResult: moveResults.has(firstMoveResult) ? firstMoveResult : null,
    jumpPostResponse: safeJumpPostResponse(jumpPostResponse),
    serverPosition: {
      x: finiteNumber(serverPlayer?.position?.x),
      y: finiteNumber(serverPlayer?.position?.y),
      z: finiteNumber(serverPlayer?.position?.z),
    },
    serverVelocityY: finiteNumber(serverPlayer?.velocityY),
  };
}
