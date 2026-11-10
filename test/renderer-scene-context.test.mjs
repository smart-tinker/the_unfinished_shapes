import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

const camera = {
  position: { x: 1, y: 2, z: 3 },
  target: { x: 0, y: 0, z: 0 },
  fov: 42, aspect: 1.5, near: 0.1, far: 220,
  viewport: { width: 900, height: 600 },
};

function sceneHarness(selectedId = 'object-1') {
  const h = rendererHarness();
  h.run(`let selectedId=${JSON.stringify(selectedId)}, worldRevision=7,
    camera={position:{x:1,y:2,z:3},fov:42,aspect:1.5,near:0.1,far:220},
    controls={target:{x:0,y:0,z:0}},
    renderer={domElement:{clientWidth:900,clientHeight:600}};`);
  return h;
}

test('scene capture freezes camera, revision and an empty selection', () => {
  const h = sceneHarness(null);
  assert.equal(h.has('function sceneContextForPrompt() {'), true, 'renderer must expose the captured scene view');
  h.load('function sceneContextForPrompt() {', "$('chat-form').addEventListener");
  const captured = h.run('sceneContextForPrompt()');

  assert.deepEqual(JSON.parse(JSON.stringify(captured)), {
    revision: 7,
    selectedIds: [],
    camera,
  });
  h.run('camera.position.x = 99; selectedId = "changed-after-capture";');
  assert.equal(captured.camera.position.x, 1);
  assert.deepEqual(captured.selectedIds, []);
});

test('chat submits the captured scene in the same native request and reports the accepted context', async () => {
  const h = sceneHarness(), calls = [];
  h.context.bridge = {
    sendPrompt: async (...args) => {
      calls.push(args);
      return { sceneContext: { revision: 7, selectedCount: 1, includedObjectCount: 2, totalObjectCount: 3, truncated: true } };
    },
  };
  h.context.addMessage = () => {};
  h.context.startActivity = () => {};
  h.context.updateChatControls = () => {};
  h.run('let connected=true,busy=false,streamMessage=null;');
  assert.equal(h.has('function sceneContextForPrompt() {'), true, 'chat must capture the actual renderer camera and selection');
  h.load('function sceneContextForPrompt() {', "$('interrupt').addEventListener");

  h.element('prompt').value = 'Make this taller';
  await h.element('chat-form').listeners.submit({ preventDefault() {} });

  assert.equal(calls.length, 1, 'scene context travels in the same native request, not a second turn');
  assert.equal(calls[0][0], 'Make this taller');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), {
    revision: 7,
    selectedIds: ['object-1'],
    camera,
  });
  assert.match(h.element('scene-context-status').textContent, /revision 7.*1 selected.*2\/3 objects.*partial/i);
});
