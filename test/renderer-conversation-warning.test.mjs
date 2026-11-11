import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rendererHarness } from './support/renderer-harness.mjs';

function connectionHarness({ resumed = true, failure = null } = {}) {
  const h = rendererHarness(), calls = [], messages = [], saved = [];
  h.context.bridge = {
    connectCodex: async options => { calls.push(options); if (failure) throw new Error(failure); return { threadId: resumed ? 'saved-thread' : 'new-explicit-thread', resumed }; },
    saveSettings: async value => { saved.push(value); },
  };
  Object.assign(h.context, { saveSettings: async () => {}, updateChatControls: () => {}, addMessage: text => messages.push(text) });
  h.run("let settings={threadId:'saved-thread',token:'session-token'},connected=false;");
  h.element('settings').close = () => {};
  h.element('new-game-thread').checked = false;
  h.load("$('settings-form').addEventListener('submit'", 'const toolRows =');
  return { ...h, calls, messages, saved, submit: () => h.element('settings-form').listeners.submit({ preventDefault() {} }) };
}

test('settings explains creation-time tool schemas and history preservation beside unchecked opt-in', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const checkbox = html.match(/<input id="new-game-thread"[^>]*>/)?.[0];
  assert.ok(checkbox); assert.doesNotMatch(checkbox, /\bchecked\b/);
  assert.match(checkbox, /aria-describedby="conversation-tools-note"/);
  const note = html.match(/<p id="conversation-tools-note"[^>]*>(.*?)<\/p>/)?.[1];
  assert.match(note, /current game tools/);
  const history = html.match(/<details><summary>Conversation history<\/summary>(.*?)<\/details>/)?.[1];
  assert.match(history, /retain the tools registered when they were created/);
  assert.match(history, /explicitly select/); assert.match(history, /preserves the old conversation and its history/);
});

test('successful resume warns once without changing thread or opting into a new conversation', async () => {
  const h = connectionHarness(); await h.submit();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].newGameThread, false);
  assert.equal(h.calls[0].threadId, 'saved-thread'); assert.equal(h.run('settings.threadId'), 'saved-thread');
  assert.equal(h.messages.length, 1); assert.match(h.messages[0], /retains the tools registered when it was created/);
  assert.match(h.messages[0], /explicitly select/); assert.match(h.messages[0], /history are preserved/);
  assert.equal(h.saved[0].threadId, 'saved-thread'); assert.equal(Object.hasOwn(h.saved[0], 'token'), false);
});

test('only explicit checkbox opt-in requests a new conversation and does not show a resume warning', async () => {
  const h = connectionHarness({ resumed: false }); h.element('new-game-thread').checked = true; await h.submit();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].newGameThread, true);
  assert.equal(h.run('settings.threadId'), 'new-explicit-thread');
  assert.equal(h.element('new-game-thread').checked, false);
  assert.equal(h.messages.length, 1); assert.doesNotMatch(h.messages[0], /Resumed|retains the tools/);
});

test('failed connection leaves saved thread unchanged and cannot claim successful resume', async () => {
  const h = connectionHarness({ failure: 'Connection failed' }); await h.submit();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].newGameThread, false);
  assert.equal(h.run('settings.threadId'), 'saved-thread'); assert.equal(h.messages.length, 0);
  assert.equal(h.element('settings-message').textContent, 'Connection failed');
});
