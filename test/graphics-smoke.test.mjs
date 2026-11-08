import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { isGraphicsFailure, observeGraphics, closeSmokeApp, withSmokeCleanup } from '../scripts/graphics-smoke.mjs';

function fakePage({ messages = [], errors = [] } = {}) {
  const page = new EventEmitter();
  const document = new EventEmitter();
  const state = { sceneError: { hidden: true, textContent: '' }, lost: false, hasContext: true };
  document.addEventListener = document.on.bind(document);
  document.querySelector = selector => selector === '#scene-error' ? state.sceneError : {
    getContext: () => state.hasContext ? { isContextLost: () => state.lost, getExtension: () => null, getParameter: () => 'test-renderer', getContextAttributes: () => ({ alpha: true }), drawingBufferWidth: 640, drawingBufferHeight: 480 } : null
  };
  const context = vm.createContext({ window: {}, document, console: { warn: text => page.emit('console', { text: () => text }) } });
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
  const graphics = await observeGraphics(page, { log: () => {} });
  await graphics.assertHealthy();
  await graphics.assertHealthy();
  graphics.assertNoErrors();
});

test('startup console and page errors are not lost before listeners attach', async () => {
  for (const history of [{ messages: ['WebGL initialization failed'] }, { errors: [new Error('startup failure')] }]) {
    const graphics = await observeGraphics(fakePage(history).page, { log: () => {} });
    await assert.rejects(graphics.assertHealthy(), /renderer\/graphics errors/);
  }
});

test('late graphics errors and shutdown errors remain failures', async () => {
  const { page } = fakePage();
  const graphics = await observeGraphics(page, { log: () => {} });
  await graphics.assertHealthy();
  page.emit('console', { text: () => 'THREE.WebGLRenderer: Context Lost.' });
  await assert.rejects(graphics.assertHealthy(), /renderer\/graphics errors/);
  assert.throws(() => graphics.assertNoErrors(), /renderer\/graphics errors/);
});

test('context loss remains a failure even if the context subsequently recovers', async () => {
  const { page, document } = fakePage();
  const graphics = await observeGraphics(page, { log: () => {} });
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
    const graphics = await observeGraphics(fake.page, { log: () => {} });
    await graphics.assertHealthy();
    mutate(fake);
    await assert.rejects(graphics.assertHealthy());
  }
});


test('cleanup preserves original error identity and stack when cleanup succeeds', async () => {
  const original = new Error('primary operation failed'), calls = [];
  const stack = original.stack;
  await assert.rejects(withSmokeCleanup(() => { throw original; }, () => calls.push('close'), () => calls.push('remove')), error => error === original && error.stack === stack);
  assert.deepEqual(calls, ['close', 'remove']);
  assert.equal(await withSmokeCleanup(() => 42, () => calls.push('successful cleanup')), 42);
});

test('cleanup-only failure fails the test and does not skip later removals', async () => {
  const removal = new Error('work removal failed'), calls = [];
  await assert.rejects(withSmokeCleanup(() => {}, () => { calls.push('work'); throw removal; }, () => calls.push('data'), () => calls.push('install')), error => error === removal);
  assert.deepEqual(calls, ['work', 'data', 'install']);
});

test('primary, graphics, close and removal errors survive together and every cleanup runs', async () => {
  const [primary, health, close, events, removal] = ['primary', 'health', 'close', 'events', 'removal'].map(message => new Error(message));
  const calls = [];
  const app = { close() { calls.push('close'); throw close; } };
  const graphics = { phase(value) { calls.push(value); }, assertHealthy() { calls.push('health'); throw health; }, assertNoErrors() { calls.push('events'); throw events; } };
  await assert.rejects(withSmokeCleanup(() => { throw primary; }, () => closeSmokeApp(app, graphics, 'final cleanup'),
    () => { calls.push('work'); throw removal; }, () => calls.push('data'), () => calls.push('install')), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[0].stack, primary.stack);
    assert.equal(error.errors[1].cause, health);
    assert.deepEqual(error.errors[1].errors, [health, close, events]);
    assert.equal(error.errors[2], removal);
    return true;
  });
  assert.deepEqual(calls, ['final cleanup', 'health', 'close', 'events', 'work', 'data', 'install']);
});

test('observer initialization failure remains primary when no graphics handle was assigned', async () => {
  const { page } = fakePage(), logs = [];
  const primary = new Error('page history unavailable'), close = new Error('close failed');
  page.pageErrors = async () => { throw primary; };
  let graphics, closed = false;
  await assert.rejects(withSmokeCleanup(async () => { graphics = await observeGraphics(page, { log: line => logs.push(line) }); },
    () => closeSmokeApp({ close() { closed = true; throw close; } }, graphics)), error => {
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, close]);
    return true;
  });
  assert.equal(closed, true);
  assert.ok(logs.some(line => line.includes('observer-setup-failed')));
});

test('diagnostics separate buffered history from live phase and page event timestamps', async () => {
  const { page, document } = fakePage({ messages: ['WebGL startup failed'] }), logs = [];
  let time = 100;
  const graphics = await observeGraphics(page, { label: 'first launch', now: () => time, log: line => logs.push(JSON.parse(line.slice('Graphics smoke '.length))) });
  assert.ok(logs.some(log => log.fromHistory === true && log.observedAfterMs === 0));
  time = 125; graphics.phase('construction');
  document.emit('webglcontextlost', { timeStamp: 17 });
  document.emit('webglcontextrestored', { timeStamp: 19 });
  await assert.rejects(graphics.assertHealthy(), /WebGL context must remain healthy/);
  const failure = logs.find(log => log.event === 'check-failed');
  assert.equal(failure.launch, 'first launch');
  assert.equal(failure.phase, 'construction');
  assert.equal(failure.observedAfterMs, 25);
  assert.deepEqual(failure.lastState.contextEvents, [{ type: 'webglcontextlost', pageEventTimeMs: 17 }, { type: 'webglcontextrestored', pageEventTimeMs: 19 }]);
  assert.ok(logs.some(log => log.fromHistory === false && log.message.includes('webglcontextlost')));
});

test('crashed-page history or evaluate failures retain the last sampled state in diagnostics', async () => {
  for (const method of ['pageErrors', 'consoleMessages', 'evaluate']) {
    const { page } = fakePage(), logs = [];
    const graphics = await observeGraphics(page, { log: line => logs.push(JSON.parse(line.slice('Graphics smoke '.length))) });
    await graphics.assertHealthy();
    graphics.phase('final cleanup');
    const unavailable = new Error(`${method} unavailable after crash`);
    page[method] = async () => { throw unavailable; };
    await assert.rejects(graphics.assertHealthy(), error => error === unavailable);
    const diagnostic = logs.at(-1);
    assert.equal(diagnostic.event, 'check-failed');
    assert.equal(diagnostic.phase, 'final cleanup');
    assert.equal(diagnostic.lastState.hasContext, true);
    assert.equal(diagnostic.lastState.contextLost, false);
  }
});

test('diagnostic logging is bounded without suppressing graphics failures', async () => {
  const { page } = fakePage(), logs = [];
  const graphics = await observeGraphics(page, { log: line => logs.push(line) });
  for (let count = 0; count < 100; count++) graphics.phase(`phase ${count}`);
  page.emit('console', { text: () => 'WebGL context creation failed' });
  await assert.rejects(graphics.assertHealthy(), /renderer\/graphics errors/);
  assert.equal(logs.length, 81);
  assert.match(logs.at(-1), /diagnostic-limit/);
});


test('a failed diagnostic logger cannot mask graphics failure or prevent app.close', async () => {
  const { page, state } = fakePage();
  const loggerError = new Error('diagnostic output failed');
  const graphics = await observeGraphics(page, { log() { throw loggerError; } });
  await graphics.assertHealthy();
  state.lost = true;
  let closed = false;
  await assert.rejects(closeSmokeApp({ close() { closed = true; } }, graphics), error => {
    assert.notEqual(error, loggerError);
    assert.match(error.message, /WebGL context must remain healthy/);
    return true;
  });
  assert.equal(closed, true);
});


test('initial GL snapshot is captured while healthy before later loss', async () => {
  const { page, state } = fakePage(), logs = [];
  const graphics = await observeGraphics(page, { log: line => logs.push(JSON.parse(line.slice('Graphics smoke '.length))) });
  const initial = logs.find(line => line.event === 'initial-gl');
  assert.equal(initial.state.available, true);
  assert.equal(initial.state.renderer, 'test-renderer');
  assert.deepEqual(initial.state.drawingBuffer, [640, 480]);
  assert.deepEqual(initial.state.attributes, { alpha: true });
  state.lost = true;
  await assert.rejects(graphics.assertHealthy(), /WebGL context must remain healthy/);
  assert.equal(initial.state.available, true);
});
