import assert from 'node:assert/strict';

// Preserve the first failure and still attempt every independent cleanup action.
export async function withSmokeCleanup(work, ...cleanup) {
  const errors = [];
  let result;
  try { result = await work(); } catch (error) { errors.push(error); }
  for (const action of cleanup) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Smoke failed; original error followed by cleanup errors', { cause: errors[0] });
  return result;
}

export async function closeSmokeApp(app, graphics, phase = 'normal close') {
  if (!app) return;
  await withSmokeCleanup(async () => { graphics?.phase(phase); await graphics?.assertHealthy(); },
    () => app.close(), () => graphics?.assertNoErrors());
}

export function isGraphicsFailure(message) {
  return /(?:webgl|gpu|graphics|three\.webglrenderer).*(?:lost|fail|error|unavailable)|(?:lost|fail|error).*(?:webgl|gpu|graphics)|gl_invalid_/i.test(message);
}

// History timestamps mean "observed now", not when a buffered startup event occurred.
export async function observeGraphics(page, { label = 'launch', log = console.log, now = Date.now } = {}) {
  const started = now(), failures = new Set();
  let phase = 'observer setup', lastState = null, reports = 0;
  const report = (event, details = {}) => {
    if (reports > 80) return;
    if (reports++ === 80) { event = 'diagnostic-limit'; details = {}; }
    // Diagnostics must never replace the test/graphics failure or prevent app.close.
    try { log(`Graphics smoke ${JSON.stringify({ launch: label, phase, observedAfterMs: now() - started, event, ...details })}`); } catch {}
  };
  const failure = (event, message, fromHistory = false) => {
    if (!failures.has(message)) report(event, { message, fromHistory });
    failures.add(message);
  };
  const onError = (error, history = false) => failure('pageerror', error.message, history);
  const onConsole = (message, history = false) => {
    const text = message.text();
    if (isGraphicsFailure(text)) failure('graphics-console', text, history);
    else if (text.startsWith('TUS_SMOKE_CONTEXT_EVENT ')) report('context-event', { message: text, fromHistory: history });
  };
  const history = async () => {
    for (const error of await page.pageErrors()) onError(error, true);
    for (const message of await page.consoleMessages()) onConsole(message, true);
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('crash', () => failure('crash', 'Renderer crashed'));
  report('start');
  try {
    await history();
    await page.evaluate(() => {
      window.__smokeContextLost = false;
      window.__smokeGraphicsEvents = [];
      for (const type of ['webglcontextlost', 'webglcontextrestored']) document.addEventListener(type, event => {
        if (type === 'webglcontextlost') window.__smokeContextLost = true;
        const observed = { type, pageEventTimeMs: event?.timeStamp ?? null };
        window.__smokeGraphicsEvents.push(observed);
        window.__smokeGraphicsEvents = window.__smokeGraphicsEvents.slice(-20);
        console.warn(`TUS_SMOKE_CONTEXT_EVENT ${JSON.stringify(observed)}`);
      }, true);
    });
  } catch (error) {
    report('observer-setup-failed', { message: error.message });
    throw error;
  }
  return {
    phase(value) { phase = value; report('phase'); },
    assertNoErrors() { assert.deepEqual([...failures], [], 'renderer/graphics errors during smoke lifecycle'); },
    async assertHealthy() {
      try {
        await history();
        lastState = await page.evaluate(() => {
          const canvas = document.querySelector('#viewport canvas');
          const context = canvas?.getContext('webgl2');
          const error = document.querySelector('#scene-error');
          return {
            sceneError: error && !error.hidden ? error.textContent : '',
            hasContext: Boolean(context),
            contextLost: Boolean(window.__smokeContextLost || context?.isContextLost()),
            contextEvents: window.__smokeGraphicsEvents
          };
        });
        report('state', { state: lastState });
        assert.equal(lastState.sceneError, '', 'scene error must remain hidden');
        assert.equal(lastState.hasContext, true, 'rendered scene must have a WebGL2 context');
        assert.equal(lastState.contextLost, false, 'WebGL context must remain healthy');
        this.assertNoErrors();
      } catch (error) {
        report('check-failed', { message: error.message, lastState });
        throw error;
      }
    }
  };
}
