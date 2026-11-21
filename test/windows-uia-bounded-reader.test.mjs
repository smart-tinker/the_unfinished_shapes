import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { safeUiTimingLine } from '../scripts/quit-prompt-acceptance.mjs';

const run = promisify(execFile);
const readerTest = fileURLToPath(new URL('./windows-uia-bounded-reader.ps1', import.meta.url));

function filterAllowlistedOutput(output, allowedLines) {
  return output.split(/\r?\n/).filter((line) => allowedLines.has(line)).join('\n');
}

const waitControlTest = fileURLToPath(new URL('./windows-uia-wait-control.ps1', import.meta.url));
const safeControlMarkers = new Set([
  'TUS_UIA_CONTROL: control-start',
  'TUS_UIA_CONTROL: child-started',
  'TUS_UIA_CONTROL: start-failed',
  'TUS_UIA_CONTROL: wait-started',
  'TUS_UIA_CONTROL: wait-returned',
  'TUS_UIA_CONTROL: wait-timed-out',
  'TUS_UIA_CONTROL: wait-child-exited',
  'TUS_UIA_CONTROL: wait-within-bound',
  'TUS_UIA_CONTROL: wait-over-bound',
  'TUS_UIA_CONTROL: wait-threw',
  'TUS_UIA_CONTROL: kill-started',
  'TUS_UIA_CONTROL: kill-returned',
  'TUS_UIA_CONTROL: kill-failed',
  'TUS_UIA_CONTROL: reap-started',
  'TUS_UIA_CONTROL: reap-completed',
  'TUS_UIA_CONTROL: reap-timed-out',
  'TUS_UIA_CONTROL: reap-threw',
  'TUS_UIA_CONTROL: process-exited',
  'TUS_UIA_CONTROL: process-not-exited',
  'TUS_UIA_CONTROL: stdout-eof-started',
  'TUS_UIA_CONTROL: stdout-eof-completed',
  'TUS_UIA_CONTROL: stdout-eof-pending',
  'TUS_UIA_CONTROL: stdout-eof-skipped-process-not-exited',
  'TUS_UIA_CONTROL: stdout-eof-threw',
  'TUS_UIA_CONTROL: control-failed',
  'TUS_UIA_CONTROL: control-passed',
  'TUS_UIA_CONTROL: no-safe-markers',
]);

const safeDiagnosticMarkers = new Set([
  'TUS_UIA_TEST: result=timeout-phase-child-start',
  'TUS_UIA_TEST: result=timeout-phase-fromhandle-start',
  'TUS_UIA: ui-child-killing',
  'TUS_UIA: ui-child-kill-waiting',
  'TUS_UIA: ui-child-exit-checking',
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

function safeDiagnosticOutput(output) {
  return output.split(/\r?\n/).map(line =>
    safeDiagnosticMarkers.has(line) ? line : safeUiTimingLine(line)
  ).filter(Boolean).join('\n');
}

test('safe UI timing output retains only bounded phase labels and durations', () => {
  assert.equal(safeUiTimingLine('TUS_UIA_TIMING: reader-wait-ms=6500'), 'TUS_UIA_TIMING: reader-wait-ms=6500');
  assert.equal(safeUiTimingLine('TUS_UIA_TIMING: ui-assert-body-mismatch-rejected-ms=30500'), 'TUS_UIA_TIMING: ui-assert-body-mismatch-rejected-ms=30500');
  assert.equal(safeUiTimingLine('TUS_UIA_TIMING: app-close-ms=2700000'), 'TUS_UIA_TIMING: app-close-ms=2700000');
  for (const line of [
    'TUS_UIA_TIMING: reader-wait-ms=100000000',
    'TUS_UIA_TIMING: unknown-ms=12',
    'TUS_UIA_TIMING: reader-wait-ms=12 C:\\\\private',
    'C:\\\\private\\\\path',
  ]) assert.equal(safeUiTimingLine(line), null);
});

test('allowlist output drops an unapproved sentinel', () => {
  const rawOutput = 'TUS_UIA_CONTROL: control-start\nUNAPPROVED_SENTINEL';
  const filteredOutput = filterAllowlistedOutput(rawOutput, safeControlMarkers);
  assert.ok(filteredOutput === 'TUS_UIA_CONTROL: control-start',
    'unapproved marker output is omitted');
});

test('synthetic wait control uses a .NET output delegate', () => {
  const source = readFileSync(waitControlTest, 'utf8');
  assert.match(source, /new DataReceivedEventHandler\(OnOutputDataReceived\)/);
  assert.doesNotMatch(source, /GetNewClosure|\$outputHandler/);
});

test('bounded WaitForExit control honors 1000ms with redirected streams and async stdout drain', { skip: process.platform !== 'win32' }, async () => {
  const startedAt = Date.now();
  let stdout = '';
  let processFailed = false;
  let processOutcome = 'success';
  try {
    ({ stdout } = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', waitControlTest,
    ], { timeout: 15000, windowsHide: true }));
  } catch (error) {
    processFailed = true;
    const status = Number.isInteger(error?.code) ? 'exit-' + error.code
      : typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code
      : error?.killed === true ? 'killed' : 'unknown';
    const signal = ['SIGABRT', 'SIGBREAK', 'SIGFPE', 'SIGILL', 'SIGINT', 'SIGSEGV', 'SIGTERM'].includes(error?.signal)
      ? error.signal : 'none';
    processOutcome = status + ';signal=' + signal;
    stdout = String(error?.stdout ?? '');
  }
  const safeOutput = filterAllowlistedOutput(stdout, safeControlMarkers);
  console.log(safeOutput || 'TUS_UIA_CONTROL: no-safe-markers');
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 6000, 'the bounded WaitForExit control completes within six seconds');
  assert.equal(processFailed, false, 'the control PowerShell process exits successfully (' + processOutcome + ')');
  for (const marker of [
    'control-start', 'child-started', 'wait-started',
    'wait-returned', 'wait-timed-out', 'wait-within-bound',
    'kill-returned', 'reap-completed', 'process-exited',
    'stdout-eof-started', 'control-passed',
  ]) {
    assert.match(safeOutput, new RegExp('^TUS_UIA_CONTROL: ' + marker + '$', 'm'), marker + ' is recorded');
  }
  assert.match(safeOutput, /^TUS_UIA_CONTROL: stdout-eof-(?:completed|pending)$/m,
    'stdout EOF is observed without a blocking wait');
});

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
    stdout = String(error?.stdout ?? '');
    stderr = String(error?.stderr ?? '');
  }
  const safeOutput = safeDiagnosticOutput(stdout);
  console.log(safeOutput || 'TUS_UIA_DIAG: no-safe-markers');
  const elapsed = Date.now() - startedAt;
  console.log('TUS_UIA_TEST: elapsed-ms=' + Math.min(999999, Math.max(0, elapsed)));

  assert.ok(elapsed < 8000, 'the timeout, kill, reap and output drain remain bounded');
  assert.equal(processFailed, false, 'the PowerShell test process exits successfully');
  assert.match(safeOutput, /^TUS_UIA_TEST: result=timeout-phase-fromhandle-start$/m,
    'the complete allowlisted phase is retained after the timed-out child is reaped');
  assert.doesNotMatch(safeOutput, /^TUS_UIA_TIMING: fromhandle-ms=/m,
    'an unfinished FromHandle call has no measured duration');
  assert.match(safeOutput, /^TUS_UIA_DIAG: diagnostic-enabled$/m,
    'test override enables safe diagnostic markers');
  assert.match(safeOutput, /^TUS_UIA_DIAG: bounded-wait-returned$/m,
    'the bounded process wait returned before child cleanup');
  assert.match(safeOutput, /^TUS_UIA_DIAG: wait-(?:timed-out|budget-expired)$/m,
    'the diagnostic records the bounded wait outcome');
  assert.match(safeOutput, /^TUS_UIA_DIAG: kill-(?:returned|failed)$/m,
    'the diagnostic records the kill outcome');
  assert.match(safeOutput, /^TUS_UIA_DIAG: reap-(?:completed|timed-out|threw)$/m,
    'the diagnostic records the bounded reap outcome');
  assert.match(safeOutput, /^TUS_UIA_DIAG: (?:process-exited|process-not-exited)$/m,
    'the diagnostic records the post-reap process state');
  assert.match(safeOutput, /^TUS_UIA_DIAG: stdout-eof-(?:completed|timed-out|budget-expired|skipped-process-not-exited|threw)$/m,
    'the diagnostic records the stdout EOF drain outcome');
  for (const phase of ['ui-child-killing', 'ui-child-kill-waiting', 'ui-child-exit-checking']) {
    assert.match(safeOutput, new RegExp('^TUS_UIA: ' + phase + '$', 'm'), phase + ' is exercised');
  }
  for (const phase of ['reader-setup','process-start','payload-encode','payload-write','reader-wait','child-kill','child-reap','output-drain']) {
    assert.match(safeOutput, new RegExp('^TUS_UIA_TIMING: ' + phase + '-ms=[0-9]{1,6}$', 'm'), phase + ' duration is recorded');
  }
  assert.equal(/UNAPPROVED_PROMPT_TEST_PAYLOAD|phase-unapproved-test-output|phase-payload-read-start-partial/.test(stdout + stderr), false,
    'arbitrary and unterminated child output is never surfaced');
});

test('UIA phase matcher rejects unapproved child phases', () => {
  const source = readFileSync(fileURLToPath(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url)), 'utf8');
  const matcherPrefix = 'private static readonly Regex TokenMatcher = new Regex(@"';
  const matcherStart = source.indexOf(matcherPrefix);
  assert.notEqual(matcherStart, -1, 'the production child-output matcher is present');
  const patternStart = matcherStart + matcherPrefix.length;
  const patternEnd = source.indexOf('", RegexOptions.CultureInvariant)', patternStart);
  assert.ok(patternEnd > patternStart, 'the production matcher closes after its pattern');
  const matcher = new RegExp(source.slice(patternStart, patternEnd));
  assert.match('TUS_UIA_CHILD: phase-child-start', matcher);
  assert.doesNotMatch('TUS_UIA_CHILD: phase-unapproved-test-output', matcher,
    'only emitted safe phases should be accepted');
});
