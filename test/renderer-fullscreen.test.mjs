import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function fullscreenHarness({ focusedTag = 'BODY', fullscreen = true, dragging = false, dialogOpen = false } = {}) {
  const h = rendererHarness();
  const listeners = {};
  h.context.toggleCalls = [];
  h.context.isFullscreen = fullscreen;
  h.context.dialogOpen = dialogOpen;
  h.context.bridge = { toggleFullscreen: () => { h.context.toggleCalls.push('toggle'); h.context.isFullscreen = !h.context.isFullscreen; } };
  h.context.requestFullscreenToggle = () => h.context.bridge.toggleFullscreen();
  Object.assign(h.context, {
    window: { addEventListener: (name, listener) => { listeners[name] = listener; } },
    document: {
      activeElement: { tagName: focusedTag },
      querySelector: selector => selector === 'dialog[open]' && h.context.dialogOpen ? {} : null,
    },
  });
  h.run(`let keys = new Set(), dragCandidate = null, movePreview = null, jumpRequested = false, cancelled = 0;
    function cancelMovePreview() { dragCandidate = null; movePreview = null; cancelled++; }
    if (${dragging}) movePreview = { objectId: 'shape-1' };`);
  h.load("window.addEventListener('keydown', event => {", "window.addEventListener('keyup'");
  return { h, keydown: listeners.keydown };
}

function press(keydown, code, key = code) {
  const event = { code, key, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  keydown(event);
  return event;
}

test('F11 toggles native fullscreen without becoming a game movement key', () => {
  const { h, keydown } = fullscreenHarness({ fullscreen: false });
  const event = press(keydown, 'F11');
  assert.deepEqual(h.context.toggleCalls, ['toggle']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.run("keys.has('f11')"), false);
});

test('Escape exits fullscreen only after higher-priority UI and drag handling', () => {
  const normal = fullscreenHarness();
  const event = press(normal.keydown, 'Escape');
  assert.deepEqual(normal.h.context.toggleCalls, ['toggle']);
  assert.equal(event.defaultPrevented, true);

  const input = fullscreenHarness({ focusedTag: 'TEXTAREA' });
  press(input.keydown, 'Escape');
  assert.deepEqual(input.h.context.toggleCalls, [], 'typing focus keeps Escape local to the field');

  const dialog = fullscreenHarness();
  dialog.h.context.dialogOpen = true;
  press(dialog.keydown, 'Escape');
  assert.deepEqual(dialog.h.context.toggleCalls, [], 'an open dialog keeps Escape');

  const drag = fullscreenHarness({ dragging: true });
  press(drag.keydown, 'Escape');
  assert.deepEqual(drag.h.context.toggleCalls, [], 'Escape cancels the local preview before fullscreen');
  assert.equal(drag.h.run('cancelled'), 1);
});

test('Escape gives an open dialog priority over drag cancellation and fullscreen', () => {
  const { h, keydown } = fullscreenHarness({ dragging: true, dialogOpen: true });
  const closeDialog = press(keydown, 'Escape');
  assert.equal(closeDialog.defaultPrevented, false, 'the native dialog handles Escape');
  assert.equal(h.run('cancelled'), 0, 'the underlying drag preview remains intact');
  assert.deepEqual(h.context.toggleCalls, []);

  h.context.dialogOpen = false;
  const cancelDrag = press(keydown, 'Escape');
  assert.equal(cancelDrag.defaultPrevented, true);
  assert.equal(h.run('cancelled'), 1);
  assert.deepEqual(h.context.toggleCalls, []);

  press(keydown, 'Escape');
  assert.deepEqual(h.context.toggleCalls, ['toggle']);
});

test('resize reapplies the capped pixel ratio when display DPI changes',()=>{
 const h=rendererHarness(), listeners={}, ratios=[], sizes=[], aspects=[];
 h.context.window={addEventListener:(name,listener)=>{listeners[name]=listener;}};
 Object.assign(h.context,{
  innerWidth:900,innerHeight:600,devicePixelRatio:1,
  camera:{aspect:0,updateProjectionMatrix(){aspects.push(this.aspect);}},
  renderer:{setPixelRatio:ratio=>ratios.push(ratio),setSize:(width,height)=>sizes.push([width,height])},
 });
 h.load("window.addEventListener('resize', () => {", "renderer.setAnimationLoop(() => {");
 assert.equal(typeof listeners.resize,'function');
 h.context.innerWidth=1200;h.context.innerHeight=800;h.context.devicePixelRatio=1.5;
 listeners.resize();
 assert.deepEqual(ratios,[1.5]);
 assert.deepEqual(sizes,[[1200,800]]);
 assert.equal(h.context.camera.aspect,1.5);
 h.context.innerWidth=1600;h.context.innerHeight=900;h.context.devicePixelRatio=3;
 listeners.resize();
 assert.deepEqual(ratios,[1.5,2]);
 assert.deepEqual(sizes,[[1200,800],[1600,900]]);
 assert.ok(Math.abs(h.context.camera.aspect-1600/900)<1e-9);
 assert.deepEqual(aspects,[1.5,1600/900]);
});
