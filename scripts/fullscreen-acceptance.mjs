import assert from 'node:assert/strict';

export async function fullscreenAcceptance(app, page) {
  const isFullscreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
  const expectFullscreen = async expected => {
    await page.waitForFunction(value => document.querySelector('#fullscreen-toggle')?.getAttribute('aria-pressed') === String(value), expected, { timeout: 10000 });
    assert.equal(await isFullscreen(), expected, 'UI follows the native window state');
    await page.waitForFunction(() => {
      const rect = document.querySelector('#viewport canvas')?.getBoundingClientRect();
      return rect && Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1;
    }, null, { timeout: 10000 });
  };
  const readWorld = () => page.evaluate(async () => {
    const settings = await window.tus.loadSettings();
    return window.tus.request({ ...settings, path: '/state' });
  });
  await page.waitForFunction(async () => {
    const settings = await window.tus.loadSettings();
    const state = await window.tus.request({ ...settings, path: '/state' });
    return state.players?.some(player => player.id === state.me?.id) === true;
  }, null, { timeout: 10000, polling: 250 });
  const before = await readWorld();
  const normalSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  const button = page.locator('#fullscreen-toggle');
  assert.equal(await button.count(), 1);
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  assert.equal(await button.innerText(), 'Full screen');

  await assert.rejects(page.evaluate(() => window.tus.toggleFullscreen(true)), /argument/i);
  assert.equal(await isFullscreen(), false, 'invalid IPC input does not change the window');

  await button.click();
  await expectFullscreen(true);
  assert.equal(await button.innerText(), 'Exit full screen');

  await page.locator('#settings-open').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings').isVisible(), false, 'Escape closes the dialog first');
  assert.equal(await isFullscreen(), true, 'closing a dialog does not exit fullscreen');
  await page.keyboard.press('Escape');
  await expectFullscreen(false);

  await page.keyboard.press('F11');
  await expectFullscreen(true);
  await page.keyboard.press('F11');
  await expectFullscreen(false);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await expectFullscreen(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await expectFullscreen(false);

  const after = await readWorld();
  assert.deepEqual(after.players, before.players, 'fullscreen leaves player position unchanged');
  assert.equal(after.revision, before.revision, 'fullscreen never sends a world command');
  assert.deepEqual(after.objects, before.objects);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()), normalSize, 'exiting fullscreen restores windowed bounds');
}
