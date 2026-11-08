import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { isGraphicsFailure, observeGraphics } from '../scripts/graphics-smoke.mjs';

function fakePage({ messages = [], errors = [] } = {}) {
  const page = new EventEmitter();
  const document = new EventEmitter();
  const state = { sceneError: { hidden: true, textContent: '' }, lost: false, hasContext: true };
  document.addEventListener = document.on.bind(document);
  document.querySelector = selector => selector === '#scene-error' ? state.sceneError : {
    getContext: () => state.hasContext ? { isContextLost: () => state.lost } : null
  };
  const context = vm.createContext({ window: {}, document });
  page.evaluate = async fn => vm.runInContext(`(${fn.toString()})()`, context);
  page.pageErrors = async () => errors;
  page.consoleMessages = async () => messages.map(text => ({ text: () => text }));
  return { page, document, state };
}

test('graphics diagnostics distinguish failures from ordinary messages', () => {
  for (const text of ['THREE.WebGLRenderer: Context Lost.', 'WebGL context creation failed', 'GPU process error', 'GL_INVALID_OPERATION']) {
    assert.equal(isGraphicsFailure(text), true, text);
  }
  assert.equal(isGraphicsFailure('World connected'), false);
});

test('healthy scene passes repeated lifecycle checks', async () => {
  const { page } = fakePage();
  const graphics = await observeGraphics(page);
  await graphics.assertHealthy();
  await graphics.assertHealthy();
  graphics.assertNoErrors();
});

test('startup console and page errors are not lost before listeners attach', async () => {
  for (const history of [{ messages: ['WebGL initialization failed'] }, { errors: [new Error('startup failure')] }]) {
    const graphics = await observeGraphics(fakePage(history).page);
    await assert.rejects(graphics.assertHealthy(), /renderer\/graphics errors/);
  }
});

test('late graphics errors and shutdown errors remain failures', async () => {
  const { page } = fakePage();
  const graphics = await observeGraphics(page);
  await graphics.assertHealthy();
  page.emit('console', { text: () => 'THREE.WebGLRenderer: Context Lost.' });
  await assert.rejects(graphics.assertHealthy(), /renderer\/graphics errors/);
  assert.throws(() => graphics.assertNoErrors(), /renderer\/graphics errors/);
});

test('context loss remains a failure even if the context subsequently recovers', async () => {
  const { page, document } = fakePage();
  const graphics = await observeGraphics(page);
  await graphics.assertHealthy();
  document.emit('webglcontextlost');
  await assert.rejects(graphics.assertHealthy(), /WebGL context must remain healthy/);
});

test('late scene errors, unavailable contexts and renderer crashes fail', async () => {
  for (const mutate of [
    ({ state }) => { state.sceneError = { hidden: false, textContent: 'Rendering unavailable' }; },
    ({ state }) => { state.hasContext = false; },
    ({ state }) => { state.lost = true; },
    ({ page }) => page.emit('crash'),
    ({ page }) => page.emit('pageerror', new Error('late renderer error'))
  ]) {
    const fake = fakePage();
    const graphics = await observeGraphics(fake.page);
    await graphics.assertHealthy();
    mutate(fake);
    await assert.rejects(graphics.assertHealthy());
  }
});
