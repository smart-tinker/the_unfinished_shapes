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
    settingsGeneration: 0, pollRunning: false, moveRunning: false, localMovementVersion: 0, latestStateRevision: -1, worldRevision: -1, objectSnapshot: '[]',
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


function activityHarness() {
  const h = syncHarness();
  Object.assign(h.context, { busy: true, latestStateRevision: 1 });
  h.load('const toolRows = new Map()', 'function notificationActivity(');
  h.run("activityThread('thread-1')");
  return h;
}

test('a confirmed agent move is adopted unless newer keyboard input arrived after it started', () => {
  const h = activityHarness();
  h.context.start = { type: 'tool-start', threadId: 'thread-1', turnId: 'turn-1', id: 'call-1', name: 'world_command', arguments: { command: { type: 'move', position: { x: 12, y: 1, z: 0 } } } };
  h.run('toolActivity(start)');
  assert.equal(h.run('moveStarts.size'), 1);
  h.context.result = { ...h.context.start, type: 'tool-result', result: { success: true, contentItems: [{ type: 'inputText', text: '{"revision":2}' }] } };
  h.run('toolActivity(result)');
  assert.equal(h.run('latestStateRevision'), 2);
  assert.equal(h.run('playerPosition.x'), 12);

  h.context.otherStart = { ...h.context.start, id: 'call-2', turnId: 'turn-2' };
  h.run('currentTurnId=null; toolActivity(otherStart)');
  h.run('playerPosition.x=14; localMovementVersion++');
  h.context.otherResult = { ...h.context.otherStart, type: 'tool-result', result: { success: true, contentItems: [{ type: 'inputText', text: '{"revision":3}' }] } };
  h.run('toolActivity(otherResult)');
  assert.equal(h.run('playerPosition.x'), 14);
  assert.equal(h.run('latestStateRevision'), 3);

  h.context.staleStart = { ...h.context.otherStart, id: 'call-3' };
  h.run('toolActivity(staleStart)');
  h.run('settingsGeneration++');
  h.context.staleResult = { ...h.context.staleStart, type: 'tool-result', result: { success: true, contentItems: [{ type: 'inputText', text: '{"revision":4}' }] } };
  h.run('toolActivity(staleResult)');
  assert.equal(h.run('playerPosition.x'), 14);
  assert.equal(h.run('latestStateRevision'), 3);
});


test('the latest server-accepted move wins when an earlier manual request replies later', async () => {
  const h = activityHarness();
  h.context.initial = state(1, 0);
  h.run('renderWorld(initial)');
  h.run('playerPosition.x=2; localMovementVersion++');
  let resolveMove;
  h.context.request = (...args) => new Promise(resolve => { h.context.manualRequest = args; resolveMove = resolve; });
  const pending = h.run('syncPosition()');
  h.context.start = { type: 'tool-start', threadId: 'thread-1', turnId: 'turn-1', id: 'agent-move', name: 'world_command', arguments: { command: { type: 'move', position: { x: 12, y: 1, z: 0 } } } };
  h.run('toolActivity(start)');
  h.context.result = { ...h.context.start, type: 'tool-result', result: { success: true, contentItems: [{ type: 'inputText', text: '{"revision":2}' }] } };
  h.run('toolActivity(result)');
  assert.equal(h.run('playerPosition.x'), 12);
  resolveMove({ revision: 3 });
  await pending;
  assert.equal(h.run('playerPosition.x'), 2);
});

test('a second client renders the latest server position of the moved player', () => {
  const h = syncHarness();
  h.context.scene = { add() {}, remove() {} };
  h.context.avatar = () => ({ position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } } });
  h.context.observer = {
    revision: 3,
    objects: [],
    players: [
      { id: 'bob', position: { x: 0, y: 1, z: 0 } },
      { id: 'alice', position: { x: 12, y: 1, z: 0 } },
    ],
    me: { id: 'bob', role: 'builder' },
  };
  h.run('renderWorld(observer)');
  assert.equal(h.context.otherPlayers.get('alice').position.x, 12);

  h.context.observer = {
    ...h.context.observer,
    revision: 4,
    players: [
      { id: 'bob', position: { x: 0, y: 1, z: 0 } },
      { id: 'alice', position: { x: 13, y: 1, z: 0 } },
    ],
  };
  h.run('renderWorld(observer)');
  assert.equal(h.context.otherPlayers.get('alice').position.x, 13);
});
