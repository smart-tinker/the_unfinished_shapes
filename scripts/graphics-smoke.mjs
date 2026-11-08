import assert from 'node:assert/strict';

export function isGraphicsFailure(message) {
  return /(?:webgl|gpu|graphics|three\.webglrenderer).*(?:lost|fail|error|unavailable)|(?:lost|fail|error).*(?:webgl|gpu|graphics)|gl_invalid_/i.test(message);
}

// Keep listeners alive until app.close completes; startup history covers events before firstWindow.
export async function observeGraphics(page) {
  const failures = new Set();
  const onError = error => failures.add(error.message);
  const onConsole = message => {
    if (isGraphicsFailure(message.text())) failures.add(message.text());
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('crash', () => failures.add('Renderer crashed'));
  for (const error of await page.pageErrors()) onError(error);
  for (const message of await page.consoleMessages()) onConsole(message);
  await page.evaluate(() => {
    window.__smokeContextLost = false;
    document.addEventListener('webglcontextlost', () => { window.__smokeContextLost = true; }, true);
  });
  return {
    assertNoErrors() { assert.deepEqual([...failures], [], 'renderer/graphics errors during smoke lifecycle'); },
    async assertHealthy() {
      for (const error of await page.pageErrors()) onError(error);
      for (const message of await page.consoleMessages()) onConsole(message);
      const state = await page.evaluate(() => {
        const canvas = document.querySelector('#viewport canvas');
        const context = canvas?.getContext('webgl2');
        const error = document.querySelector('#scene-error');
        return {
          sceneError: error && !error.hidden ? error.textContent : '',
          hasContext: Boolean(context),
          contextLost: Boolean(window.__smokeContextLost || context?.isContextLost())
        };
      });
      assert.equal(state.sceneError, '', 'scene error must remain hidden');
      assert.equal(state.hasContext, true, 'rendered scene must have a WebGL2 context');
      assert.equal(state.contextLost, false, 'WebGL context must remain healthy');
      this.assertNoErrors();
    }
  };
}
