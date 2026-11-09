import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorldServer } from '../src/server.mjs';
import { executeGameTool } from '../src/game-tools.mjs';

test('two builders retain a shared world across restart and cannot edit each other through agent tools', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tus-two-builders-'));
  const users = { 'synthetic-alice-token': { id: 'alice', role: 'builder' }, 'synthetic-bob-token': { id: 'bob', role: 'builder' } };
  const config = { dataPath: path.join(dir, 'world.json'), users, port: 0 };
  let server = await createWorldServer(config); await server.start();
  t.after(async () => { if (server.listening) await server.shutdown(); await rm(dir, { recursive: true, force: true }); });
  let url = 'http://127.0.0.1:' + server.address().port;
  const connection = id => ({ url, token: 'synthetic-' + id + '-token' });
  const get = async id => { const r = await fetch(url + '/state', { headers: { Authorization: 'Bearer ' + connection(id).token } }); assert.equal(r.status, 200); return r.json(); };
  const build = id => executeGameTool({ name: 'world_build', arguments: { objectType: 'block', position: { x: id === 'alice' ? 3 : -3, y: 1, z: 4 }, size: { x: 2, y: 2, z: 2 }, color: '#3366cc' } }, connection(id));
  const results = await Promise.all(['alice', 'bob'].map(build));
  assert.ok(results.every(r => r.success === true));
  const before = await get('alice');
  assert.equal(before.objects.length, 2);
  assert.deepEqual((await get('bob')).objects, before.objects);
  const aliceObject = before.objects.find(o => o.ownerId === 'alice');
  for (const command of [{ type: 'update', id: aliceObject.id, color: '#ff0000', expected: { color: aliceObject.color } }, { type: 'remove', id: aliceObject.id }]) {
    const denied = await executeGameTool({ name: 'world_command', arguments: { command } }, connection('bob'));
    assert.equal(denied.success, false, 'agent must not acquire another player permissions');
    assert.equal(JSON.parse(denied.contentItems.find(item => item.type === 'inputText').text).error, 'forbidden', 'denial must come from server ownership rules');
  }
  const unchanged = await get('bob');
  assert.equal(unchanged.revision, before.revision);
  assert.deepEqual(unchanged.objects, before.objects);
  await server.shutdown(); server = await createWorldServer(config); await server.start();
  url = 'http://127.0.0.1:' + server.address().port;
  for (const id of ['alice', 'bob']) {
    const restored = await get(id);
    assert.equal(restored.me.id, id); assert.deepEqual(restored.objects, before.objects);
  }
});
