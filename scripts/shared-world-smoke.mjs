import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { observeGraphics, closeSmokeApp, withSmokeCleanup } from './graphics-smoke.mjs';

import { stopServerProcess } from './server-smoke-process.mjs';
import { selectObject } from './ui-acceptance.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'tus-shared-'));
const tokens = { alice: randomBytes(24).toString('hex'), bob: randomBytes(24).toString('hex') };
const users = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [token, { id, role: 'builder' }]));
const dataPath = path.join(dir, 'world.json');
const clients = [];
let server, port, url;
async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, WORLD_DATA_PATH: dataPath, WORLD_USERS_JSON: JSON.stringify(users), WORLD_PORT: String(port || 0) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Shared server did not start')), 15000);
    let output = '';
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Shared server exited: ' + code)); });
    server.stdout.on('data', chunk => {
      output = (output + chunk).slice(-4096);
      const match = output.match(/World server listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); port = Number(match[1]); url = 'http://127.0.0.1:' + port; resolve(); }
    });
    server.stderr.resume();
  });
}
async function stopServer() {
  const child = server; server = null;
  await stopServerProcess(child);
}
async function state(id = 'alice') {
  const response = await fetch(url + '/state', { headers: { Authorization: 'Bearer ' + tokens[id] }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function worldCommand(id, command) {
  const response = await fetch(url + '/command', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[id], 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function waitForState(predicate, description) {
  const deadline = Date.now() + 10000;
  let last;
  while (Date.now() < deadline) {
    const snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    last = snapshot.players.map(({ id, position, velocityY }) => ({ id, position, velocityY }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description + '; players=' + JSON.stringify(last));
}
async function connect(client) {
  const page = client.page;
  await page.locator('#settings-open').click();
  await page.locator('#server-url').fill(url);
  await page.locator('#token').fill(tokens[client.id]);
  await page.locator('#save-world').click();
  await page.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('saved'));
  await page.locator('#settings-close').click();
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('World connected'));
  await page.evaluate(() => document.activeElement?.blur());
  assert.equal(await page.locator('#role').textContent(), 'Role: builder');
}
async function launch(id) {
  const executable = process.env.TUS_SMOKE_EXECUTABLE;
  const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable) } : {}), args: [...(executable ? [] : ['.']), '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--tus-smoke-confirm-quit'], env: { ...process.env, TUS_DATA_DIR: path.join(dir, id) }, timeout: 30000 });
  const client = { id, app }; clients.push(client);
  client.page = await app.firstWindow();
  client.graphics = await observeGraphics(client.page, { label: id });
  await connect(client);
  return client;
}
async function focus(client) {
  await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await client.page.evaluate(() => document.activeElement?.blur());
  await client.page.waitForFunction(() => document.hasFocus() && !document.querySelector('#settings').open);
}
async function select(client, object) { await selectObject(client.page, object); }
async function projectPoint(page, position) {
  return page.evaluate(async value => {
    const THREE = await import('three');
    const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 220);
    camera.position.set(33, 28, 38); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const p = new THREE.Vector3(value.x, value.y, value.z).project(camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  }, position);
}
async function groundPoint(page, position) { return projectPoint(page, { ...position, y: 0 }); }
async function dragObjectTo(page, object, destination) {
  const start = await projectPoint(page, object.position), end = await groundPoint(page, destination);
  const geometry = await page.evaluate(({ start, end }) => {
    const canvas = document.querySelector('#viewport canvas');
    window.__tusDragTrace = { counts: {}, events: [], last: null };
    if (!canvas.dataset.tusDragTrace) {
      canvas.dataset.tusDragTrace = 'true';
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(type, event => {
        const trace = window.__tusDragTrace, count = trace.counts[type] = (trace.counts[type] || 0) + 1;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const sample = { type, x: Math.round(event.clientX), y: Math.round(event.clientY), target: target?.id || target?.tagName, canvasTarget: target === canvas, selected: document.querySelector('#selection-label')?.textContent, preview: document.querySelector('#move-preview-status')?.textContent, previewHidden: document.querySelector('#move-preview-status')?.hidden };
        trace.last = sample;
        if (type !== 'pointermove' || count <= 2 || count === 100) trace.events.push(sample);
      });
    }
    const at = point => { const target = document.elementFromPoint(point.x, point.y); return { x: Math.round(point.x), y: Math.round(point.y), target: target?.id || target?.tagName, canvasTarget: target === canvas }; };
    const rect = canvas.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, startTarget: at(start), endTarget: at(end) };
  }, { start, end });
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (let i = 1; i <= 100; i++) await page.mouse.move(start.x + (end.x - start.x) * i / 100, start.y + (end.y - start.y) * i / 100);
  await page.mouse.up();
  return { start, end, ...geometry };
}
async function waitForMovePreview(page, drag) {
  try { await page.waitForFunction(() => document.querySelector('#move-preview-status')?.textContent.toLowerCase().includes('preview'), undefined, { timeout: 5000 }); }
  catch {
    const state = await page.evaluate(() => ({
      selected: document.querySelector('#selection-label')?.textContent,
      role: document.querySelector('#role')?.textContent,
      editHidden: document.querySelector('#edit-form')?.hidden,
      editDisabled: document.querySelector('#edit-fields')?.disabled,
      editMessage: document.querySelector('#edit-message')?.textContent,
      preview: document.querySelector('#move-preview-status')?.textContent,
      previewHidden: document.querySelector('#move-preview-status')?.hidden,
      position: ['x', 'y', 'z'].map(axis => document.querySelector('#edit-position-' + axis)?.value),
      trace: window.__tusDragTrace,
    }));
    throw new Error('No local drag preview was created: ' + JSON.stringify({ drag, state }));
  }
}
async function close(client) {
  if (!client.app) return;
  const app = client.app; client.app = null;
  await closeSmokeApp(app, client.graphics, 'shared scenario complete');
}
await withSmokeCleanup(async () => {
  await startServer();
  const alice = await launch('alice'), bob = await launch('bob');
  await focus(alice);
  const ready = await waitForState(snapshot => ['alice', 'bob'].every(id => snapshot.players.some(player => player.id === id)), 'both clients to publish their initial position');
  await Promise.all(clients.map(client => client.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, ready.revision)));

  alice.graphics.phase('agent movement observed by both clients');
  const agentMove = await worldCommand('alice', { type: 'move', position: { x: 12, y: 1, z: 0 } });
  await alice.page.waitForFunction(() => document.querySelector('#coordinates').textContent === 'X 12.0 · Y 0.0 · Z 0.0');
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, agentMove.revision);
  const acceptedAgentPosition = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x === 12, 'the agent move to be visible in the shared state');

  await focus(alice);
  await alice.page.keyboard.down('d');
  let manualMove;
  try {
    manualMove = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x > acceptedAgentPosition.players.find(player => player.id === 'alice').position.x, 'manual movement to continue from the agent position');
  } finally {
    await alice.page.keyboard.up('d');
  }
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, manualMove.revision);
  const observedMove = (await state('bob')).players.find(player => player.id === 'alice');
  assert.ok(observedMove.position.x > 12, 'the second client sees Alice beyond the agent destination');
  assert.ok(Number((await alice.page.locator('#coordinates').textContent()).match(/X ([\d.-]+)/)?.[1]) > 12, 'the local GUI displays movement continuing from the agent destination');
  alice.graphics.phase('manual shared construction');
  await alice.page.locator('#build-x').fill('16');
  await alice.page.locator('#build-z').fill('0');
  await alice.page.locator('#build-form button').click();
  await alice.page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('placed'));
  const builtState = await state(), built = builtState.objects[0];
  assert.equal(built.ownerId, 'alice');
  assert.deepEqual(built.position, { x: 16, y: 1, z: 0 });

  alice.graphics.phase('collision and jump onto a walkable top');
  const blocked = await worldCommand('alice', { type: 'move', position: { x: 30, y: 999, z: 0 } });
  assert.ok(blocked.position.x < 14.7, 'the server stops Alice at the solid side');
  assert.equal(blocked.position.y, 0, 'client coordinates cannot grant unsupported height');
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, blocked.revision);
  await alice.page.waitForFunction(() => document.querySelector('#coordinates').textContent.includes('X 14.7'));
  await focus(alice);
  await alice.page.keyboard.down('a');
  await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x < 14.5, 'Alice to walk back from the solid side');
  await alice.page.keyboard.up('a');
  await alice.page.waitForTimeout(300);
  await focus(alice);
  await alice.page.keyboard.down('d');
  await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x >= 14.68, 'Alice to reach the solid face');
  await alice.page.keyboard.down('Space');
  await waitForState(snapshot => {
    const player = snapshot.players.find(item => item.id === 'alice');
    return player?.position.y > 0 && player.velocityY > 0;
  }, 'the server to accept the jump while Alice is ascending');
  await alice.page.keyboard.up('Space');
  await alice.page.waitForFunction(() => {
    const [xPart, yPart] = document.querySelector('#coordinates')?.textContent.split(' · ') ?? [];
    const x = Number(xPart?.slice(2)), y = Number(yPart?.slice(2));
    return x >= 15 && x <= 16.2 && y > 0;
  }, undefined, { polling: 'raf', timeout: 5000 });
  await alice.page.keyboard.up('d');
  const landed = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.y === 2, 'Alice to land on the supported object top');
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, landed.revision);
  assert.equal((await state('bob')).players.find(player => player.id === 'alice').position.y, 2, 'the second client observes the accepted height');
  await alice.page.waitForFunction(() => document.querySelector('#coordinates').textContent.includes('Y 2.0'), undefined, { timeout: 5000 });
  // Drag stays local until Apply; the second client must never see the preview.
  await focus(alice);
  await alice.page.keyboard.down('a');
  await waitForState(snapshot => {
    const player = snapshot.players.find(item => item.id === 'alice');
    return player?.position.y === 0 && player.position.x < 14;
  }, 'Alice to leave the platform before moving it');
  await alice.page.keyboard.up('a');
  const beforePreview = await state();
  await select(alice, built);
  const firstDrag = await dragObjectTo(alice.page, built, { x: 20, z: 0 });
  await waitForMovePreview(alice.page, firstDrag);
  const previewState = await state();
  assert.equal(previewState.revision, beforePreview.revision, 'pointer movement and preview do not mutate the server');
  assert.deepEqual(previewState.objects, beforePreview.objects);
  assert.equal(await bob.page.locator('#move-preview-status').isHidden(), true, 'the peer does not receive the local preview');
  await alice.page.evaluate(() => {
    window.__tusEscapeEvent = null;
    window.addEventListener('keydown', event => { if (event.code === 'Escape') window.__tusEscapeEvent = event; }, { capture: true, once: true });
  });
  await focus(alice);
  await alice.page.keyboard.press('Escape');
  try { await alice.page.waitForFunction(() => document.querySelector('#move-preview-status')?.hidden, undefined, { timeout: 5000 }); }
  catch {
    const escapeState = await alice.page.evaluate(() => ({
      event: window.__tusEscapeEvent && { code: window.__tusEscapeEvent.code, defaultPrevented: window.__tusEscapeEvent.defaultPrevented },
      hasFocus: document.hasFocus(),
      activeElement: document.activeElement?.id || document.activeElement?.tagName,
      preview: document.querySelector('#move-preview-status')?.textContent,
      previewHidden: document.querySelector('#move-preview-status')?.hidden,
    }));
    throw new Error('Escape did not cancel local preview: ' + JSON.stringify(escapeState));
  }
  assert.equal((await state()).revision, beforePreview.revision, 'Cancel discards only the local proposal');

  const secondDrag = await dragObjectTo(alice.page, built, { x: 20, z: 0 });
  await waitForMovePreview(alice.page, secondDrag);
  assert.equal((await state()).revision, beforePreview.revision);
  await alice.page.locator('#edit-apply').click();
  await alice.page.waitForFunction(() => document.querySelector('#edit-message').textContent.includes('saved'));
  const movedState = await state();
  const movedObject = movedState.objects.find(item => item.id === built.id);
  assert.deepEqual(movedObject.position, { x: 20, y: 1, z: 0 });
  assert.equal(movedState.revision, beforePreview.revision + 1, 'Apply commits exactly one update');
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, movedState.revision);
  built.position = movedObject.position;

  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, builtState.revision);
  await select(alice, built); await select(bob, built);
  assert.equal(await bob.page.locator('#edit-apply').isDisabled(), true, 'foreign object is read-only');
  assert.equal(await bob.page.locator('#remove').isDisabled(), true, 'foreign removal is disabled');
  await alice.page.locator('#edit-size-x').fill('5');
  await alice.page.locator('#edit-apply').click();
  await alice.page.waitForFunction(() => document.querySelector('#edit-message').textContent.includes('saved'));
  await bob.page.waitForFunction(() => document.querySelector('#edit-size-x').value === '5');
  assert.equal((await state('bob')).objects[0].size.x, 5);
  const denied = await fetch(url + '/command', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.bob, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'remove', id: built.id }) });
  assert.equal(denied.status, 403, 'server rejects bypassing the disabled UI');
  assert.equal((await state()).objects[0].id, built.id);

  for (const client of clients) { client.graphics.phase('server restart'); await client.graphics.assertHealthy(); }
  await stopServer();
  for (const client of clients) await client.page.waitForFunction(() => document.querySelector('#connection').textContent.includes('offline'));
  await startServer();
  for (const client of clients) await client.page.waitForFunction(() => document.querySelector('#connection').textContent.includes('World connected'));
  const restored = await state('bob');
  assert.equal(restored.objects[0].id, built.id); assert.equal(restored.objects[0].size.x, 5);
  assert.equal(restored.players.find(player => player.id === 'alice').position.y, 2, 'server restart preserves the landing surface position');
  assert.deepEqual(restored.players.map(p => p.id).sort(), ['alice', 'bob']);
  await close(bob);
  const returning = await launch('bob');
  await returning.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, restored.revision);
  await select(returning, restored.objects[0]);
  assert.equal(await returning.page.locator('#edit-size-x').inputValue(), '5');

  alice.graphics.phase('manual removal');
  await alice.page.locator('#remove').click();
  await alice.page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('removed'));
  await returning.page.waitForFunction(() => document.querySelector('#selection-label').textContent === 'No shape selected');
  assert.equal((await state('bob')).objects.length, 0);
  for (const id of ['alice', 'bob']) {
    const settings = JSON.parse(await readFile(path.join(dir, id, 'settings.json'), 'utf8'));
    assert.equal(Object.hasOwn(settings, 'token'), false);
  }
  console.log('Shared-world acceptance passed: two real clients, UI build/select/edit/remove, owner permissions, server and client restart, shared persistence.');
}, ...[() => Promise.allSettled(clients.map(close)).then(results => {
  const failures = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (failures.length) throw new AggregateError(failures, 'Client cleanup failed');
}), () => stopServer(), () => rm(dir, { recursive: true, force: true })]);
