import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const readerTest = fileURLToPath(new URL('./windows-uia-bounded-reader.ps1', import.meta.url));

test('bounded UIA child preserves only a complete safe phase after kill and reap', { skip: process.platform !== 'win32' }, async () => {
  const startedAt = Date.now();
  const { stdout, stderr } = await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', readerTest,
  ], { timeout: 35000, windowsHide: true });
  const elapsed = Date.now() - startedAt;

  assert.match(stdout, /^TUS_UIA_TEST: result=timeout-phase-child-start$/m,
    'the complete allowlisted phase is retained after the timed-out child is reaped');
  assert.match(stdout, /^TUS_UIA_DIAG: bounded-wait-returned$/m,
    'the bounded process wait returned before child cleanup');
  for (const phase of ['ui-child-killing', 'ui-child-kill-waiting', 'ui-child-exit-checking']) {
    assert.match(stdout, new RegExp('^TUS_UIA: ' + phase + '$', 'm'), phase + ' is exercised');
  }
  assert.doesNotMatch(stdout + stderr, /UNAPPROVED_PROMPT_TEST_PAYLOAD|phase-unapproved-test-output|phase-payload-read-start-partial/,
    'arbitrary and unterminated child output is never surfaced');
  assert.ok(elapsed < 8000, 'the timeout, kill, reap and output drain remain bounded');
});

test('UIA phase matcher rejects unapproved child phases', () => {
  const source = readFileSync(fileURLToPath(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url)), 'utf8');
  const pattern = source.match(/^\\s*\\$token = \\[regex\\]::Match\\(\\[string\\]\\$eventArgs\\.Data,\\s*'([^']+)'\\)/m)?.[1];
  assert.ok(pattern, 'the production child-output matcher is present');
  const matcher = new RegExp(pattern);
  assert.match('TUS_UIA_CHILD: phase-child-start', matcher);
  assert.doesNotMatch('TUS_UIA_CHILD: phase-unapproved-test-output', matcher,
    'only emitted safe phases should be accepted');
});
