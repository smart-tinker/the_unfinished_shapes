import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

test('cancel is enabled only while an update package is downloading', () => {
  const h = rendererHarness();
  h.run('let checkedUpdate = null, updateBusy = false, updateDownloaded = false, updateExtracted = false, updateDownloading = false;');
  h.load('function updateButtons() {', 'async function saveUpdatePreference() {');

  h.run('updateBusy = true; updateButtons()');
  assert.equal(h.element('updates-cancel').disabled, true, 'release checks cannot be cancelled as downloads');

  h.run("checkedUpdate = { status: 'available', distribution: 'portable' }; updateDownloaded = true; updateBusy = true; updateButtons()");
  assert.equal(h.element('updates-cancel').disabled, true, 'archive extraction cannot be cancelled as a download');

  h.run('updateDownloading = true; updateBusy = true; updateButtons()');
  assert.equal(h.element('updates-cancel').disabled, false, 'an active download can be cancelled');

  h.run('updateDownloading = false; updateBusy = false; updateButtons()');
  assert.equal(h.element('updates-cancel').disabled, true, 'completed operations cannot be cancelled');
});

test('cancelled update download reports cancellation and restores retry controls', async () => {
  const h = rendererHarness();
  h.run(`const bridge = {
    downloadUpdate: async () => { const error = new Error('The operation was aborted'); error.name = 'AbortError'; throw error; },
    cancelUpdate: async () => false,
    onUpdateProgress: () => {},
  };`);
  h.load('let checkedUpdate = null, updateDownloaded', 'const toolRows = new Map(), itemRows');
  h.run("checkedUpdate = { status: 'available', channel: 'prerelease', distribution: 'portable' }; updateButtons()");

  await h.element('updates-download').listeners.click();

  assert.match(h.element('updates-status').textContent, /cancelled/i);
  assert.equal(h.element('updates-download').disabled, false, 'the selected package can be retried');
  assert.equal(h.element('updates-cancel').disabled, true, 'a completed cancellation cannot be repeated');
});
