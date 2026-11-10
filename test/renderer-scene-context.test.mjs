import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

test('chat submission sends one immutable scene snapshot with the player request', async () => {
  const h = rendererHarness(), calls = [];
  const snapshot = {
    world: 'http://world.example',
    revision: 7,
    selectedIds: ['object-1'],
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, fov: 42, aspect: 1.5, width: 900, height: 600 },
    objects: [{ id: 'object-1', type: 'block', inCameraFrustum: true }],
  };
  h.context.sceneContextForPrompt = () => structuredClone(snapshot);
  h.context.bridge = { sendPrompt: async (...args) => { calls.push(args); } };
  h.context.addMessage = () => {};
  h.context.startActivity = () => {};
  h.context.updateChatControls = () => {};
  h.run("let connected=true,busy=false,streamMessage=null;");
  h.load("$('chat-form').addEventListener", "$('interrupt').addEventListener");

  h.element('prompt').value = 'Make this taller';
  await h.element('chat-form').listeners.submit({ preventDefault() {} });

  assert.equal(calls.length, 1, 'scene context travels in the same native request, not a second turn');
  assert.equal(calls[0][0], 'Make this taller');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), snapshot);
});
