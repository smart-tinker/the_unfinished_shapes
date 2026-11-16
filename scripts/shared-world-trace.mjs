const finiteNumber = value => Number.isFinite(value) ? value : null;

export function safeJumpTrace({ spaceKeydown, jumpRequested, firstMoveJump, serverPlayer } = {}) {
  return {
    spaceKeydown: spaceKeydown === true,
    jumpRequested: typeof jumpRequested === 'boolean' ? jumpRequested : null,
    firstMoveJump: typeof firstMoveJump === 'boolean' ? firstMoveJump : null,
    serverPosition: {
      x: finiteNumber(serverPlayer?.position?.x),
      y: finiteNumber(serverPlayer?.position?.y),
      z: finiteNumber(serverPlayer?.position?.z),
    },
    serverVelocityY: finiteNumber(serverPlayer?.velocityY),
  };
}
