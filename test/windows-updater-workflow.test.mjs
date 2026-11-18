import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Windows updater workflow runs after native smoke failure only when both packages built', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('  windows-installer:\n'));
  assert.match(job, /- id: package\s*\n\s*run: npm run package:win/);
  assert.match(job, /- id: installer\s*\n\s*run: npm run installer:win/);

  const start = job.indexOf('      - name: Published update download and exact installer/portable acceptance');
  assert.ok(start >= 0, 'the packaged updater acceptance step exists');
  const updater = job.slice(start);
  const condition = updater.match(/^\s*if:\s*\$\{\{([^}]+)\}\}/m)?.[1] || '';
  assert.match(condition, /!\s*cancelled\(\)/, 'the updater still runs after an earlier smoke failure');
  assert.match(condition, /steps\.package\.conclusion\s*==\s*'success'/, 'a failed or skipped package build blocks the updater');
  assert.match(condition, /steps\.installer\.conclusion\s*==\s*'success'/, 'a failed or skipped installer build blocks the updater');
  assert.doesNotMatch(updater, /continue-on-error\s*:\s*true/, 'updater failures remain job failures');
});
