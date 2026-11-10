import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorldServer } from '../src/server.mjs';
import { captureSceneSnapshot, executeGameTool } from '../src/game-tools.mjs';
import { rendererHarness } from './support/renderer-harness.mjs';

const tokens = {
  alice: 'presence-test-alice-token-123',
  bob: 'presence-test-bob-token-12345',
};
const users = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [token, { id, role: 'builder' }]));

async function startServer(dataPath) {
  const app = await createWorldServer({ dataPath, users, port: 0 });
  await app.start();
  return { app, url: `http://127.0.0.1:${app.address().port}` };
}

test('offline players disappear, keep their saved position, and return there after reconnect', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tus-presence-'));
  const dataPath = path.join(dir, 'world.json');
  let server = await startServer(dataPath);
  t.after(async () => {
    if (server?.app.listening) await server.app.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  const state = async id => {
    const response = await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[id] } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const move = async (id, position) => {
    const response = await fetch(server.url + '/command', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokens[id], 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'move', position }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  await move('alice', { x: 3, y: 0, z: 4 });
  await move('bob', { x: 8, y: 0, z: 9 });
  const initial = await state('alice');
  assert.deepEqual([...initial.onlinePlayerIds].sort(), ['alice', 'bob'], 'both authenticated players are online');
  const alicePosition = structuredClone(initial.players.find(player => player.id === 'alice').position);
  const savedRevision = initial.revision;

  await new Promise(resolve => setTimeout(resolve, 10_100));
  const afterDisconnect = await state('bob');
  assert.deepEqual(afterDisconnect.onlinePlayerIds, ['bob'], 'Alice disappears after her presence expires');
  assert.deepEqual(afterDisconnect.players.find(player => player.id === 'alice').position, alicePosition, 'offline movement does not alter saved position');
  assert.equal(afterDisconnect.revision, savedRevision, 'presence changes do not persist as world edits');

  await server.app.shutdown();
  server = await startServer(dataPath);
  const afterRestart = await state('bob');
  assert.deepEqual(afterRestart.onlinePlayerIds, ['bob'], 'server restart does not restore stale online presence');
  assert.deepEqual(afterRestart.players.find(player => player.id === 'alice').position, alicePosition);

  const reconnected = await state('alice');
  assert.deepEqual([...reconnected.onlinePlayerIds].sort(), ['alice', 'bob']);
  assert.deepEqual(reconnected.players.find(player => player.id === 'alice').position, alicePosition, 'reconnect restores the persisted position');
});

test('agent world_state hides persisted players that are not online', async t => {
  const saved = {
    revision: 4,
    objects: [],
    players: [
      { id: 'alice', position: { x: 0, y: 0, z: 0 } },
      { id: 'bob', position: { x: 1, y: 0, z: 0 } },
      { id: 'carol', position: { x: 2, y: 0, z: 0 } },
    ],
    onlinePlayerIds: ['alice', 'bob'],
    me: { id: 'alice', role: 'builder' },
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => structuredClone(saved) }));

  const result = await executeGameTool({ name: 'world_state', arguments: {} }, {
    url: 'http://world.invalid',
    token: 'test-only-token',
    connectionId: 'presence-test',
  });

  assert.equal(result.success, true);
  const state = JSON.parse(result.contentItems[0].text);
  assert.deepEqual(state.players.map(player => player.id), ['alice', 'bob']);
});

test('scene context includes only online players', () => {
  const state = {
    revision: 7,
    objects: [],
    players: [
      { id: 'alice', position: { x: 0, y: 0, z: 0 } },
      { id: 'bob', position: { x: 1, y: 0, z: 0 } },
      { id: 'carol', position: { x: 2, y: 0, z: 0 } },
    ],
    onlinePlayerIds: ['alice', 'bob'],
    me: { id: 'alice', role: 'builder' },
  };
  const view = {
    revision: 7,
    selectedIds: [],
    camera: {
      position: { x: 0, y: 2, z: 10 }, target: { x: 0, y: 2, z: 0 },
      fov: 42, aspect: 1.5, near: 0.1, far: 220,
      viewport: { width: 900, height: 600 },
    },
  };

  const snapshot = captureSceneSnapshot(state, view, 'presence-test');
  assert.deepEqual(snapshot.players.map(player => player.id), ['alice', 'bob']);
  assert.equal(snapshot.totalPlayerCount, 2);
});

test('renderer removes saved avatars as soon as the server omits them from online presence', () => {
  const h = rendererHarness();
  h.run(`let latestStateRevision=0,worldState=null,worldRevision=0,meId='alice',
    playerPosition={x:0,y:0,z:0},playerVelocityY=0,lastPosition='0,0,0',moveRunning=false,
    localMovementVersion=0,role='builder',selectedId=null,movePreview=null,dragCandidate=null,
    editing=false,inspectorDirty=false,inspectorBase=null,objectData=new Map(),objectSnapshot='[]',
    meshes=new Map(),otherPlayers=new Map(),scene={add(){},remove(){}},sceneRoot={remove(){}},
    disposeGroup=()=>{},avatar=()=>({position:{set(){}}}),selectObject=()=>{},positionKey=p=>`${p.x},${p.y},${p.z}`,
    fillInspector=()=>{};`);
  h.load('function renderWorld(state, movementVersion = localMovementVersion) {', 'async function poll()');

  h.run(`renderWorld({revision:1,objects:[],me:{id:'alice',role:'builder'},
    players:[{id:'alice',position:{x:0,y:0,z:0}},{id:'bob',position:{x:1,y:0,z:0}},{id:'carol',position:{x:2,y:0,z:0}}],
    onlinePlayerIds:['alice','bob']});`);
  assert.deepEqual([...h.run('[...otherPlayers.keys()]')], ['bob']);

  h.run(`renderWorld({revision:2,objects:[],me:{id:'alice',role:'builder'},
    players:[{id:'alice',position:{x:0,y:0,z:0}},{id:'bob',position:{x:1,y:0,z:0}},{id:'carol',position:{x:2,y:0,z:0}}],
    onlinePlayerIds:['alice']});`);
  assert.deepEqual([...h.run('[...otherPlayers.keys()]')], []);
});
