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

function rendererResizeHarness() {
  const h=rendererHarness(), listeners={}, queries=[], ratios=[], sizes=[], aspects=[];
  let currentRatio=1;
  h.context.window={
    addEventListener:(name,listener)=>{listeners[name]=listener;},
    matchMedia:query=>{
      const item={query,listener:null,options:null,addEventListener(name,listener,options){if(name==='change'){this.listener=listener;this.options=options;}}};
      queries.push(item);return item;
    },
  };
  Object.assign(h.context,{
    innerWidth:900,innerHeight:600,devicePixelRatio:1,
    camera:{aspect:0,updateProjectionMatrix(){aspects.push(this.aspect);}},
    renderer:{
      getPixelRatio:()=>currentRatio,
      setPixelRatio:ratio=>{currentRatio=ratio;ratios.push(ratio);},
      setSize:(width,height)=>sizes.push([width,height]),
    },
  });
  if(h.has('function resizeRenderer()')){
    h.load('function resizeRenderer()','function watchPixelRatio()');
    h.load('function watchPixelRatio()','function initScene() {');
    h.load("window.addEventListener('resize', resizeRenderer);","renderer.setAnimationLoop(() => {");
    h.run('watchPixelRatio()');
  }else{
    h.load("window.addEventListener('resize', () => {","renderer.setAnimationLoop(() => {");
  }
  return {h,listeners,queries,ratios,sizes,aspects};
}
test('window resize updates the capped pixel ratio, camera, and canvas size',()=>{
  const {h,listeners,ratios,sizes,aspects}=rendererResizeHarness();
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

test('monitor DPI change updates rendering without a window resize and rearms the query',()=>{
  const {h,queries,ratios,sizes}=rendererResizeHarness();
  assert.equal(queries[0].query,'(resolution: 1dppx)');
  assert.deepEqual(queries[0].options,{once:true});
  h.context.devicePixelRatio=1.5;
  queries[0].listener();
  assert.deepEqual(ratios,[1.5]);
  assert.deepEqual(sizes,[[900,600]]);
  assert.equal(queries[1].query,'(resolution: 1.5dppx)');
  h.context.devicePixelRatio=2.5;
  queries[1].listener();
  assert.deepEqual(ratios,[1.5,2]);
  assert.equal(queries[2].query,'(resolution: 2.5dppx)');
});
