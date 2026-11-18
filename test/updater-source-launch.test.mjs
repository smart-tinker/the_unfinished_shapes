import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('installed-source restart reuses the source executable and profile configuration', async () => {
  const smoke = await readFile(new URL('../scripts/updater-release-smoke.mjs', import.meta.url), 'utf8');
  const sourceLaunch = "start(sourceExecutable, 'updater source ' + distribution, dataDir, true, sourceEnv)";
  const restartLaunch = "start(sourceExecutable, 'updater preference restart ' + distribution, dataDir, true, sourceEnv)";

  assert.ok(smoke.includes(sourceLaunch), 'the first launch uses the installed source identity');
  assert.ok(smoke.includes(restartLaunch), 'the preference restart keeps the executable, data directory and environment');
});
