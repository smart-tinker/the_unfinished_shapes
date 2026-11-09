import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

const state = (revision, x) => ({
  revision,
  objects: [],
  players: [{ id: 'alice', position: { x, y: 1, z: 0 } }],
  me: { id: 'alice', role: 'builder' },
});

function syncHarness() {
  const h = rendererHarness();
  const sent = [];
  Object.assign(h.context, {
    scene: {}, bridge: {}, playerPosition: { x: 0, y: 1, z: 0 }, meId: null,
    settingsGeneration: 0, moveRunning: false, worldRevision: -1, objectSnapshot: '[]',
    role: 'viewer', objectData: new Map(), meshes: new Map(), otherPlayers: new Map(),
    sceneRoot: {}, sent,
    request: async (...args) => { sent.push(args); return { revision: 10 }; },
  });
  h.element('connection').classList = { add() {}, remove() {} };
  h.load('function renderWorld(', 'async function command(');
  return h;
}

test('a newer server position for the same player is adopted and the next manual step starts there', async () => {
  const h = syncHarness();
  h.context.initial = state(1, 0);
  h.context.agentMove = state(2, 12);
  h.run('renderWorld(initial)');
  h.run('renderWorld(agentMove)');
  assert.equal(h.run('playerPosition.x'), 12);

  h.run('playerPosition.x += 0.25; localMovementVersion++');
  await h.run('syncPosition()');
  const sent = JSON.parse(h.run('JSON.stringify(sent)'));
  assert.deepEqual(sent[0][2], { type: 'move', position: { x: 12.25, y: 1, z: 0 } });
});

test('a delayed older world snapshot cannot undo a newer accepted position', () => {
  const h = syncHarness();
  h.context.initial = state(1, 0);
  h.context.agentMove = state(3, 12);
  h.context.delayed = state(2, 4);
  h.run('renderWorld(initial)');
  h.run('renderWorld(agentMove)');
  h.run('renderWorld(delayed)');
  assert.equal(h.run('playerPosition.x'), 12);
});

test('a poll that began before new local input does not overwrite that input', async () => {
  const h = syncHarness();
  h.context.initial = state(1, 0);
  h.run('renderWorld(initial)');
  let resolveState;
  h.context.request = () => new Promise(resolve => { resolveState = resolve; });
  const pending = h.run('poll()');
  h.run('playerPosition.x = 2; localMovementVersion++');
  resolveState(state(2, 1));
  await pending;
  assert.equal(h.run('playerPosition.x'), 2);
});
