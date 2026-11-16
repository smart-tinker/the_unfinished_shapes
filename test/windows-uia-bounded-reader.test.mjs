import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const readerTest = fileURLToPath(new URL('./windows-uia-bounded-reader.ps1', import.meta.url));

const safeDiagnosticMarkers = new Set([
  'TUS_UIA_DIAG: diagnostic-enabled',
  'TUS_UIA_DIAG: bounded-wait-returned',
  'TUS_UIA_DIAG: wait-started',
  'TUS_UIA_DIAG: wait-timed-out',
  'TUS_UIA_DIAG: wait-child-exited',
  'TUS_UIA_DIAG: wait-budget-expired',
  'TUS_UIA_DIAG: wait-threw',
  'TUS_UIA_DIAG: kill-started',
  'TUS_UIA_DIAG: kill-returned',
  'TUS_UIA_DIAG: kill-failed',
  'TUS_UIA_DIAG: reap-started',
  'TUS_UIA_DIAG: reap-completed',
  'TUS_UIA_DIAG: reap-timed-out',
  'TUS_UIA_DIAG: reap-threw',
  'TUS_UIA_DIAG: process-exited',
  'TUS_UIA_DIAG: process-not-exited',
  'TUS_UIA_DIAG: stdout-eof-started',
  'TUS_UIA_DIAG: stdout-eof-completed',
  'TUS_UIA_DIAG: stdout-eof-timed-out',
  'TUS_UIA_DIAG: stdout-eof-budget-expired',
  'TUS_UIA_DIAG: stdout-eof-skipped-process-not-exited',
  'TUS_UIA_DIAG: stdout-eof-threw',
]);

test('bounded UIA child preserves only a complete safe phase after kill and reap', { skip: process.platform !== 'win32' }, async () => {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let processFailed = false;
  try {
    ({ stdout, stderr } = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', readerTest,
    ], { timeout: 35000, windowsHide: true }));
  } catch (error) {
    processFailed = true;
    const safeMarkers = String(error?.stdout ?? '').split(/\r?\n/)
      .filter((line) => safeDiagnosticMarkers.has(line));
    console.log(safeMarkers.length ? safeMarkers.join('\n') : 'TUS_UIA_DIAG: no-safe-markers');
  }
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 8000, 'the timeout, kill, reap and output drain remain bounded');
  assert.equal(processFailed, false, 'the PowerShell test process exits successfully');
  assert.match(stdout, /^TUS_UIA_TEST: result=timeout-phase-child-start$/m,
    'the complete allowlisted phase is retained after the timed-out child is reaped');
  assert.match(stdout, /^TUS_UIA_DIAG: diagnostic-enabled$/m,
    'test override enables safe diagnostic markers');
  assert.match(stdout, /^TUS_UIA_DIAG: bounded-wait-returned$/m,
    'the bounded process wait returned before child cleanup');
  assert.match(stdout, /^TUS_UIA_DIAG: wait-(?:timed-out|budget-expired)$/m,
    'the diagnostic records the bounded wait outcome');
  assert.match(stdout, /^TUS_UIA_DIAG: kill-(?:returned|failed)$/m,
    'the diagnostic records the kill outcome');
  assert.match(stdout, /^TUS_UIA_DIAG: reap-(?:completed|timed-out|threw)$/m,
    'the diagnostic records the bounded reap outcome');
  assert.match(stdout, /^TUS_UIA_DIAG: (?:process-exited|process-not-exited)$/m,
    'the diagnostic records the post-reap process state');
  assert.match(stdout, /^TUS_UIA_DIAG: stdout-eof-(?:completed|timed-out|budget-expired|skipped-process-not-exited|threw)$/m,
    'the diagnostic records the stdout EOF drain outcome');
  for (const phase of ['ui-child-killing', 'ui-child-kill-waiting', 'ui-child-exit-checking']) {
    assert.match(stdout, new RegExp('^TUS_UIA: ' + phase + '$', 'm'), phase + ' is exercised');
  }
  assert.equal(/UNAPPROVED_PROMPT_TEST_PAYLOAD|phase-unapproved-test-output|phase-payload-read-start-partial/.test(stdout + stderr), false,
    'arbitrary and unterminated child output is never surfaced');
});

test('UIA phase matcher rejects unapproved child phases', () => {
  const source = readFileSync(fileURLToPath(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url)), 'utf8');
  const matcherPrefix = "$token = [regex]::Match([string]$eventArgs.Data, '";
  const matcherStart = source.indexOf(matcherPrefix);
  assert.notEqual(matcherStart, -1, 'the production child-output matcher is present');
  const patternStart = matcherStart + matcherPrefix.length;
  const patternEnd = source.indexOf("')", patternStart);
  assert.ok(patternEnd > patternStart, 'the production matcher closes after its pattern');
  const matcher = new RegExp(source.slice(patternStart, patternEnd));
  assert.match('TUS_UIA_CHILD: phase-child-start', matcher);
  assert.doesNotMatch('TUS_UIA_CHILD: phase-unapproved-test-output', matcher,
    'only emitted safe phases should be accepted');
});
