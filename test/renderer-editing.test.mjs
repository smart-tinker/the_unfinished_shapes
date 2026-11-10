import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';
import { positionUpdateCommand } from '../src/placement.mjs';

function editingHarness() {
  const h = rendererHarness();
  Object.assign(h.context, { window: { confirm: () => true }, THREE: {}, scene: {}, meshes: new Map(), feedback: () => {}, settingsGeneration: 0, poll: async () => {}, positionUpdateCommand });
  h.run(`let selectedId='shape-1', inspectorBase=null, inspectorDirty=false, editing=false, role='builder', meId='alice', dragCandidate=null, movePreview=null;
    function clearMovePreview(){dragCandidate=null;movePreview=null;} function cancelMovePreview(){clearMovePreview();} function refreshMovePreview(){}
    const objectData=new Map(); let selectionBox=null; let sends=[]; let failure=null, stateReads=[], stateSnapshot=null;
    async function request(path) {
      stateReads.push(path);
      if (path !== '/state') throw new Error('Unexpected request path: '+path);
      return stateSnapshot || {objects:[...objectData.values()]};
    }
    function renderWorld(snapshot) { for (const object of snapshot.objects) objectData.set(object.id,object); }
    async function command(body) {
      sends.push(body); if(failure) throw new Error(failure);
      const {type,expected,...fields}=body; const object={...objectData.get(body.id),...fields};
      objectData.set(body.id,object); return {revision:2,object};
    }`);
  h.load('function fillInspector(', 'function renderWorld(');
  h.load("$('edit-form').addEventListener('input'", "window.addEventListener('keydown'");
  h.context.objectFixture = { id: 'shape-1', type: 'block', ownerId: 'alice', position: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, color: '#c8a570', blocksMovement: true, supportsPlayer: true };
  h.run('objectData.set(selectedId,structuredClone(objectFixture));fillInspector(objectFixture)');
  h.submit = () => h.element('edit-form').listeners.submit({ preventDefault() {} });
  return h;
}

function loadObjectDrag(h) { h.load('function pointerRay(event)', 'function fillInspector('); }

test('inspector hydrates selected shape, and role/ownership determines editing controls', () => {
  const h = editingHarness();
  assert.equal(h.element('edit-position-y').value, 1);
  assert.equal(h.element('edit-size-z').value, 2);
  assert.equal(h.element('edit-color').value, '#c8a570');
  assert.equal(h.element('edit-blocks-movement').checked, true);
  assert.equal(h.element('edit-supports-player').checked, true);
  assert.equal(h.element('edit-fields').disabled, false);
  h.run("role='viewer';fillInspector(objectFixture)"); assert.equal(h.element('edit-fields').disabled, true);
  h.run("role='builder';meId='bob';fillInspector(objectFixture)"); assert.equal(h.element('edit-fields').disabled, true);
  h.run("role='admin';fillInspector(objectFixture)"); assert.equal(h.element('edit-fields').disabled, false);
});

test('apply sends changed fields only and hydrates confirmed server response', async () => {
  const h = editingHarness(); h.element('edit-position-x').value = '5'; h.element('edit-blocks-movement').checked = false; h.element('edit-supports-player').checked = false;
  await h.submit();
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(sends)')), [{ type: 'update', id: 'shape-1', position: { x: 5, y: 1, z: 0 }, blocksMovement: false, supportsPlayer: false, expected: { position: { x: 0, y: 1, z: 0 }, blocksMovement: true, supportsPlayer: true } }]);
  assert.equal(h.element('edit-position-x').value, 5);
  assert.equal(h.element('edit-blocks-movement').checked, false);
  assert.equal(h.element('edit-supports-player').checked, false);
  assert.equal(h.element('edit-message').textContent, 'Changes saved on the server.');
  assert.equal(h.run('inspectorDirty'), false);
  assert.equal(h.element('edit-fields').disabled, false);
});

test('numeric position edits update the local drag ghost before Apply', () => {
  const h = editingHarness();
  h.run("movePreview={previewPosition:{x:0,y:1,z:0},ghost:{position:{set(x,y,z){this.x=x;this.y=y;this.z=z}}}}");
  h.element('edit-position-x').value = '5';
  h.element('edit-position-y').value = '3';
  h.element('edit-position-z').value = '-2';
  h.element('edit-form').listeners.input({ target: { id: 'edit-position-y' } });
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(movePreview.previewPosition)')), { x: 5, y: 3, z: -2 });
  assert.deepEqual(JSON.parse(h.run('JSON.stringify([movePreview.ghost.position.x,movePreview.ghost.position.y,movePreview.ghost.position.z])')), [5, 3, -2]);
  assert.equal(h.run('inspectorDirty'), true);
});

test('unchanged inspector sends no mutation', async () => {
  const h = editingHarness(); await h.submit();
  assert.equal(h.run('sends.length'), 0);
  assert.equal(h.element('edit-message').textContent, 'No changes to apply.');
});

test('server conflict in an edited field blocks update and Reset loads current state', async () => {
  const h = editingHarness(); h.element('edit-color').value = '#ffffff';
  h.run("objectData.get(selectedId).color='#000000'"); await h.submit();
  assert.equal(h.run('sends.length'), 0);
  assert.match(h.element('edit-message').textContent, /changed on the server/);
  assert.equal(h.element('edit-color').value, '#ffffff');
  h.element('edit-reset').listeners.click(); assert.equal(h.element('edit-color').value, '#000000');
});

test('unrelated concurrent change does not get overwritten by edit', async () => {
  const h = editingHarness(); h.element('edit-position-z').value = '8';
  h.run("objectData.get(selectedId).color='#000000'"); await h.submit();
  assert.equal(h.run('sends.length'), 1);
  assert.equal(h.run("Object.hasOwn(sends[0],'color')"), false);
  assert.equal(h.element('edit-color').value, '#000000');
});

test('poll preserves unapplied fields and warns of remote changes', () => {
  const h = editingHarness(); h.element('edit-color').value = '#ffffff';
  h.element('edit-form').listeners.input({ target: { id: 'edit-color' } }); h.run("objectData.get(selectedId).color='#000000';selectObject(selectedId,true)");
  assert.equal(h.element('edit-color').value, '#ffffff');
  assert.equal(h.run('inspectorDirty'), true);
  assert.match(h.element('edit-message').textContent, /unapplied values are preserved/);
});

test('deletion hides inspector, and cancelled selection change preserves the draft', () => {
  const h = editingHarness(); h.element('edit-form').listeners.input({ target: { id: 'edit-color' } });
  h.context.window.confirm = () => false; h.run('selectObject(null)');
  assert.equal(h.run('selectedId'), 'shape-1');
  h.run('objectData.clear();selectObject(null,true)');
  assert.equal(h.element('edit-form').hidden, true); assert.equal(h.element('remove').disabled, true);
});

test('failed update retains draft and restores editable controls', async () => {
  const h = editingHarness(); h.element('edit-size-x').value = '7'; h.element('edit-form').listeners.input({ target: { id: 'edit-size-x' } });
  h.run("failure='Server rejected edit'"); await h.submit();
  assert.equal(h.element('edit-size-x').value, '7');
  assert.equal(h.run('inspectorDirty'), true);
  assert.match(h.element('edit-message').textContent, /Server rejected edit/);
  assert.equal(h.element('edit-fields').disabled, false);
});

test('server conflict refreshes authoritative state once, preserves the draft and never retries', async () => {
  const h = editingHarness();
  h.element('edit-color').value = '#ffffff';
  h.run("failure='Conflict: the shape changed';stateSnapshot={objects:[{...objectData.get(selectedId),color:'#000000'}]}");
  await h.submit();
  assert.equal(h.run('sends.length'), 1);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(stateReads)')), ['/state']);
  assert.equal(h.run('sends[0].expected.color'), '#c8a570');
  assert.equal(h.run('objectData.get(selectedId).color'), '#000000');
  assert.equal(h.element('edit-color').value, '#ffffff');
  assert.equal(h.run('inspectorDirty'), true);
  assert.match(h.element('edit-message').textContent, /proposal is preserved/);
  assert.equal(h.element('edit-fields').disabled, false);
});

test('drag settings do not mark object inspector fields dirty', () => {
  for (const id of ['move-plane', 'move-snap-enabled', 'move-grid-step']) {
    const h = editingHarness();
    h.element('edit-form').listeners.input({ target: { id } });
    assert.equal(h.run('inspectorDirty'), false, `${id} is a drag preference, not an object edit`);
  }
});

test('a second Apply while the first update is pending does not send a duplicate', async () => {
  const h = editingHarness();
  h.element('edit-position-x').value = '5';
  h.run(`command = async body => {
    sends.push(body);
    return new Promise(resolve => {
      globalThis.finishCommand = () => resolve({ revision: 2, object: { ...objectData.get(body.id), position: structuredClone(body.position) } });
    });
  }`);
  const first = h.submit();
  await h.submit();
  assert.equal(h.run('sends.length'), 1);
  h.run('finishCommand()');
  await first;
  assert.equal(h.run('sends.length'), 1);
});

test('a lost update response is confirmed from server state without retrying', async () => {
  const h = editingHarness();
  h.element('edit-position-x').value = '5';
  h.run(`movePreview = { objectId: selectedId, ghost: null };
    failure = 'Connection lost after write';
    stateSnapshot = { objects: [{ ...objectData.get(selectedId), position: { x: 5, y: 1, z: 0 } }] }`);
  await h.submit();
  assert.equal(h.run('sends.length'), 1);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(stateReads)')), ['/state']);
  assert.equal(h.run('movePreview'), null);
  assert.match(h.element('edit-message').textContent, /no retry was sent/i);
});

test('a permission change during drag disposes the preview and disables editing', () => {
  const h = editingHarness();
  let disposed = 0, removed = false;
  const ghost = {
    geometry: { dispose() { disposed++; } },
    material: { dispose() { disposed++; } },
    traverse(callback) { callback(this); },
  };
  h.context.scene = { remove: mesh => { removed = mesh === ghost; } };
  h.context.controls = { enabled: false };
  loadObjectDrag(h);
  h.run(`let objectSnapshot = JSON.stringify([objectFixture]), latestStateRevision = 1, worldRevision = 1, worldState = {},
    localMovementVersion = 0, moveRunning = false, playerPosition = {x:0,y:0,z:0}, playerVelocityY = 0,
    lastPosition = '0,0,0', otherPlayers = new Map();
    function positionKey(p) { return [p.x,p.y,p.z].join(','); }
    dragCandidate = { pointerId: 7, objectId: 'shape-1', started: true, ghost, previewPosition: {x:1,y:1,z:0} };
    $('move-preview-status').hidden = false; $('move-cancel').hidden = false;`);
  h.load('function renderWorld(state,', 'async function poll() {');
  const state = {
    revision: 2,
    me: { id: 'alice', role: 'viewer' },
    players: [{ id: 'alice', position: { x: 0, y: 0, z: 0 }, velocityY: 0 }],
    objects: [h.context.objectFixture],
  };
  h.run(`renderWorld(${JSON.stringify(state)})`);
  assert.equal(h.run('dragCandidate'), null);
  assert.equal(disposed, 2);
  assert.equal(removed, true);
  assert.equal(h.context.controls.enabled, true);
  assert.equal(h.element('move-preview-status').hidden, true);
  assert.equal(h.element('move-cancel').hidden, true);
  assert.equal(h.element('edit-fields').disabled, true);
  assert.equal(h.element('remove').disabled, true);
  assert.match(h.element('edit-message').textContent, /permission/i);
});

test('object dragging captures the pointer and suspends camera controls', () => {
  const h = editingHarness();
  h.context.capturedPointer = null;
  h.context.renderer = { domElement: { dataset: {}, setPointerCapture(id) { h.context.capturedPointer = id; } } };
  h.context.controls = { enabled: true };
  h.context.meshes = new Map([['shape-1', {}]]);
  loadObjectDrag(h);
  h.run(`pointerRay = () => ({ intersectObjects: () => [{ object: { userData: { worldId: 'shape-1' } } }] });
    beginObjectDrag({ button: 0, clientX: 5, clientY: 5, pointerId: 7 })`);
  assert.equal(h.context.capturedPointer, 7);
  assert.equal(h.context.controls.enabled, false);
  h.run('clearMovePreview()');
  assert.equal(h.context.controls.enabled, true);
});

test('pointer rays use resized canvas bounds', () => {
  const h = editingHarness();
  let rect = { left: 100, top: 50, width: 400, height: 300 };
  h.context.renderer = { domElement: { getBoundingClientRect: () => rect } };
  h.context.camera = {};
  h.context.THREE = {
    Vector2: class { constructor(x, y) { this.x = x; this.y = y; } },
    Raycaster: class { setFromCamera(point, camera) { this.point = point; this.camera = camera; } },
  };
  loadObjectDrag(h);
  const centeredRay = (x, y) => h.run(`pointerRay({ clientX: ${x}, clientY: ${y} })`);
  assert.deepEqual(JSON.parse(JSON.stringify(centeredRay(300, 200).point)), { x: 0, y: 0 });
  rect = { left: 200, top: 120, width: 1000, height: 700 };
  assert.deepEqual(JSON.parse(JSON.stringify(centeredRay(700, 470).point)), { x: 0, y: 0 });
});

test('clearing a local preview disposes its transient geometry and material', () => {
  const h = editingHarness();
  let geometryDisposed = 0, materialDisposed = 0, removed = false;
  h.context.controls = { enabled: true };
  h.context.ghostMesh = {
    geometry: { dispose() { geometryDisposed++; } },
    material: { dispose() { materialDisposed++; } },
    traverse(callback) { callback(this); },
  };
  h.context.scene = { remove: mesh => { removed = mesh === h.context.ghostMesh; } };
  loadObjectDrag(h);
  h.run('movePreview = { ghost: ghostMesh }; clearMovePreview()');
  assert.equal(geometryDisposed, 1);
  assert.equal(materialDisposed, 1);
  assert.equal(removed, true);
  assert.equal(h.run('movePreview'), null);
});
