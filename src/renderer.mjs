import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { movePlayer, WALK_SPEED, WORLD_SIZE } from './movement.mjs';
import { placementPosition, positionUpdateCommand } from './placement.mjs';

const $ = id => document.getElementById(id);
const bridge = window.tus;
let isFullscreen = false;
let settings = { serverUrl: 'http://127.0.0.1:4317', token: '' };
let selectedKind = 'block', selectedId = null, worldRevision = -1, connected = false, busy = false;
let settingsGeneration = 0, ordinaryTurn = false;
let agentControlState = null, agentControlRead = 0, agentControlLoading = false, agentControlBusy = false, goalMessageContextId = null;
let pollRunning = false, moveRunning = false, playerPosition = { x: 0, y: 0, z: 0 }, playerVelocityY = 0, jumpRequested = false, meId = null, localMovementVersion = 0, latestStateRevision = -1;
let worldState = { objects: [] };
let scene, renderer, camera, controls, player, companion;
let dragCandidate = null, movePreview = null, boxCandidate = null, boxSelectMode = false;
const selectedIds = new Set(), selectionBoxes = new Map(), MAX_GROUP_SELECTION = 32;
let objectSnapshot = '';
let inspectorBase = null, inspectorDirty = false, editing = false, role = 'viewer';
const objectData = new Map();
const meshes = new Map(), otherPlayers = new Map(), keys = new Set();
const sceneRoot = new THREE.Group();
const clock = new THREE.Clock();
const feedback = (text, error = false) => { $('world-message').textContent = text; $('world-message').classList.toggle('error', error); };
async function showBuildIdentity() {
  const label = $('build-version');
  try {
    const info = await bridge?.getBuildInfo();
    if (!info || typeof info.version !== 'string') throw new Error('Build metadata is unavailable.');
    const sourceSha = /^[a-f0-9]{40}$/.test(info.sourceSha || '') ? info.sourceSha : null;
    label.textContent = `v${info.version} · ${sourceSha ? sourceSha.slice(0, 7) : 'build unknown'}`;
    label.title = sourceSha
      ? `Version ${info.version}; source SHA ${sourceSha}`
      : `Version ${info.version}; source SHA unavailable. This build is not release-identified.`;
  } catch {
    label.textContent = 'Build unknown';
    label.title = 'Build metadata unavailable. This build is not release-identified.';
  }
}
void showBuildIdentity();
function addMessage(text, kind = 'system') {
  const article = document.createElement('article'); article.className = `chat-message ${kind}`;
  if (kind === 'goal') { const label = document.createElement('small'); label.className = 'goal-message-label'; label.textContent = 'Goal update'; const body = document.createElement('span'); body.className = 'chat-message-body'; body.textContent = text; article.append(label, body); }
  else article.textContent = text;
  $('chat').append(article); $('chat').scrollTop = $('chat').scrollHeight; return article;
}
function updateChatControls() {
  $('send').disabled = !connected || busy; $('prompt').disabled = !connected;
  $('interrupt').disabled = !connected || !busy;
}
function refreshAgentStatus() {
  const goalActive = agentControlState?.goal?.status === 'active' || Boolean(goalMessageContextId);
  const status = !connected ? 'Codex disconnected'
    : busy ? (goalActive ? 'Codex turn in progress' : 'Working on your request…')
    : agentControlState?.pendingApprovals ? 'Waiting for an approval decision'
    : agentControlState?.goal?.status === 'active' ? 'Native Goal active'
    : agentControlState?.goal?.status === 'paused' ? 'Native Goal paused'
    : agentControlState?.threadStatus === 'idle' ? 'Connected · idle'
    : agentControlState?.threadStatus === 'systemError' ? 'Codex reported an error'
    : 'Connected · activity unknown';
  $('agent-status').textContent = status;
}
function updateAgentControlButtons() {
  const state = agentControlState, live = connected && state?.connected === true && state.threadId === settings.threadId;
  const goal = state?.goal, canChangeGoal = live && state.goalSupported === true && !agentControlBusy && !agentControlLoading;
  $('goal-create').disabled = !canChangeGoal || Boolean(goal) || !$('goal-objective-input').value.trim() || !$('goal-criteria-input').value.trim() || !$('goal-confirm-start').checked;
  $('goal-pause').disabled = !canChangeGoal || goal?.status !== 'active';
  $('goal-resume').disabled = !canChangeGoal || goal?.status !== 'paused';
  $('goal-clear').disabled = !canChangeGoal || !goal;
  $('goal-stop-turn').disabled = !live || !state.turnId;
  const hasModels = live && state.models.length > 0;
  $('agent-model').disabled = !hasModels || agentControlBusy || agentControlLoading;
  $('agent-effort').disabled = !hasModels || !$('agent-model').value || agentControlBusy || agentControlLoading;
  $('agent-model-save').disabled = !hasModels || agentControlBusy || agentControlLoading;
}
function populateAgentEfforts(modelId, selected = '') {
  const model = agentControlState?.models.find(item => item.id === modelId);
  const select = $('agent-effort'); select.replaceChildren();
  const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Codex default'; select.append(defaultOption);
  for (const effort of model?.efforts ?? []) { const option = document.createElement('option'); option.value = effort; option.textContent = effort; select.append(option); }
  select.value = (model?.efforts ?? []).includes(selected) ? selected : '';
}
function renderAgentControls(state) {
  agentControlState = state;
  const goal = state.goal;
  $('agent-controls-context').textContent = `World: ${$('connection').textContent.trim()} · ${$('role').textContent} · Codex conversation ${state.threadId}`;
  $('agent-controls-status').textContent = state.pendingApprovals ? 'Waiting for an approval decision.' : state.turnId || state.threadStatus === 'active' ? 'Codex is working in this conversation.' : state.threadStatus === 'idle' ? 'Codex is idle.' : state.threadStatus === 'systemError' ? 'Codex reported a conversation error.' : 'Codex status is unknown.';
  $('agent-controls-runtime').textContent = state.runtime ? `${state.runtime.name || 'Codex'} ${state.runtime.version || 'version unknown'}` : 'Runtime version unknown';
  $('agent-controls-thread').textContent = state.threadId;
  $('agent-controls-turn').textContent = state.pendingApprovals ? 'Approval pending' : state.turnId ? 'Running' : state.threadStatus === 'idle' ? 'Idle' : state.threadStatus === 'active' ? 'Active; turn not identified' : 'Unknown';
  $('agent-controls-current-model').textContent = state.currentModel ? `${state.currentModel}${state.currentEffort ? ' · ' + state.currentEffort : ''}` : 'Codex did not report it';
  $('goal-support-status').textContent = state.goalSupported === true ? 'Native Goals are supported by this Codex conversation.' : state.goalSupported === false ? state.goalReason : 'Native Goal support could not be confirmed; actions are disabled.';
  $('active-goal').hidden = !goal; $('goal-status').textContent = goal ? `Native Goal · ${goal.status}` : ''; $('goal-objective').textContent = goal?.objective ?? '';
  $('agent-goal-summary').hidden = !goal || goal.status !== 'active'; $('agent-goal-summary-status').textContent = goal ? `Native Goal · ${goal.status}` : ''; $('agent-goal-summary-text').textContent = goal?.objective ?? '';
  if (goal?.status === 'active') goalMessageContextId = goal.id || state.threadId;
  else if (!busy) goalMessageContextId = null;
  const models = state.models;
  $('agent-model').replaceChildren();
  const defaultModel = document.createElement('option'); defaultModel.value = ''; defaultModel.textContent = 'Use Codex default'; $('agent-model').append(defaultModel);
  for (const model of models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name; $('agent-model').append(option); }
  const savedModel = settings.agentControlThreadId === state.threadId ? settings.agentModelId : '';
  $('agent-model').value = models.some(model => model.id === savedModel) ? savedModel : '';
  populateAgentEfforts($('agent-model').value, settings.agentControlThreadId === state.threadId ? settings.agentEffort : '');
  updateAgentControlButtons();
  refreshAgentStatus();
}
async function refreshAgentControls() {
  const requestId = ++agentControlRead, threadId = settings.threadId;
  if (!connected || !threadId) {
    agentControlState = null; refreshAgentStatus(); $('agent-controls-status').textContent = 'Codex is disconnected.';
    $('agent-controls-context').textContent = `World: ${$('connection').textContent.trim()} · ${$('role').textContent} · No Codex conversation`;
    $('agent-controls-runtime').textContent = 'Unknown'; $('agent-controls-thread').textContent = 'Unknown'; $('agent-controls-turn').textContent = 'Unknown'; $('agent-controls-current-model').textContent = 'Unknown';
    $('goal-support-status').textContent = 'Connect Codex to check native Goal support.';
    $('active-goal').hidden = true; $('agent-goal-summary').hidden = true; $('agent-goal-summary-text').textContent = ''; $('agent-model').replaceChildren(); const option = document.createElement('option'); option.value = ''; option.textContent = 'Connect Codex to load models'; $('agent-model').append(option); populateAgentEfforts('', '');
    updateAgentControlButtons(); return;
  }
  agentControlLoading = true; $('agent-controls-status').textContent = 'Reading current Codex state…'; updateAgentControlButtons();
  try {
    const state = await bridge.readAgentControls(threadId);
    if (requestId !== agentControlRead || !connected || settings.threadId !== threadId) return;
    if (!state?.connected || state.threadId !== threadId) throw new Error('Codex conversation changed; refresh agent controls.');
    renderAgentControls(state);
  } catch (error) {
    if (requestId !== agentControlRead || !connected || settings.threadId !== threadId) return;
    agentControlState = null; refreshAgentStatus(); $('agent-controls-status').textContent = 'Codex is connected, but its current state is unknown.';
    $('goal-support-status').textContent = error.message; updateAgentControlButtons();
  } finally {
    if (requestId === agentControlRead) { agentControlLoading = false; updateAgentControlButtons(); }
  }
}
async function runGoalAction(action, acceptedMessage) {
  const threadId = settings.threadId;
  if (!connected || !threadId || agentControlBusy) return;
  agentControlBusy = true; $('agent-controls-message').textContent = ''; updateAgentControlButtons();
  try {
    const result = await action(threadId);
    if (!connected || settings.threadId !== threadId) throw new Error('Codex conversation changed; refresh agent controls.');
    $('agent-controls-message').textContent = result ? acceptedMessage : 'Codex accepted the command without returning Goal state; checking the conversation.';
    await refreshAgentControls();
  } catch (error) { $('agent-controls-message').textContent = error.message; }
  finally { agentControlBusy = false; updateAgentControlButtons(); }
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
  const island = new THREE.Mesh(new THREE.BoxGeometry(WORLD_SIZE, 1.5, WORLD_SIZE), new THREE.MeshStandardMaterial({ color: '#a9bca6', roughness: 1 })); island.position.y = -.85; island.receiveShadow = true; scene.add(island);
  const grid = new THREE.GridHelper(WORLD_SIZE, WORLD_SIZE / 2, '#738f7f', '#91aa95'); grid.position.y = -.08; grid.material.opacity = .45; grid.material.transparent = true; scene.add(grid);
  // The island is decoration. Authoritative object positions come only from the server.
  scene.add(sceneRoot); player = avatar('#f2e7cf'); scene.add(player);
  companion = new THREE.Mesh(new THREE.OctahedronGeometry(.46), new THREE.MeshStandardMaterial({ color: '#efbd61', roughness: .35, metalness: .3 })); companion.castShadow = true; scene.add(companion);
  renderer.domElement.addEventListener('pointerdown', beginObjectDrag);
  renderer.domElement.addEventListener('pointermove', updateObjectDrag);
  renderer.domElement.addEventListener('pointerup', finishObjectDrag);
  renderer.domElement.addEventListener('pointercancel', event => {
    if (boxCandidate?.pointerId === event.pointerId) { cancelBoxSelection(); return; }
    if (dragCandidate?.pointerId !== event.pointerId) return;
    const draft = dragCandidate; dragCandidate = null; controls.enabled = !boxSelectMode;
    if (draft.started && draft.previewPosition) movePreview = draft;
    else { clearMovePreview(); }
  });
  window.addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), .25), typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || Boolean(document.querySelector('dialog[open]'));
    let x = typing ? 0 : Number(keys.has('d')) - Number(keys.has('a'));
    let z = typing ? 0 : Number(keys.has('s')) - Number(keys.has('w'));
    const length = Math.hypot(x, z);
    if (length) { x /= length; z /= length; }
    const target = {
      x: playerPosition.x + x * dt * WALK_SPEED,
      y: playerPosition.y,
      z: playerPosition.z + z * dt * WALK_SPEED,
    };
    const moved = movePlayer(worldState,{position:playerPosition,velocityY:playerVelocityY},{position:target,jump:jumpRequested},dt);
    if (moved.position.x !== playerPosition.x || moved.position.y !== playerPosition.y || moved.position.z !== playerPosition.z || moved.velocityY !== playerVelocityY) {
      playerPosition = moved.position; playerVelocityY = moved.velocityY; localMovementVersion++;
    }
    player.position.set(playerPosition.x, playerPosition.y, playerPosition.z);
    companion.position.lerp(new THREE.Vector3(playerPosition.x + 1.5, playerPosition.y + 1.7 + Math.sin(performance.now() / 700) * .12, playerPosition.z + 1.2), .05); companion.rotation.y += dt * .4;
    $('coordinates').textContent = `X ${playerPosition.x.toFixed(1)} · Y ${playerPosition.y.toFixed(1)} · Z ${playerPosition.z.toFixed(1)}`;
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
function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, camera); return ray;
}
function objectIdForHit(object) {
  while (object && !object.userData.worldId) object = object.parent;
  return object?.userData.worldId ?? null;
}
function canEditObject(object) {
  return Boolean(object && (role === 'admin' || (role === 'builder' && object.ownerId === meId)));
}
function placementHit(event, draft) {
  const ray = pointerRay(event); if (!ray) return null;
  const origin = draft.object.position;
  if (['x', 'y', 'z'].includes(draft.plane)) {
    const axis = draft.plane === 'x' ? new THREE.Vector3(1, 0, 0) : draft.plane === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const offset = ray.ray.origin.clone().sub(new THREE.Vector3(origin.x, origin.y, origin.z));
    const dot = axis.dot(ray.ray.direction), denominator = 1 - dot * dot;
    if (denominator < 1e-6) return null;
    const distance = (axis.dot(offset) - dot * ray.ray.direction.dot(offset)) / denominator;
    if (dot * distance - ray.ray.direction.dot(offset) < 0) return null;
    const point = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(axis, distance);
    return { point, surface: null };
  }
  const plane = draft.plane === 'xy'
    ? new THREE.Plane(new THREE.Vector3(0, 0, 1), -origin.z)
    : draft.plane === 'yz'
      ? new THREE.Plane(new THREE.Vector3(1, 0, 0), -origin.x)
      : new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const point = ray.ray.intersectPlane(plane, new THREE.Vector3());
  const target = point ? { point, surface: null } : null;
  if (!target || draft.plane !== 'xz') return target;
  const moving = new Set((draft.objects ?? []).map(object => object.id));
  const surfaces = [...meshes.entries()].filter(([id]) => id !== draft.objectId && !moving.has(id)).map(([, mesh]) => mesh);
  for (const hit of ray.intersectObjects(surfaces, true)) {
    const id = objectIdForHit(hit.object), surface = objectData.get(id);
    if (!surface?.supportsPlayer || meshes.get(id)?.children[0] !== hit.object) continue;
    const normal = hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld);
    if (normal?.y > .9) return { point: hit.point, surface };
  }
  return target;
}
function clearMovePreview() {
  for (const draft of [dragCandidate, movePreview]) {
    const ghosts = draft?.ghosts ? [...draft.ghosts.values()] : draft?.ghost ? [draft.ghost] : [];
    for (const ghost of ghosts) { scene?.remove(ghost); disposeGroup(ghost); }
  }
  dragCandidate = null; movePreview = null;
  if (controls) controls.enabled = !boxSelectMode;
  $('move-preview-status').hidden = true; $('move-preview-status').textContent = '';
  $('move-cancel').hidden = true; $('group-move-apply').disabled = true;
  $('move-plane').disabled = false;
}
function cancelMovePreview() {
  const draft = movePreview ?? dragCandidate, id = draft?.objectId;
  clearMovePreview();
  if (id && selectedIds.size === 1 && id === selectedId) fillInspector(objectData.get(id));
  $('group-move-status').textContent = 'Move preview cancelled; the shared world was not changed.';
}
function setMovePreviewPosition(draft, target) {
  const step = $('move-snap-enabled').checked ? Number($('move-grid-step').value) : 0;
  if ($('move-snap-enabled').checked && (!Number.isFinite(step) || step < .25 || step > 10)) {
    $('move-preview-status').textContent = 'Grid step must be between 0.25 and 10.';
    return;
  }
  const anchor = placementPosition(target.point, draft.object, target.surface, step, draft.plane);
  const delta = { x:anchor.x-draft.object.position.x, y:anchor.y-draft.object.position.y, z:anchor.z-draft.object.position.z };
  const objects = draft.objects?.length ? draft.objects : [draft.object];
  draft.target = { point: { x: target.point.x, y: target.point.y, z: target.point.z }, surfaceId: target.surface?.id ?? null };
  draft.previewPosition = anchor; draft.manualPosition = false;
  draft.changes = objects.map(object => ({
    id:object.id,
    expectedPosition:structuredClone(object.position),
    position:{x:object.position.x+delta.x,y:object.position.y+delta.y,z:object.position.z+delta.z},
  }));
  for (const change of draft.changes) {
    const ghost = draft.ghosts?.get(change.id) ?? draft.ghost;
    ghost.position.set(change.position.x,change.position.y,change.position.z);
  }
  if (objects.length === 1) {
    for (const axis of ['x', 'y', 'z']) $('edit-position-' + axis).value = String(anchor[axis]);
    inspectorDirty = true;
    $('move-preview-status').hidden = false;
    $('move-preview-status').textContent = 'Local preview only. Apply changes to move the shared object; Cancel or Escape discards it.';
    $('edit-message').textContent = 'Preview only — nothing has been sent to the world server.';
  } else {
    $('group-move-status').textContent = 'Local preview for ' + objects.length + ' objects. Apply once to move the group; Cancel or Escape discards it.';
    $('group-move-apply').disabled = false;
  }
  $('move-cancel').hidden = false;
  $('move-preview-status').hidden = false;
  if (objects.length > 1) $('move-preview-status').textContent = 'Preview only — nothing has been sent to the world server.';
}
function refreshMovePreview() {
  const draft = movePreview ?? (dragCandidate?.started ? dragCandidate : null);
  if (!draft?.target || draft.manualPosition) return;
  try {
    const surface = draft.target.surfaceId ? objectData.get(draft.target.surfaceId) : null;
    setMovePreviewPosition(draft, { point: draft.target.point, surface });
  } catch (error) { $('move-preview-status').textContent = error.message; }
}
function setBoxSelectionMode(enabled) {
  boxSelectMode = enabled;
  const button = $('box-select-toggle');
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = enabled ? 'Exit box selection' : 'Box select';
  if (controls) controls.enabled = !enabled && !dragCandidate && !movePreview;
}
function updateSelectionRectangle(start, end) {
  const rectangle = $('selection-rectangle');
  rectangle.hidden = false;
  rectangle.style.left = Math.min(start.x,end.x) + 'px'; rectangle.style.top = Math.min(start.y,end.y) + 'px';
  rectangle.style.width = Math.abs(end.x-start.x) + 'px'; rectangle.style.height = Math.abs(end.y-start.y) + 'px';
}
function cancelBoxSelection() {
  boxCandidate = null; $('selection-rectangle').hidden = true;
  if (controls) controls.enabled = !boxSelectMode && !dragCandidate && !movePreview;
}
function beginObjectDrag(event) {
  renderer.domElement.dataset.startX = event.clientX; renderer.domElement.dataset.startY = event.clientY;
  if (event.button !== 0 || movePreview || editing || inspectorDirty) return;
  if (boxSelectMode) {
    boxCandidate = { pointerId:event.pointerId, start:{x:event.clientX,y:event.clientY}, end:{x:event.clientX,y:event.clientY} };
    controls.enabled = false; renderer.domElement.setPointerCapture(event.pointerId);
    updateSelectionRectangle(boxCandidate.start,boxCandidate.end); return;
  }
  const ray = pointerRay(event), hit = ray?.intersectObjects([...meshes.values()], true)[0];
  const objectId = hit ? objectIdForHit(hit.object) : null;
  if (!canEditObject(objectData.get(objectId))) return;
  controls.enabled = false;
  dragCandidate = { pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, objectId, plane:$('move-plane').value, started:false, ghost:null, ghosts:null, objects:null };
  renderer.domElement.setPointerCapture(event.pointerId); $('move-plane').disabled = true;
}
function updateObjectDrag(event) {
  if (boxCandidate?.pointerId === event.pointerId) {
    boxCandidate.end = {x:event.clientX,y:event.clientY}; updateSelectionRectangle(boxCandidate.start,boxCandidate.end); return;
  }
  const draft = dragCandidate;
  if (!draft || draft.pointerId !== event.pointerId || (!draft.started && Math.hypot(event.clientX-draft.startX,event.clientY-draft.startY) <= 5)) return;
  const object = objectData.get(draft.objectId);
  if (!canEditObject(object) || editing || (!draft.started && selectedId === draft.objectId && inspectorDirty)) {
    const permissionLost = !canEditObject(object); clearMovePreview();
    if (permissionLost) $('group-move-status').textContent = 'Your permission to edit this shape changed; the local move preview was discarded.';
    return;
  }
  if (!draft.started) {
    if (!selectedIds.has(draft.objectId) && !selectObject(draft.objectId)) { clearMovePreview(); return; }
    const ids = selectedIds.has(draft.objectId) ? [...selectedIds] : [draft.objectId];
    const members = ids.map(id => objectData.get(id));
    if (members.some(member => !canEditObject(member))) {
      $('group-move-status').textContent = 'This group contains read-only shapes. Remove them from the selection before moving the group.';
      clearMovePreview(); return;
    }
    if (ids.length > 1 && ids.length > MAX_GROUP_SELECTION) { $('group-move-status').textContent = 'A group can contain at most ' + MAX_GROUP_SELECTION + ' shapes.'; clearMovePreview(); return; }
    draft.objects = members.map(member => structuredClone(member)); draft.object = draft.objects.find(member => member.id === draft.objectId);
    draft.ghosts = new Map();
    for (const member of draft.objects) {
      const ghost = objectMesh(member);
      ghost.traverse(child => {
        if (!child.material) return;
        child.material = child.material.clone(); child.material.color.set('#f3c969'); child.material.transparent = true; child.material.opacity = .42; child.material.depthWrite = false;
      });
      draft.ghosts.set(member.id,ghost); scene.add(ghost);
    }
    draft.ghost = draft.ghosts.get(draft.objectId); draft.started = true;
    $('move-preview-status').hidden = false; $('move-preview-status').textContent = 'Drag preview — the shared world has not changed.';
    $('move-cancel').hidden = false;
  }
  const target = placementHit(event,draft);
  if (target) setMovePreviewPosition(draft,target);
}
function finishObjectDrag(event) {
  if (boxCandidate?.pointerId === event.pointerId) {
    const box = boxCandidate; cancelBoxSelection();
    selectObjectsInBox(box.start,box.end,event.ctrlKey||event.metaKey); return;
  }
  const draft = dragCandidate;
  if (draft && draft.pointerId === event.pointerId) {
    dragCandidate = null; controls.enabled = !boxSelectMode;
    if (draft.started && draft.previewPosition) {
      movePreview = draft;
      if (draft.objects.length > 1) $('group-move-apply').disabled = false;
    } else clearMovePreview();
  }
  if (Math.hypot(event.clientX-Number(renderer.domElement.dataset.startX),event.clientY-Number(renderer.domElement.dataset.startY)) > 5) return;
  const ray = pointerRay(event), hit = ray?.intersectObjects([...meshes.values()],true)[0], id = hit ? objectIdForHit(hit.object) : null;
  if (event.ctrlKey||event.metaKey) selectObject(id,false,true);
  else if (!id || !selectedIds.has(id)) selectObject(id);
}
function disposeGroup(group) { group.traverse(child => { child.geometry?.dispose(); if (child.material) child.material.dispose(); }); }
function fillInspector(object) {
  inspectorBase = object ? structuredClone(object) : null; inspectorDirty = false;
  $('edit-form').hidden = !object;
  if (!object) return;
  for (const field of ['position', 'size']) for (const axis of ['x', 'y', 'z']) $(`edit-${field}-${axis}`).value = object[field][axis];
  $('edit-color').value = object.color;
  $('edit-blocks-movement').checked = object.blocksMovement;
  $('edit-supports-player').checked = object.supportsPlayer;
  const canEdit = role === 'admin' || (role === 'builder' && object.ownerId === meId);
  $('edit-fields').disabled = editing || !canEdit;
  $('edit-message').textContent = !canEdit ? 'Read-only: you do not have permission to edit this shape.' : 'Changes are checked by the world server.';
}
function updateMovePreviewFromInspector() {
  const draft = movePreview;
  if (!draft?.ghost) return;
  const values = ['x', 'y', 'z'].map(axis => $('edit-position-' + axis).value);
  if (values.some(value => value === '' || !Number.isFinite(Number(value)))) {
    $('move-preview-status').textContent = 'Enter a finite position for each axis.';
    return;
  }
  const position = Object.fromEntries(['x', 'y', 'z'].map((axis, index) => [axis, Number(values[index])]));
  draft.previewPosition = position; draft.manualPosition = true;
  draft.ghost.position.set(position.x, position.y, position.z);
  $('move-preview-status').textContent = 'Manual position preview. Apply changes to update the shared world.';
}
function selectObject(id, fromPoll = false, additive = false) {
  if (fromPoll) return applySelection([...selectedIds],null,true);
  if (additive && !id) return true;
  const next = new Set(selectedIds); let primary = id;
  if (additive) {
    if (next.has(id)) { next.delete(id); primary = selectedId === id ? [...next].at(-1) ?? null : selectedId; }
    else if (next.size < MAX_GROUP_SELECTION) next.add(id);
    else { $('group-move-status').textContent = 'Selection is limited to ' + MAX_GROUP_SELECTION + ' shapes.'; return false; }
  } else if (id && next.has(id)) {
    if (next.size === 1) return true;
    next.clear(); next.add(id);
  } else { next.clear(); if (id) next.add(id); }
  return applySelection(next,primary);
}
function selectObjectsInBox(start,end,additive=false) {
  const rect = renderer.domElement.getBoundingClientRect(), left = Math.min(start.x,end.x), right = Math.max(start.x,end.x);
  const top = Math.min(start.y,end.y), bottom = Math.max(start.y,end.y), ids = [];
  camera.updateMatrixWorld?.();
  for (const object of objectData.values()) {
    const point = new THREE.Vector3(object.position.x,object.position.y,object.position.z).project(camera);
    if (point.z < -1 || point.z > 1) continue;
    const x = rect.left + (point.x+1)*rect.width/2, y = rect.top + (1-point.y)*rect.height/2;
    if (x >= left && x <= right && y >= top && y <= bottom) ids.push(object.id);
  }
  const next = new Set(additive ? selectedIds : []); let skipped = false;
  for (const id of ids) {
    if (next.has(id)) continue;
    if (next.size === MAX_GROUP_SELECTION) { skipped = true; break; }
    next.add(id);
  }
  applySelection(next,[...next].at(-1));
  if (skipped) $('group-move-status').textContent = 'Selection is limited to ' + MAX_GROUP_SELECTION + ' shapes; extra shapes were skipped.';
}
function refreshSelectionVisuals() {
  for (const box of selectionBoxes.values()) { scene.remove(box); box.geometry.dispose(); box.material.dispose(); }
  selectionBoxes.clear();
  for (const id of selectedIds) {
    const mesh = meshes.get(id), object = objectData.get(id); if (!mesh) continue;
    const editable = role === 'admin' || (role === 'builder' && object?.ownerId === meId);
    const box = new THREE.BoxHelper(mesh,editable?'#ffe5a1':'#aab7bd');
    selectionBoxes.set(id,box); scene.add(box);
  }
}
function previewObjectIds(draft) { return draft?.objects?.map(object => object.id) ?? (draft?.objectId ? [draft.objectId] : []); }
function applySelection(ids, primary = null, fromPoll = false) {
  const next = new Set([...ids].filter(id => objectData.has(id)).slice(0,MAX_GROUP_SELECTION));
  const old = [...selectedIds], changed = old.length !== next.size || old.some(id => !next.has(id));
  if (!changed && !fromPoll) return true;
  if (!fromPoll && inspectorDirty && !window.confirm('Discard unapplied changes to this shape?')) return false;
  const draft = movePreview ?? dragCandidate;
  if ((fromPoll && previewObjectIds(draft).some(id => !next.has(id))) || (!fromPoll && changed && (movePreview || dragCandidate?.started))) clearMovePreview();
  selectedIds.clear(); for (const id of next) selectedIds.add(id);
  const previousPrimary = selectedId;
  selectedId = next.has(primary) ? primary : next.has(previousPrimary) ? previousPrimary : [...next].at(-1) ?? null;
  refreshSelectionVisuals();
  const selected = [...selectedIds].map(id => objectData.get(id)), readOnly = selected.filter(object => !canEditObject(object)).length;
  $('selection-label').textContent = selected.length === 0 ? 'No shape selected'
    : selected.length === 1 ? selected[0].type + ' · ' + selected[0].id.slice(0,12) + (readOnly ? ' · Read only' : '')
    : selected.length + ' shapes selected · ' + readOnly + ' read-only';
  $('move-options').hidden = !selected.length;
  $('group-controls').hidden = selected.length < 2;
  $('edit-form').hidden = selected.length !== 1;
  $('remove').disabled = selected.length !== 1 || readOnly > 0;
  if (selected.length === 1) {
    const object = selected[0];
    if (previousPrimary !== selectedId || !inspectorDirty || !object) fillInspector(object);
    else if (JSON.stringify(object) !== JSON.stringify(inspectorBase)) $('edit-message').textContent = 'This shape changed on the server. Your unapplied values are preserved; Reset reloads the current shape.';
  } else {
    inspectorBase = null; inspectorDirty = false; $('edit-fields').disabled = true;
    if (selected.length > 1) $('group-move-status').textContent = readOnly
      ? readOnly + ' read-only shape(s) selected. Remove them before moving this group.'
      : 'Drag any selected shape to preview one shared group move.';
  }
  $('group-move-apply').disabled = true;
  return true;
}
function renderWorld(state, movementVersion = localMovementVersion) {
  if (state.revision < latestStateRevision) return;
  latestStateRevision = state.revision; worldState = state; worldRevision = state.revision;
  const firstState = meId !== state.me.id, savedPlayer = state.players.find(p => p.id === state.me.id);
  if (savedPlayer && movementVersion === localMovementVersion && !moveRunning && (firstState || positionKey(playerPosition) === lastPosition)) { playerPosition = { ...savedPlayer.position }; playerVelocityY = savedPlayer.velocityY ?? 0; lastPosition = positionKey(savedPlayer.position); }
  const accessChanged = meId !== state.me.id || role !== state.me.role;
  meId = state.me.id; role = state.me.role; $('role').textContent = `Role: ${state.me.role}`; $('revision').textContent = `REV ${state.revision}`;
  const draft = movePreview ?? dragCandidate;
  if (accessChanged && previewObjectIds(draft).some(id => !objectData.has(id) || !canEditObject(objectData.get(id)))) {
    clearMovePreview(); $('group-move-status').textContent = 'Your permission to edit a selected shape changed; the local move preview was discarded.';
  }
  const nextSnapshot = JSON.stringify(state.objects);
  if (objectSnapshot !== nextSnapshot) {
    for (const mesh of meshes.values()) { sceneRoot.remove(mesh); disposeGroup(mesh); } meshes.clear();
    objectData.clear();
    for (const object of state.objects) { objectData.set(object.id, object); const mesh = objectMesh(object); meshes.set(object.id, mesh); sceneRoot.add(mesh); }
    objectSnapshot = nextSnapshot; selectObject(null,true);
  } else if (accessChanged) selectObject(null,true);
  const online = Array.isArray(state.onlinePlayerIds) ? new Set(state.onlinePlayerIds) : null;
  const live = new Set();
  for (const remote of state.players) {
    if (remote.id === meId || (online && !online.has(remote.id))) continue; live.add(remote.id);
    if (!otherPlayers.has(remote.id)) { const mesh = avatar('#8ba5c0'); otherPlayers.set(remote.id, mesh); scene.add(mesh); }
    otherPlayers.get(remote.id).position.set(remote.position.x, remote.position.y, remote.position.z);
  }
  for (const [id, mesh] of otherPlayers) if (!live.has(id)) { scene.remove(mesh); disposeGroup(mesh); otherPlayers.delete(id); }
}
async function poll() {
  if (pollRunning || !bridge) return; pollRunning = true;
  const generation = settingsGeneration, movementVersion = localMovementVersion;
  try { const state = await request('/state'); if (generation !== settingsGeneration) return; if (state.error) throw new Error(state.message || state.error); if (scene) renderWorld(state, movementVersion); $('connection').textContent = '● World connected'; $('connection').classList.remove('offline'); }
  catch (error) { if (generation !== settingsGeneration) return; $('connection').textContent = '○ World offline'; $('connection').classList.add('offline'); feedback(error.message, true); }
  finally { pollRunning = false; }
}
function positionKey(position) { return `${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`; }
let lastPosition = '';
async function syncPosition() {
  const position = { ...playerPosition }, key = positionKey(position), generation = settingsGeneration, movementVersion = localMovementVersion, jump = jumpRequested;
  if (moveRunning || (key === lastPosition && !jump && playerVelocityY === 0) || !meId || !bridge) return; moveRunning = true;
  try {
    const result = await request('/command', 'POST', { type: 'move', position, jump });
    if (generation === settingsGeneration && !result.error && Number.isSafeInteger(result.revision) && result.revision >= latestStateRevision) {
      latestStateRevision = result.revision;
      if (movementVersion === localMovementVersion && result.position) { playerPosition = result.position; playerVelocityY = result.velocityY ?? 0; }
      if (jump) jumpRequested = false;
      lastPosition = positionKey(result.position ?? position);
    } else if (generation === settingsGeneration && !result.error && Number.isSafeInteger(result.revision) && movementVersion === localMovementVersion) {
      lastPosition = positionKey(playerPosition);
    }
  } catch { /* The status poll reports connectivity failures. */ } finally { moveRunning = false; }
}
async function command(body) { const result = await request('/command', 'POST', body); if (result.error) throw new Error(result.message || result.error); await poll(); return result; }

for (const button of document.querySelectorAll('[data-kind]')) button.addEventListener('click', () => { selectedKind = button.dataset.kind; document.querySelectorAll('[data-kind]').forEach(el => el.classList.toggle('selected', el === button)); });
$('build-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { await command({ type: 'build', objectType: selectedKind, position: { x: Number($('build-x').value), y: selectedKind === 'block' ? 1 : .5, z: Number($('build-z').value) } }); feedback(`${selectedKind[0].toUpperCase() + selectedKind.slice(1)} placed in the shared world.`); } catch (error) { feedback(error.message, true); } finally { button.disabled = false; } });
$('remove').addEventListener('click', async () => { if (!selectedId) return; const id = selectedId; $('remove').disabled = true; try { await command({ type: 'remove', id }); feedback('Shape removed.'); } catch (error) { feedback(error.message, true); } finally { $('remove').disabled = !selectedId; } });
$('move-grid-step').disabled = !$('move-snap-enabled').checked;
$('move-snap-enabled').addEventListener('change', () => { $('move-grid-step').disabled = !$('move-snap-enabled').checked; refreshMovePreview(); });
$('move-grid-step').addEventListener('input', refreshMovePreview);
$('move-cancel').addEventListener('click', cancelMovePreview);
$('box-select-toggle').addEventListener('click', () => setBoxSelectionMode(!boxSelectMode));
async function applyGroupMove() {
  const draft = movePreview;
  if (!draft || draft.objects?.length < 2 || !draft.changes?.length || editing) return;
  const generation = settingsGeneration, button = $('group-move-apply');
  button.disabled = true; editing = true;
  const matches = objects => draft.changes.every(change => {
    const object = objects.find(item => item.id === change.id);
    return object && ['x','y','z'].every(axis => object.position[axis] === change.position[axis]);
  });
  try {
    const result = await command({type:'move_group',changes:draft.changes});
    if (generation !== settingsGeneration) return;
    if (!Array.isArray(result.objects) || !matches(result.objects)) throw new Error('The server response did not confirm every moved shape.');
    clearMovePreview(); $('group-move-status').textContent = 'The server confirmed all ' + draft.objects.length + ' shapes moved in one update.';
    feedback('Group move saved on the server.');
  } catch (error) {
    if (generation !== settingsGeneration) return;
    let confirmed = false, stateRead = false;
    try {
      const snapshot = await request('/state');
      if (generation !== settingsGeneration) return;
      if (snapshot.error) throw new Error(snapshot.message || snapshot.error);
      renderWorld(snapshot); stateRead = true; confirmed = matches(snapshot.objects);
    } catch { /* Do not retry an operation whose outcome is unknown. */ }
    clearMovePreview();
    $('group-move-status').textContent = confirmed
      ? 'The refreshed server state confirms every shape moved; no retry was sent.'
      : error.message + (stateRead ? ' The group was not confirmed at its target. Review the world and create a new preview; no retry was sent.' : ' The outcome is unknown. Refresh the world before trying again; no retry was sent.');
    feedback($('group-move-status').textContent,!confirmed);
  } finally {
    editing = false; button.disabled = !movePreview;
  }
}
$('group-move-apply').addEventListener('click', applyGroupMove);
$('edit-form').addEventListener('input', event => {
  const id = event?.target?.id;
  if (!id?.startsWith('edit-position-') && !id?.startsWith('edit-size-') && !['edit-color', 'edit-blocks-movement', 'edit-supports-player'].includes(id)) return;
  inspectorDirty = true;
  if (id.startsWith('edit-position-')) updateMovePreviewFromInspector();
});
$('edit-reset').addEventListener('click', () => { if (movePreview || dragCandidate) cancelMovePreview(); else fillInspector(objectData.get(selectedId)); });
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!selectedId || !inspectorBase || editing) return;
  const id = selectedId, baseline = inspectorBase, current = objectData.get(id), body = { type: 'update', id };
  for (const field of ['position', 'size']) {
    const value = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Number($(`edit-${field}-${axis}`).value)]));
    if (JSON.stringify(value) !== JSON.stringify(baseline[field])) body[field] = value;
  }
  if ($('edit-color').value !== baseline.color) body.color = $('edit-color').value;
  for (const [field, input] of [['blocksMovement', 'edit-blocks-movement'], ['supportsPlayer', 'edit-supports-player']]) {
    const checked = $(input).checked;
    if (checked !== baseline[field]) body[field] = checked;
  }
  const fields = Object.keys(body).filter(key => !['type', 'id'].includes(key));
  if (!fields.length) { $('edit-message').textContent = 'No changes to apply.'; return; }
  if (!current || fields.some(field => JSON.stringify(current[field]) !== JSON.stringify(baseline[field]))) { $('edit-message').textContent = 'A field you edited also changed on the server. Reset to reload it before applying.'; return; }
  const movePrecondition = Object.hasOwn(body, 'position') ? positionUpdateCommand(current, body.position).expected : {};
  body.expected = {
    ...Object.fromEntries(fields.filter(field => field !== 'position').map(field => [field, structuredClone(baseline[field])])),
    ...movePrecondition,
  };
  inspectorDirty = true; editing = true; $('edit-fields').disabled = true; const generation = settingsGeneration;
  try {
    const result = await command(body);
    if (generation !== settingsGeneration) return;
    if (result.object) objectData.set(id, result.object);
    clearMovePreview();
    if (selectedId === id) { inspectorDirty = false; fillInspector(objectData.get(id)); $('edit-message').textContent = 'Changes saved on the server.'; }
    feedback('Shape updated on the server.');
  } catch (error) {
    if (generation !== settingsGeneration) return;
    let confirmed = false;
    try {
      const snapshot = await request('/state');
      if (generation !== settingsGeneration) return;
      if (snapshot.error) throw new Error(snapshot.message || snapshot.error);
      renderWorld(snapshot);
      const latest = objectData.get(id);
      confirmed = Boolean(latest && fields.every(field => JSON.stringify(latest[field]) === JSON.stringify(body[field])));
    } catch { /* Preserve the draft when the server outcome cannot be confirmed. */ }
    if (generation !== settingsGeneration) return;
    if (confirmed) {
      clearMovePreview();
      if (selectedId === id) { inspectorDirty = false; fillInspector(objectData.get(id)); $('edit-message').textContent = 'Server state confirms the change; no retry was sent.'; }
      feedback('Shape update confirmed from server state.');
    } else {
      if (selectedId === id) $('edit-message').textContent = error.message + ' The outcome may be unknown. Check the server state before retrying; your local proposal is preserved.';
      $('move-preview-status').textContent = 'Server outcome not confirmed. Check the shared world before retrying.';
      feedback(error.message, true);
    }
  }
  finally { editing = false; const object = objectData.get(selectedId); $('edit-fields').disabled = !object || !(role === 'admin' || (role === 'builder' && object.ownerId === meId)); }
});
function setFullscreenState(value) {
  isFullscreen = value === true;
  const button = $('fullscreen-toggle');
  button.textContent = isFullscreen ? 'Exit full screen' : 'Full screen';
  button.setAttribute('aria-pressed', String(isFullscreen));
  button.title = isFullscreen ? 'Exit full screen (F11 or Escape)' : 'Enter full screen (F11)';
  $('fullscreen-status').textContent = '';
}
function requestFullscreenToggle() {
  bridge.toggleFullscreen().catch(error => { $('fullscreen-status').textContent = `Fullscreen failed: ${error.message}`; });
}
bridge.onFullscreenChange(setFullscreenState);
$('fullscreen-toggle').addEventListener('click', requestFullscreenToggle);
setFullscreenState(false);
window.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  if (event.code === 'Escape' && boxCandidate) { event.preventDefault(); cancelBoxSelection(); setBoxSelectionMode(false); return; }
  if (event.code === 'Escape' && boxSelectMode) { event.preventDefault(); setBoxSelectionMode(false); return; }
  if (event.code === 'Escape' && (dragCandidate || movePreview)) { event.preventDefault(); cancelMovePreview(); return; }
  if (event.code === 'F11') { event.preventDefault(); if (!event.repeat) requestFullscreenToggle(); return; }
  if (event.code === 'Escape' && isFullscreen) { event.preventDefault(); requestFullscreenToggle(); return; }
  if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) jumpRequested = true; return; }
  keys.add(event.key.toLowerCase());
});
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase())); window.addEventListener('blur', () => keys.clear());
$('find-codex').addEventListener('click', async () => {
  const button=$('find-codex'),results=$('codex-results');button.disabled=true;results.textContent='Looking in known installation locations…';
  try {
    const found=await bridge.findCodex();results.replaceChildren();
    if(!found.candidates.length){const note=document.createElement('p');note.textContent='No native Codex executable found. You can choose its file manually.';results.append(note);}
    for(const candidate of found.candidates){const choice=document.createElement('button');choice.type='button';choice.className='codex-candidate';const label=document.createElement('strong');label.textContent=candidate.label;const location=document.createElement('small');location.textContent=candidate.path;choice.append(label,location);choice.addEventListener('click',()=>{$('codex').value=candidate.path;$('settings-message').textContent='Selected '+candidate.label+'. Connect to use it.';});results.append(choice);}
    for(const tip of found.hints||[]){const note=document.createElement('p');note.className='muted small';note.textContent=tip;results.append(note);}
    if(found.incomplete){const note=document.createElement('p');note.textContent='Some locations could not be inspected. Manual selection is still available.';results.append(note);}
  }catch(error){results.textContent=error.message;}finally{button.disabled=false;}
});
for(const [button,kind,input] of [['browse-codex','codex','codex'],['browse-workspace','workspace','workspace']])$(button).addEventListener('click',async()=>{try{const selected=await bridge.choosePath(kind);if(selected)$(input).value=selected;}catch(error){$('settings-message').textContent=error.message;}});
$('settings-open').addEventListener('click', () => $('settings').showModal()); $('settings-close').addEventListener('click', () => $('settings').close());
function readSettings() { return { ...settings, workspacePath: $('workspace').value.trim(), codexPath: $('codex').value.trim(), serverUrl: $('server-url').value.trim(), token: $('token').value }; }
async function saveSettings() {
  if (editing) throw new Error('Finish the current world update before changing connection settings.');
  const next = readSettings();
  const changed = ['workspacePath', 'codexPath', 'serverUrl', 'token'].some(key => next[key] !== settings[key]);
  if (changed && (connected || settings.threadId)) {
    if (!settings.threadId) throw new Error('Cannot verify the current Codex conversation; reconnect before changing connection settings.');
    const state = await bridge.readAgentControls(settings.threadId);
    if (!state?.connected || state.threadId !== settings.threadId ||
        !['idle', 'active', 'systemError', 'unknown'].includes(state.threadStatus) ||
        (state.turnId !== null && typeof state.turnId !== 'string') ||
        !Number.isInteger(state.pendingApprovals) || state.pendingApprovals < 0 ||
        typeof state.goalSupported !== 'boolean' || !Object.hasOwn(state, 'goal') || state.threadStatus === 'unknown') {
      throw new Error('Cannot verify the current Codex conversation; reconnect and check its state before changing connection settings.');
    }
    if (state.threadStatus !== 'idle' || state.turnId || state.pendingApprovals > 0 || state.goal) {
      throw new Error('Clear the native Goal, resolve pending approvals, and wait for Codex to become idle before changing connection settings.');
    }
  }
  if (changed && (movePreview || dragCandidate || inspectorDirty) &&
      !window.confirm('Discard unapplied world changes before changing connection settings?')) {
    throw new Error('Connection settings were not changed; local world edits are preserved.');
  }
  if (next.workspacePath !== settings.workspacePath) next.threadId = '';
  if (changed) {
    if (movePreview || dragCandidate) cancelMovePreview();
    inspectorDirty = false;
    await bridge.disconnectCodex(); connected = false; busy = false; updateChatControls();
    $('agent-status').textContent = 'Settings changed · reconnect Codex';
  }
  settings = next; settingsGeneration++;
  const { token, ...persisted } = settings; await bridge.saveSettings(persisted);
  worldRevision = -1; objectSnapshot = ''; worldState = { objects: [] }; meId = null; playerPosition = { x: 0, y: 0, z: 0 }; playerVelocityY = 0; jumpRequested = false; lastPosition = ''; latestStateRevision = -1; localMovementVersion++; moveStarts.clear();
  if (scene) { selectObject(null); objectData.clear(); for (const mesh of meshes.values()) { sceneRoot.remove(mesh); disposeGroup(mesh); } meshes.clear(); for (const mesh of otherPlayers.values()) { scene.remove(mesh); disposeGroup(mesh); } otherPlayers.clear(); }
  await poll();
}
$('save-world').addEventListener('click', async () => { try { await saveSettings(); $('settings-message').textContent = 'World settings saved. Access token is kept only for this session.'; } catch (error) { $('settings-message').textContent = error.message; } });
$('settings-form').addEventListener('submit', async event => { event.preventDefault(); $('connect').disabled = true; $('settings-message').textContent = 'Connecting to your Codex app-server…'; try { await saveSettings(); const result = await bridge.connectCodex({ ...settings, newGameThread: $('new-game-thread').checked }); settings.threadId = result.threadId; $('new-game-thread').checked = false; const { token, ...persisted } = settings; await bridge.saveSettings(persisted); connected = true; $('agent-status').textContent = 'Ready · responds only when asked'; updateChatControls(); $('settings').close(); if ($('agent-controls').open) void refreshAgentControls(); addMessage(result.resumed ? 'Resumed your saved Codex conversation. It retains the tools registered when it was created. To use updated game commands, open Settings and explicitly select “Create a new game conversation”, then Connect. Your old conversation and its history are preserved. No request has been sent.' : 'Connected to your Codex workspace. No request has been sent.'); } catch (error) { $('settings-message').textContent = error.message; } finally { $('connect').disabled = false; } });
const toolRows = new Map(), itemRows = new Map(), moveStarts = new Map();
let stopRequested = false, acceptedThreadId = null, currentTurnId = null;
const retiredTurns = new Set();
function activityThread(threadId) {
  if (threadId !== acceptedThreadId) { retiredTurns.clear(); currentTurnId = null; moveStarts.clear(); }
  acceptedThreadId = threadId;
}
function activityRow(text, status = 'running') {
  const row = document.createElement('li'); row.textContent = text; row.dataset.status = status; $('agent-actions').append(row);
  while ($('agent-actions').children.length > 40) $('agent-actions').firstElementChild.remove();
  return row;
}
function startActivity() {
  if (currentTurnId) retiredTurns.add(currentTurnId);
  if (retiredTurns.size > 100) retiredTurns.delete(retiredTurns.values().next().value);
  currentTurnId = null;
  stopRequested = false; toolRows.clear(); itemRows.clear(); moveStarts.clear(); $('agent-actions').replaceChildren(); $('agent-plan').replaceChildren(); $('agent-plan').hidden = true;
  $('activity-state').textContent = 'Requested'; $('agent-intent').textContent = 'Waiting for Codex to report its next action.'; $('agent-stop-reason').textContent = 'Request submitted; no completion reported yet.';
}
function constructionLabel(design, verb = 'Build') {
  if (!['block', 'bridge', 'port'].includes(design?.objectType || design?.type)) return null;
  const position = design.position;
  if (!position || !['x', 'y', 'z'].every(axis => typeof position[axis] === 'number' && Number.isFinite(position[axis]) && Math.abs(position[axis]) <= 1000)) return null;
  return `${verb} ${design.objectType || design.type} at (${position.x}, ${position.y}, ${position.z})`;
}
function toolArguments(event) {
  let args = event.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : null;
}
function toolLabel(event) {
  if (event.name === 'world_state') return 'Read world state';
  if (!['world_command', 'world_build'].includes(event.name)) return 'Requested tool';
  const args = toolArguments(event);
  if (!args) return event.name === 'world_build' ? 'Build shape (invalid design)' : 'World command';
  if (event.name === 'world_build') return constructionLabel(args) || 'Build shape (invalid design)';
  const labels = { build: 'Build shape', update: 'Edit shape', remove: 'Remove shape', move: 'Move player', move_group: 'Move object group' };
  return labels[args?.command?.type] || labels[args?.type] || 'World command';
}
function toolActivity(event) {
  if (!busy || event.threadId !== acceptedThreadId || !event.turnId || event.id == null || retiredTurns.has(event.turnId)) return;
  if (!currentTurnId) currentTurnId = event.turnId;
  if (event.turnId !== currentTurnId) return;
  const label = toolLabel(event), key = JSON.stringify([event.threadId, event.turnId, event.id]);
  if (event.type === 'tool-start') {
    const command = toolArguments(event)?.command;
    if (event.name === 'world_command' && command?.type === 'move') moveStarts.set(key, { position: command.position, version: localMovementVersion, generation: settingsGeneration });
    $('agent-intent').textContent = label + ' requested.'; $('activity-state').textContent = 'Working';
    if (!toolRows.has(key)) toolRows.set(key, activityRow(label + ' · running')); return;
  }
  const row = toolRows.get(key) || activityRow(label); toolRows.set(key, row);
  const success = event.result?.success === true;
  let response; try { const text = event.result?.contentItems?.find(item => item.type === 'inputText')?.text; if (typeof text === 'string' && text.length < 2000000) response = JSON.parse(text); } catch { /* Only structured evidence is summarized. */ }
  if (event.name === 'world_command') {
    const started = moveStarts.get(key); moveStarts.delete(key);
    if (started && started.generation === settingsGeneration && success && Number.isSafeInteger(response?.revision) && response.revision >= latestStateRevision) {
      latestStateRevision = response.revision;
      const position = response?.position ?? started.position;
      if (started.version === localMovementVersion && position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]) && Math.abs(position[axis]) <= 1000)) { playerPosition = { x: position.x, y: position.y, z: position.z }; playerVelocityY = response?.velocityY ?? 0; lastPosition = positionKey(playerPosition); }
    }
  }
  const revision = Number.isSafeInteger(response?.revision) && response.revision >= 0 ? ` · revision ${response.revision}` : '';
  if (event.name === 'world_build') {
    const created = response?.object;
    const confirmedLabel = success && typeof created?.id === 'string' && created.id.length > 0 && revision ? constructionLabel(created, 'Built') : null;
    row.textContent = confirmedLabel ? confirmedLabel + ' · server confirmed' + revision : label + (success ? ' · construction not confirmed by a created object' : ' · failed');
    row.dataset.status = confirmedLabel ? 'completed' : success ? 'unconfirmed' : 'failed';
  } else {
    row.textContent = label + (success ? ' · completed' : ' · failed') + revision; row.dataset.status = success ? 'completed' : 'failed';
  }
  if (!success) $('agent-stop-reason').textContent = 'A tool failed. The turn may continue; wait for its final status.';
}
function notificationActivity(method, params) {
  if (params.threadId && acceptedThreadId && params.threadId !== acceptedThreadId) return;
  const turnId = params.turnId || params.turn?.id;
  if (turnId && (retiredTurns.has(turnId) || (currentTurnId && turnId !== currentTurnId))) return;
  if (method === 'turn/started' && turnId) currentTurnId = turnId;
  if (method === 'turn/started') { $('activity-state').textContent = 'Working'; $('agent-stop-reason').textContent = 'Turn in progress.'; }
  // Show an explicit user-facing plan, never reasoning or reasoning-summary events.
  if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
    $('agent-plan').replaceChildren();
    for (const step of params.plan.slice(0, 12)) { if (typeof step.step !== 'string') continue; const row = document.createElement('li'); row.textContent = step.step.slice(0, 500) + (['pending', 'inProgress', 'completed'].includes(step.status) ? ` (${step.status})` : ''); $('agent-plan').append(row); }
    $('agent-plan').hidden = !$('agent-plan').children.length;
  }
  if (['item/started', 'item/completed'].includes(method)) {
    const item = params.item, names = { commandExecution: 'Local command', fileChange: 'Workspace file changes', webSearch: 'Web search' };
    const name = names[item?.type];
    if (name && item.id) {
      if (method === 'item/started') { $('agent-intent').textContent = name + ' requested.'; itemRows.set(item.id, activityRow(name + ' · running')); }
      else {
        const row = itemRows.get(item.id) || activityRow(name);
        const failed = item.status === 'failed' || item.status === 'declined' || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
        row.dataset.status = failed ? 'failed' : 'completed'; row.textContent = name + (failed ? ' · failed or declined' : ' · completed') + (Number.isInteger(item.exitCode) ? ` · exit ${item.exitCode}` : '');
      }
    }
  }
  if (method === 'turn/completed') {
    const status = params.turn?.status;
    const failed = status === 'failed' || Boolean(params.turn?.error);
    $('activity-state').textContent = failed ? 'Failed' : status === 'interrupted' ? 'Stopped' : status === 'completed' ? 'Completed' : 'Ended';
    $('agent-stop-reason').textContent = failed ? 'Stopped with an error reported by Codex.' : status === 'interrupted' ? (stopRequested ? 'Stopped at your request; completed actions remain in the world.' : 'Codex reported that the turn was interrupted.') : status === 'completed' ? 'Codex reported the turn complete. This does not mean code changes were deployed.' : 'Turn ended; Codex did not provide a recognized completion status.';
    $('agent-intent').textContent = 'No action currently running.';
  }
}
function openAgentControls() { keys.clear(); jumpRequested = false; $('agent-controls').showModal(); void refreshAgentControls(); }

let streamMessage = null;
$('agent-controls-open').addEventListener('click', openAgentControls);
$('agent-goal-manage').addEventListener('click', openAgentControls);
$('agent-controls-close').addEventListener('click', () => $('agent-controls').close());
for (const id of ['goal-objective-input', 'goal-criteria-input', 'goal-confirm-start']) $(id).addEventListener('input', updateAgentControlButtons);
$('goal-confirm-start').addEventListener('change', updateAgentControlButtons);
$('agent-model').addEventListener('change', () => { populateAgentEfforts($('agent-model').value); updateAgentControlButtons(); });
$('goal-create').addEventListener('click', () => runGoalAction(threadId => bridge.createAgentGoal(threadId, { objective: $('goal-objective-input').value, completionCriteria: $('goal-criteria-input').value }), 'Native Goal creation was accepted; checking its current state.'));
$('goal-pause').addEventListener('click', () => runGoalAction(threadId => bridge.pauseAgentGoal(threadId), 'Pause request accepted; confirming native Goal state.'));
$('goal-resume').addEventListener('click', () => runGoalAction(threadId => bridge.resumeAgentGoal(threadId), 'Resume request accepted; confirming native Goal state.'));
$('goal-clear').addEventListener('click', () => { if (window.confirm('Clear the native Goal from this Codex conversation?')) void runGoalAction(threadId => bridge.clearAgentGoal(threadId), 'Clear request accepted; confirming native Goal state.'); });
$('goal-stop-turn').addEventListener('click', async () => { $('goal-stop-turn').disabled = true; $('agent-controls-message').textContent = 'Stop requested for the current turn; waiting for Codex to confirm.'; try { await bridge.interrupt(); } catch (error) { $('agent-controls-message').textContent = error.message; } finally { if ($('agent-controls').open) void refreshAgentControls(); } });
$('agent-model-save').addEventListener('click', async () => {
  const threadId = settings.threadId, modelId = $('agent-model').value || null, effort = $('agent-effort').value;
  if (!connected || !threadId || agentControlBusy) return;
  agentControlBusy = true; updateAgentControlButtons(); $('agent-controls-message').textContent = '';
  try {
    const saved = await bridge.saveAgentModel({ threadId, modelId, effort });
    if (!connected || settings.threadId !== threadId) throw new Error('Codex conversation changed; refresh agent controls.');
    settings = { ...settings, agentControlThreadId: saved.modelId ? threadId : '', agentModelId: saved.modelId, agentEffort: saved.effort };
    $('agent-controls-message').textContent = 'Saved for future explicit chat requests. Provider access is not guaranteed by the catalog, and an active Goal was not restarted.';
    renderAgentControls(agentControlState);
  } catch (error) { $('agent-controls-message').textContent = error.message; }
  finally { agentControlBusy = false; updateAgentControlButtons(); }
});
function sceneContextForPrompt() {
  const point = value => ({ x:value.x, y:value.y, z:value.z });
  return {
    revision:worldRevision, selectedIds:[...selectedIds],
    camera:{position:point(camera.position),target:point(controls.target),fov:camera.fov,aspect:camera.aspect,near:camera.near,far:camera.far,
      viewport:{width:renderer.domElement.clientWidth,height:renderer.domElement.clientHeight}},
  };
}
$('chat-form').addEventListener('submit',async event=>{
  event.preventDefault();const text=$('prompt').value.trim();
  if(!text||!connected||busy)return;
  ordinaryTurn=true;busy=true;startActivity();updateChatControls();addMessage(text,'user');$('prompt').value='';streamMessage=null;
  try{
    const result=await bridge.sendPrompt(text,sceneContextForPrompt()),context=result?.sceneContext;
    $('scene-context-status').textContent=!context
      ? 'Scene context could not be confirmed for this request.'
      : context.connectionChangedAfterAcceptance
        ? 'Request accepted, but the Codex connection changed before confirmation. Check the conversation before retrying.'
        : `Scene context captured for this request: revision ${context.revision}, ${context.selectedCount} selected, ${context.includedObjectCount}/${context.totalObjectCount} objects${context.truncated?' (partial)':''}.`;
  }catch(error){
    $('scene-context-status').textContent=/^Turn outcome is unknown:/i.test(error.message)
      ? 'Turn outcome is unknown; check the Codex conversation before retrying.'
      : 'Scene context was not sent: '+error.message;
    addMessage(error.message,'error');$('activity-state').textContent='Error';
    $('agent-stop-reason').textContent='Request could not be confirmed: '+error.message;
    ordinaryTurn=false;busy=false;updateChatControls();
  }
});
$('interrupt').addEventListener('click', async () => { $('interrupt').disabled = true; try { stopRequested = true; $('activity-state').textContent = 'Stopping'; $('agent-stop-reason').textContent = 'Stop requested; waiting for Codex to confirm interruption.'; await bridge.interrupt(); } catch (error) { addMessage(error.message, 'error'); $('interrupt').disabled = !busy; } });
function codexEvent(event) {
  if (event.type === 'history') {
    if (event.threadId !== settings.threadId) return;
    $('chat').replaceChildren();
    if (event.available === true && Array.isArray(event.messages)) {
      for (const message of event.messages) {
        if (['user', 'assistant'].includes(message?.role) && typeof message.text === 'string' && message.text.trim()) addMessage(message.text, message.role);
      }
    } else addMessage('Saved Codex chat history is unavailable.', 'system');
  }
  if (event.type === 'tool-start' || event.type === 'tool-result') toolActivity(event);
  if (event.type === 'connected') { activityThread(event.threadId); connected = true; settings.threadId = event.threadId; agentControlState = null; goalMessageContextId = null; refreshAgentStatus(); void refreshAgentControls(); }
  if (event.type === 'error') addMessage(event.message || 'Codex reported an error.', 'error');
  if (event.type === 'disconnected') { const activityUnknown = busy || Boolean(agentControlState?.goal) || Boolean(goalMessageContextId); agentControlRead++; agentControlState = null; $('activity-state').textContent = 'Disconnected'; $('agent-stop-reason').textContent = busy ? 'Connection ended before turn completion was confirmed. Check the world before retrying.' : 'Codex connection ended.'; connected = false; ordinaryTurn = false; busy = false; $('agent-status').textContent = activityUnknown ? 'Codex disconnected · activity unknown' : 'Codex disconnected'; $('agent-goal-summary').hidden = true; addMessage(event.message || 'Codex disconnected.', 'error'); if ($('agent-controls').open) void refreshAgentControls(); }
  if (event.type === 'approval') {
    if ($('agent-controls').open) void refreshAgentControls();
    $('activity-state').textContent = 'Needs decision'; $('agent-stop-reason').textContent = 'Waiting for your response to an approval request; no approval has been granted.';
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
    if (p.threadId && settings.threadId && p.threadId !== settings.threadId) return;
    if (event.method === 'thread/goal/updated' && p.goal) {
      const goal = p.goal; agentControlState = agentControlState ? { ...agentControlState, goal } : agentControlState;
      if (goal.status === 'active') goalMessageContextId = goal.id || settings.threadId;
      else if (!busy) goalMessageContextId = null;
      addMessage(`Native Goal status: ${typeof goal.status === 'string' ? goal.status : 'updated'}.`, 'system');
      refreshAgentStatus(); void refreshAgentControls();
    }
    if (event.method === 'thread/goal/cleared') {
      if (agentControlState) agentControlState = { ...agentControlState, goal: null };
      if (!busy) goalMessageContextId = null; addMessage('Native Goal cleared.', 'system');
      refreshAgentStatus(); void refreshAgentControls();
    }
    notificationActivity(event.method, p);
    if (event.method === 'turn/started') { busy = true; refreshAgentStatus(); }
    if (event.method === 'item/agentMessage/delta') { if (!streamMessage) streamMessage = addMessage('', ordinaryTurn || !goalMessageContextId ? 'assistant' : 'goal'); const body = streamMessage.querySelector('.chat-message-body'); if (body) body.textContent += p.delta || ''; else streamMessage.textContent += p.delta || ''; $('chat').scrollTop = $('chat').scrollHeight; }
    if (event.method === 'item/completed' && p.item?.type === 'agentMessage') { if (streamMessage) { const body = streamMessage.querySelector('.chat-message-body'); if (body) body.textContent = p.item.text || body.textContent; else streamMessage.textContent = p.item.text || streamMessage.textContent; } else if (p.item.text) addMessage(p.item.text, ordinaryTurn || !goalMessageContextId ? 'assistant' : 'goal'); streamMessage = null; }
    if (event.method === 'turn/completed') { ordinaryTurn = false; busy = false; if (p.turn?.error?.message) addMessage(p.turn.error.message, 'error'); if (goalMessageContextId && agentControlState?.goal?.status !== 'active') goalMessageContextId = null; refreshAgentStatus(); if ($('agent-controls').open) void refreshAgentControls(); }
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
