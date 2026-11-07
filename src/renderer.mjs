import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const bridge = window.tus;
let settings = { serverUrl: 'http://127.0.0.1:4317', token: '' };
let selectedKind = 'block', selectedId = null, worldRevision = -1, connected = false, busy = false;
let settingsGeneration = 0;
let pollRunning = false, moveRunning = false, playerPosition = { x: 0, y: 1, z: 0 }, meId = null;
let scene, renderer, camera, controls, player, companion, selectionBox;
let objectSnapshot = '';
const meshes = new Map(), otherPlayers = new Map(), keys = new Set();
const sceneRoot = new THREE.Group();
const clock = new THREE.Clock();
const feedback = (text, error = false) => { $('world-message').textContent = text; $('world-message').classList.toggle('error', error); };
function addMessage(text, kind = 'system') {
  const article = document.createElement('article'); article.className = `chat-message ${kind}`;
  article.textContent = text; $('chat').append(article); $('chat').scrollTop = $('chat').scrollHeight; return article;
}
function updateChatControls() {
  $('send').disabled = !connected || busy; $('prompt').disabled = !connected;
  $('interrupt').disabled = !connected || !busy;
}
function request(path, method = 'GET', body) {
  return bridge.request({ serverUrl: settings.serverUrl, token: settings.token, path, method, body });
}
function avatar(color) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, roughness: .8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.32, .55, 4, 8), material); body.position.y = .67; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(.26, 12, 10), material); head.position.y = 1.35; head.castShadow = true;
  group.add(body, head); return group;
}
function initScene() {
  scene = new THREE.Scene(); scene.background = new THREE.Color('#93b1b2'); scene.fog = new THREE.Fog('#93b1b2', 70, 150);
  camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 220); camera.position.set(33, 28, 38);
  renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('viewport').append(renderer.domElement); controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 0, 0); controls.maxPolarAngle = Math.PI / 2.1; controls.minDistance = 8; controls.maxDistance = 100; controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight('#fff9df', '#4e7472', 2.6));
  const sun = new THREE.DirectionalLight('#ffe0a5', 3.1); sun.position.set(-20, 38, 18); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -45; sun.shadow.camera.right = 45; sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45; sun.shadow.normalBias = .04; scene.add(sun);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ color: '#628d97', roughness: .3, metalness: .16 })); water.rotation.x = -Math.PI / 2; water.position.y = -1.1; water.receiveShadow = true; scene.add(water);
  const island = new THREE.Mesh(new THREE.BoxGeometry(48, 1.5, 48), new THREE.MeshStandardMaterial({ color: '#a9bca6', roughness: 1 })); island.position.y = -.85; island.receiveShadow = true; scene.add(island);
  const grid = new THREE.GridHelper(48, 24, '#738f7f', '#91aa95'); grid.position.y = -.08; grid.material.opacity = .45; grid.material.transparent = true; scene.add(grid);
  // The island is decoration. Authoritative object positions come only from the server.
  scene.add(sceneRoot); player = avatar('#f2e7cf'); scene.add(player);
  companion = new THREE.Mesh(new THREE.OctahedronGeometry(.46), new THREE.MeshStandardMaterial({ color: '#efbd61', roughness: .35, metalness: .3 })); companion.castShadow = true; scene.add(companion);
  renderer.domElement.addEventListener('pointerdown', event => { renderer.domElement.dataset.startX = event.clientX; renderer.domElement.dataset.startY = event.clientY; });
  renderer.domElement.addEventListener('pointerup', event => {
    if (Math.hypot(event.clientX - Number(renderer.domElement.dataset.startX), event.clientY - Number(renderer.domElement.dataset.startY)) > 5) return;
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(event.clientX / innerWidth * 2 - 1, -(event.clientY / innerHeight) * 2 + 1), camera);
    const hit = ray.intersectObjects([...meshes.values()], true)[0]; let object = hit?.object;
    while (object && !object.userData.worldId) object = object.parent;
    selectObject(object?.userData.worldId ?? null);
  });
  window.addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), .05), typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || $('settings').open;
    if (!typing) {
      let x = Number(keys.has('d')) - Number(keys.has('a')), z = Number(keys.has('s')) - Number(keys.has('w'));
      const length = Math.hypot(x, z); if (length) { x /= length; z /= length; playerPosition.x = Math.max(-99, Math.min(99, playerPosition.x + x * dt * 5)); playerPosition.z = Math.max(-99, Math.min(99, playerPosition.z + z * dt * 5)); }
    }
    player.position.set(playerPosition.x, 0, playerPosition.z);
    companion.position.lerp(new THREE.Vector3(playerPosition.x + 1.5, 1.7 + Math.sin(performance.now() / 700) * .12, playerPosition.z + 1.2), .05); companion.rotation.y += dt * .4;
    $('coordinates').textContent = `X ${playerPosition.x.toFixed(1)} · Z ${playerPosition.z.toFixed(1)}`;
    controls.update(); renderer.render(scene, camera);
  });
}
function objectMesh(object) {
  const group = new THREE.Group(); group.userData.worldId = object.id;
  const { x, y, z } = object.size;
  const material = new THREE.MeshStandardMaterial({ color: object.color, roughness: .85 });
  const addBox = (w, h, d, px, py, pz, mat = material) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); mesh.position.set(px, py, pz); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); };
  addBox(x, y, z, 0, 0, 0);
  if (object.type === 'bridge') {
    const rail = new THREE.MeshStandardMaterial({ color: '#615950', roughness: .8 });
    addBox(x, .18, .15, 0, y / 2 + .65, z / 2 - .15, rail); addBox(x, .18, .15, 0, y / 2 + .65, -z / 2 + .15, rail);
  }
  if (object.type === 'port') {
    const pole = new THREE.MeshStandardMaterial({ color: '#5b6259' });
    addBox(.18, 3, .18, -x / 2 + .6, y / 2 + 1.5, -z / 2 + .6, pole);
    addBox(1.2, .7, .06, -x / 2 + 1.2, y / 2 + 2.5, -z / 2 + .6, new THREE.MeshStandardMaterial({ color: '#eac16c' }));
  }
  group.position.set(object.position.x, object.position.y, object.position.z); return group;
}
function disposeGroup(group) { group.traverse(child => { child.geometry?.dispose(); if (child.material) child.material.dispose(); }); }
function selectObject(id) {
  selectedId = id;
  if (selectionBox) { scene.remove(selectionBox); selectionBox.geometry.dispose(); selectionBox.material.dispose(); selectionBox = null; }
  if (id && meshes.has(id)) { selectionBox = new THREE.BoxHelper(meshes.get(id), '#ffe5a1'); scene.add(selectionBox); }
  $('selection-label').textContent = id ? `Shape ${id.slice(0, 12)}` : 'No shape selected'; $('remove').disabled = !id;
}
function renderWorld(state) {
  if (meId !== state.me.id) { const savedPlayer = state.players.find(p => p.id === state.me.id); if (savedPlayer) playerPosition = { ...savedPlayer.position }; }
  meId = state.me.id; $('role').textContent = `Role: ${state.me.role}`; $('revision').textContent = `REV ${state.revision}`;
  const nextSnapshot = JSON.stringify(state.objects);
  if (objectSnapshot !== nextSnapshot) {
    for (const mesh of meshes.values()) { sceneRoot.remove(mesh); disposeGroup(mesh); } meshes.clear();
    for (const object of state.objects) { const mesh = objectMesh(object); meshes.set(object.id, mesh); sceneRoot.add(mesh); }
    selectObject(meshes.has(selectedId) ? selectedId : null); worldRevision = state.revision; objectSnapshot = nextSnapshot;
  }
  const live = new Set();
  for (const remote of state.players) {
    if (remote.id === meId) continue; live.add(remote.id);
    if (!otherPlayers.has(remote.id)) { const mesh = avatar('#8ba5c0'); otherPlayers.set(remote.id, mesh); scene.add(mesh); }
    otherPlayers.get(remote.id).position.set(remote.position.x, 0, remote.position.z);
  }
  for (const [id, mesh] of otherPlayers) if (!live.has(id)) { scene.remove(mesh); disposeGroup(mesh); otherPlayers.delete(id); }
}
async function poll() {
  if (pollRunning || !bridge) return; pollRunning = true;
  const generation = settingsGeneration;
  try { const state = await request('/state'); if (generation !== settingsGeneration) return; if (state.error) throw new Error(state.message || state.error); if (scene) renderWorld(state); $('connection').textContent = '● World connected'; $('connection').classList.remove('offline'); }
  catch (error) { if (generation !== settingsGeneration) return; $('connection').textContent = '○ World offline'; $('connection').classList.add('offline'); feedback(error.message, true); }
  finally { pollRunning = false; }
}
let lastPosition = '';
async function syncPosition() {
  const key = `${playerPosition.x.toFixed(2)},${playerPosition.z.toFixed(2)}`;
  if (moveRunning || key === lastPosition || !meId || !bridge) return; moveRunning = true;
  try { const result = await request('/command', 'POST', { type: 'move', position: { ...playerPosition } }); if (!result.error) lastPosition = key; }
  catch { /* The status poll reports connectivity failures. */ } finally { moveRunning = false; }
}
async function command(body) { const result = await request('/command', 'POST', body); if (result.error) throw new Error(result.message || result.error); await poll(); return result; }

for (const button of document.querySelectorAll('[data-kind]')) button.addEventListener('click', () => { selectedKind = button.dataset.kind; document.querySelectorAll('[data-kind]').forEach(el => el.classList.toggle('selected', el === button)); });
$('build-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { await command({ type: 'build', objectType: selectedKind, position: { x: Number($('build-x').value), y: selectedKind === 'block' ? 1 : .5, z: Number($('build-z').value) } }); feedback(`${selectedKind[0].toUpperCase() + selectedKind.slice(1)} placed in the shared world.`); } catch (error) { feedback(error.message, true); } finally { button.disabled = false; } });
$('remove').addEventListener('click', async () => { if (!selectedId) return; const id = selectedId; $('remove').disabled = true; try { await command({ type: 'remove', id }); feedback('Shape removed.'); } catch (error) { feedback(error.message, true); } finally { $('remove').disabled = !selectedId; } });
window.addEventListener('keydown', event => { if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) keys.add(event.key.toLowerCase()); });
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase())); window.addEventListener('blur', () => keys.clear());
$('settings-open').addEventListener('click', () => $('settings').showModal()); $('settings-close').addEventListener('click', () => $('settings').close());
function readSettings() { return { ...settings, workspacePath: $('workspace').value.trim(), codexPath: $('codex').value.trim(), serverUrl: $('server-url').value.trim(), token: $('token').value }; }
async function saveSettings() {
  const next = readSettings();
  const changed = ['workspacePath', 'codexPath', 'serverUrl', 'token'].some(key => next[key] !== settings[key]);
  if (next.workspacePath !== settings.workspacePath) next.threadId = '';
  if (changed) {
    await bridge.disconnectCodex(); connected = false; busy = false; updateChatControls();
    $('agent-status').textContent = 'Settings changed · reconnect Codex';
  }
  settings = next; settingsGeneration++;
  const { token, ...persisted } = settings; await bridge.saveSettings(persisted);
  worldRevision = -1; objectSnapshot = ''; meId = null; lastPosition = '';
  if (scene) { selectObject(null); for (const mesh of meshes.values()) { sceneRoot.remove(mesh); disposeGroup(mesh); } meshes.clear(); for (const mesh of otherPlayers.values()) { scene.remove(mesh); disposeGroup(mesh); } otherPlayers.clear(); }
  await poll();
}
$('save-world').addEventListener('click', async () => { try { await saveSettings(); $('settings-message').textContent = 'World settings saved. Access token is kept only for this session.'; } catch (error) { $('settings-message').textContent = error.message; } });
$('settings-form').addEventListener('submit', async event => { event.preventDefault(); $('connect').disabled = true; $('settings-message').textContent = 'Connecting to your Codex app-server…'; try { await saveSettings(); const result = await bridge.connectCodex({ ...settings, newGameThread: $('new-game-thread').checked }); settings.threadId = result.threadId; $('new-game-thread').checked = false; const { token, ...persisted } = settings; await bridge.saveSettings(persisted); connected = true; $('agent-status').textContent = 'Ready · responds only when asked'; updateChatControls(); $('settings').close(); addMessage('Connected to your Codex workspace. No request has been sent.'); } catch (error) { $('settings-message').textContent = error.message; } finally { $('connect').disabled = false; } });
let streamMessage = null;
$('chat-form').addEventListener('submit', async event => { event.preventDefault(); const text = $('prompt').value.trim(); if (!text || !connected || busy) return; busy = true; updateChatControls(); addMessage(text, 'user'); $('prompt').value = ''; streamMessage = null; try { await bridge.sendPrompt(text); } catch (error) { addMessage(error.message, 'error'); busy = false; updateChatControls(); } });
$('interrupt').addEventListener('click', async () => { $('interrupt').disabled = true; try { await bridge.interrupt(); } catch (error) { addMessage(error.message, 'error'); $('interrupt').disabled = !busy; } });
function codexEvent(event) {
  if (event.type === 'connected') { connected = true; settings.threadId = event.threadId; $('agent-status').textContent = 'Ready · responds only when asked'; }
  if (event.type === 'error') addMessage(event.message || 'Codex reported an error.', 'error');
  if (event.type === 'disconnected') { connected = false; busy = false; $('agent-status').textContent = 'Codex disconnected'; addMessage(event.message || 'Codex disconnected.', 'error'); }
  if (event.type === 'approval') {
    const entry = addMessage(`Codex requests approval: ${event.method}. This preview cannot grant elevated permissions.`, 'system');
    const denial = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(event.method) ? { decision: 'decline' } : event.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : null;
    if (denial) {
      const button = document.createElement('button'); button.textContent = 'Deny request';
      button.addEventListener('click', async () => { button.disabled = true; try { await bridge.respond(event.id, denial); button.textContent = 'Denied'; } catch (error) { button.disabled = false; addMessage(error.message, 'error'); } });
      entry.append(document.createElement('br'), button);
    } else addMessage('Stop this turn to decline the pending request. No approval was granted.');
  }
  if (event.type === 'notification') {
    const p = event.params || {};
    if (event.method === 'turn/started') { busy = true; $('agent-status').textContent = 'Working on your request…'; }
    if (event.method === 'item/agentMessage/delta') { if (!streamMessage) streamMessage = addMessage('', 'assistant'); streamMessage.textContent += p.delta || ''; $('chat').scrollTop = $('chat').scrollHeight; }
    if (event.method === 'item/completed' && p.item?.type === 'agentMessage') { if (streamMessage) streamMessage.textContent = p.item.text || streamMessage.textContent; else if (p.item.text) addMessage(p.item.text, 'assistant'); streamMessage = null; }
    if (event.method === 'turn/completed') { busy = false; $('agent-status').textContent = 'Ready · responds only when asked'; if (p.turn?.error?.message) addMessage(p.turn.error.message, 'error'); }
    if (event.method === 'error') addMessage(p.error?.message || p.message || 'Codex reported an error.', 'error');
  }
  updateChatControls();
}
try { initScene(); } catch (error) { $('scene-error').hidden = false; $('scene-error').textContent = `3D rendering unavailable: ${error.message}. Check hardware acceleration and restart.`; }
if (!bridge) { feedback('Open this app through its desktop launcher.', true); $('settings-open').disabled = true; }
else {
  try { const saved = await bridge.loadSettings(); settings = { ...settings, ...saved }; $('workspace').value = settings.workspacePath || ''; $('codex').value = settings.codexPath || ''; $('server-url').value = settings.serverUrl; if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(settings.serverUrl)) settings.token = ''; $('token').value = settings.token; } catch (error) { feedback(error.message, true); }
  bridge.onCodexEvent(codexEvent); await poll(); setInterval(poll, 1000); setInterval(syncPosition, 250);
}
