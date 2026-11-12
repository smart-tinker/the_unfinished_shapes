import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');

function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.notEqual(start, -1, `Settings section ${id} is present`);
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, `Settings section ${id} is closed`);
  return html.slice(start, end);
}

test('Settings keeps Codex, world, and graphics controls in separate labelled sections', () => {
  const codex = section('settings-codex');
  const world = section('settings-world');
  const graphics = section('settings-graphics');

  assert.match(codex, /aria-labelledby="settings-codex-heading"/);
  assert.match(codex, /<h3 id="settings-codex-heading">Codex<\/h3>/);
  assert.match(codex, /id="workspace"/);
  assert.match(codex, /id="codex"/);
  assert.match(codex, /id="connect"/);

  assert.match(world, /aria-labelledby="settings-world-heading"/);
  assert.match(world, /<h3 id="settings-world-heading">World<\/h3>/);
  assert.match(world, /id="server-url"/);
  assert.match(world, /id="token" type="password"/);
  assert.match(world, /id="save-world"/);

  assert.match(graphics, /aria-labelledby="settings-graphics-heading"/);
  assert.match(graphics, /<h3 id="settings-graphics-heading">Graphics<\/h3>/);
  assert.match(graphics, /id="lighting-quality"/);
});

test('long Codex instructions are available in a native keyboard-accessible disclosure', () => {
  const codex = section('settings-codex');
  assert.match(codex, /<details>[\s\S]*?<summary>Codex details<\/summary>[\s\S]*?Search checks PATH[\s\S]*?<\/details>/);
  assert.match(codex, /<details>[\s\S]*?<summary>Conversation history<\/summary>[\s\S]*?preserves the old conversation[\s\S]*?<\/details>/);
});

test('Codex status and recovery guidance are clearly announced in Settings', () => {
  const codex = section('settings-codex');
  assert.match(codex, /id="settings-codex-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(codex, /id="settings-codex-recovery"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(codex, /Check the Codex executable path, then select Connect\. The saved conversation stays intact\./);
  assert.doesNotMatch(codex, /Disconnected\?/);
});


test('Settings exposes update channel, package choice, and explicit update actions', () => {
  const updates = section('settings-updates');
  assert.match(updates, /aria-labelledby="settings-updates-heading"/);
  assert.match(updates, /id="update-channel"/);
  assert.match(updates, /option value="stable"[^>]*selected/);
  assert.match(updates, /option value="prerelease"/);
  assert.match(updates, /id="update-distribution"/);
  assert.match(updates, /option value="installer"/);
  assert.match(updates, /option value="portable"/);
  assert.match(updates, /id="updates-check"/);
  assert.match(updates, /id="updates-download"/);
  assert.match(updates, /id="updates-cancel"/);
  assert.match(updates, /id="updates-extract"/);
  assert.match(updates, /id="updates-launch"/);
  assert.match(updates, /id="updates-status"[^>]*role="status"[^>]*aria-live="polite"/);
});


test('world save feedback stays with World settings', () => {
  const world = section('settings-world');
  const codex = section('settings-codex');
  assert.match(world, /id="world-message"[^>]*class="feedback"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(world, /id="settings-message"/);
  assert.match(codex, /id="settings-message"[^>]*class="feedback"[^>]*role="status"[^>]*aria-live="polite"/);
});
