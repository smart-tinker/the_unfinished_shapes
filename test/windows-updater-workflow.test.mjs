import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Windows updater workflow runs after native smoke failure only when both packages built', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const lf = workflow.replace(/\r\n?/g, '\n');

  function inspect(source) {
    const normalized = source.replace(/\r\n?/g, '\n');
    const start = normalized.indexOf('  windows-installer:\n');
    assert.ok(start >= 0, 'the Windows workflow job is found');
    const job = normalized.slice(start);
    const updaterStart = job.indexOf('      - name: Published update download and exact installer/portable acceptance');
    assert.ok(updaterStart >= 0, 'the packaged updater acceptance step exists');
    const native = job.slice(job.indexOf('      - name: Verify clean install, current-candidate lifecycle and retained data'), updaterStart);
    const updater = job.slice(updaterStart);
    assert.match(job, /- id: package\s*\n\s*run: npm run package:win/);
    assert.match(job, /- id: installer\s*\n\s*run: npm run installer:win/);
    assert.doesNotMatch(native, /continue-on-error\s*:\s*true/, 'the native smoke failure remains job-failing');
    const condition = updater.match(/^\s*if:\s*\$\{\{([^}]+)\}\}/m)?.[1] || '';
    assert.match(condition, /!\s*cancelled\(\)/, 'the updater still runs after an earlier smoke failure');
    assert.match(condition, /steps\.package\.conclusion\s*==\s*'success'/, 'a failed or skipped package build blocks the updater');
    assert.match(condition, /steps\.installer\.conclusion\s*==\s*'success'/, 'a failed or skipped installer build blocks the updater');
    assert.doesNotMatch(updater, /continue-on-error\s*:\s*true/, 'updater failures remain job failures');
    return condition.replace(/\s+/g, ' ').trim();
  }

  const lfCondition = inspect(lf);
  const crlfCondition = inspect(lf.replace(/\n/g, '\r\n'));
  assert.equal(crlfCondition, lfCondition, 'LF and CRLF forms preserve the same workflow semantics');
});
