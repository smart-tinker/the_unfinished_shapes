import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the packaged Linux CI runs the bounded benchmark without artifact or cache storage', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const linux = workflow.split('  linux-client:')[1]?.split('  model:')[0] ?? '';
  assert.match(linux, /runs-on: ubuntu-24\\.04/);
  assert.match(linux, /npm run package:linux[\\s\\S]*Two packaged clients and a shared server[\\s\\S]*scripts\\/performance-benchmark\\.mjs/);
  assert.match(linux, /xvfb-run --auto-servernum node scripts\\/performance-benchmark\\.mjs/);
  assert.doesNotMatch(workflow, /upload-artifact|actions\\/cache/);
});
