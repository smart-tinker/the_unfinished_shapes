import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('application version label is dynamic instead of a stale release literal', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="build-version"/, 'the UI has a build version label for Electron metadata');
  assert.doesNotMatch(html, /0\.1-rc3/, 'the UI must not advertise the stale rc3 version');
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const smoke = await readFile(new URL('../scripts/electron-smoke.mjs', import.meta.url), 'utf8');
  assert.match(main, /app\.getVersion\(\)/, 'Electron package metadata is the version source');
  assert.match(main, /build-info\.json/, 'a packaged build reads its recorded source identity');
  assert.match(smoke, /expectedSourceSha/, 'packaged smoke compares the visible identity with the candidate commit');
});
