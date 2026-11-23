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

test('structured IPC cancellation reports cancellation and restores retry controls', async () => {
  const h = rendererHarness();
  h.run(`const bridge = {
    downloadUpdate: async () => ({ cancelled: true }),
    cancelUpdate: async () => false,
    onUpdateProgress: () => {},
  };`);
  h.load('const updateStatus = text =>', 'function showStartupUpdateNotice(');
  h.load('let checkedUpdate = null', 'const toolRows = new Map(), itemRows');
  h.run("checkedUpdate = { status: 'available', channel: 'prerelease', distribution: 'portable' }; updateButtons()");

  await h.element('updates-download').listeners.click();

  assert.match(h.element('updates-status').textContent, /cancelled/i);
  assert.equal(h.element('updates-download').disabled, false, 'the selected package can be retried');
  assert.equal(h.element('updates-cancel').disabled, true, 'a completed cancellation cannot be repeated');
});


test('startup release rate limit is explained from its safe category',()=>{
 const h=rendererHarness();
 h.run("const updateStatus = text => { $('updates-status').textContent = text; };");
 h.load('function showStartupUpdateNotice(', 'let checkedUpdate = null,');
 h.run("showStartupUpdateNotice({ status: 'unavailable', errorCode: 'rate_limited' })");
 assert.equal(h.element('updates-notice').dataset.errorCode,'rate_limited');
 assert.match(h.element('updates-notice').title,/rate limit/i);
 assert.match(h.element('updates-status').textContent,/rate limit/i);
});

test('launch click records bounded renderer invoke state', async () => {
  const h = rendererHarness();
  h.run(`let resolveLaunch;
    const bridge = { launchUpdate: () => new Promise(resolve => { resolveLaunch = resolve; }) };
    const updateStatus = text => { $('updates-status').textContent = text; };`);
  h.load("$('updates-launch').addEventListener('click', async () => {", 'bridge?.onUpdateProgress(');

  const status = h.element('updates-status');
  const pending = h.element('updates-launch').listeners.click();
  assert.equal(status.dataset.updateLaunchClickStatus, 'received');
  assert.equal(status.dataset.updateLaunchInvokeStatus, 'pending');

  h.run('resolveLaunch({ started: false })');
  await pending;
  assert.equal(status.dataset.updateLaunchInvokeStatus, 'fulfilled');

  h.run(`bridge.launchUpdate = async () => { throw new Error('test rejection'); };`);
  await h.element('updates-launch').listeners.click();
  assert.equal(status.dataset.updateLaunchClickStatus, 'received');
  assert.equal(status.dataset.updateLaunchInvokeStatus, 'rejected');
});
