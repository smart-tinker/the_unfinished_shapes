import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('real native quit prompt runs without CI auto-confirm and skips closed-app cleanup', async () => {
  const source = await readFile(new URL('../scripts/windows-installer-smoke.mjs', import.meta.url), 'utf8');
  const launch = source.match(/async function launch[\s\S]*?(?=\nasync function close)/)?.[0];
  assert.ok(launch, 'installer smoke launch helper exists');
  assert.match(launch, /realQuitPrompt\s*\?\s*\[\]\s*:\s*\['--tus-smoke-confirm-quit'\]/);

  const acceptance = source.slice(source.indexOf('const promptApp ='), source.indexOf('// Restart the installed candidate'));
  assert.match(acceptance, /promptProcess\s*=\s*instance\.process\(\)/);
  assert.match(acceptance, /promptProcess\.exitCode/);
  assert.doesNotMatch(acceptance, /promptGraphics\.assertNoErrors\(\)/);
});
