import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function editingHarness() {
  const h = rendererHarness();
  Object.assign(h.context, { window: { confirm: () => true }, THREE: {}, scene: {}, meshes: new Map(), feedback: () => {}, settingsGeneration: 0, poll: async () => {} });
  h.run(`let selectedId='shape-1', inspectorBase=null, inspectorDirty=false, editing=false, role='builder', meId='alice';
    const objectData=new Map(); let selectionBox=null; let sends=[]; let failure=null;
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
  h.element('edit-form').listeners.input(); h.run("objectData.get(selectedId).color='#000000';selectObject(selectedId,true)");
  assert.equal(h.element('edit-color').value, '#ffffff');
  assert.equal(h.run('inspectorDirty'), true);
  assert.match(h.element('edit-message').textContent, /unapplied values are preserved/);
});

test('deletion hides inspector, and cancelled selection change preserves the draft', () => {
  const h = editingHarness(); h.element('edit-form').listeners.input();
  h.context.window.confirm = () => false; h.run('selectObject(null)');
  assert.equal(h.run('selectedId'), 'shape-1');
  h.run('objectData.clear();selectObject(null,true)');
  assert.equal(h.element('edit-form').hidden, true); assert.equal(h.element('remove').disabled, true);
});

test('failed update retains draft and restores editable controls', async () => {
  const h = editingHarness(); h.element('edit-size-x').value = '7'; h.element('edit-form').listeners.input();
  h.run("failure='Server rejected edit'"); await h.submit();
  assert.equal(h.element('edit-size-x').value, '7');
  assert.equal(h.run('inspectorDirty'), true);
  assert.match(h.element('edit-message').textContent, /Server rejected edit/);
  assert.equal(h.element('edit-fields').disabled, false);
});

test('server conflict after local check preserves draft, refreshes once and never retries', async () => {
  const h = editingHarness(); let refreshes = 0; h.context.poll = async () => { refreshes++; };
  h.element('edit-color').value = '#ffffff'; h.run("failure='Conflict: the shape changed'");
  await h.submit();
  assert.equal(h.run('sends.length'), 1); assert.equal(refreshes, 1);
  assert.equal(h.run('sends[0].expected.color'), '#c8a570');
  assert.equal(h.element('edit-color').value, '#ffffff'); assert.equal(h.run('inspectorDirty'), true);
  assert.match(h.element('edit-message').textContent, /unapplied values are preserved/);
  assert.equal(h.element('edit-fields').disabled, false);
});
