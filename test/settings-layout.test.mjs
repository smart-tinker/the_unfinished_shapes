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
