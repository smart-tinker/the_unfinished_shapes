import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const automationScript = fileURLToPath(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url));

test('bounded UIA child keeps only a complete safe phase captured before timeout', { skip: process.platform !== 'win32' }, async () => {
  const { stdout, stderr } = await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', automationScript, '-Action', 'assert-bounded-child-timeout', '-ProcessId', '0',
  ], { timeout: 10000, windowsHide: true });

  assert.match(stdout, /^TUS_UIA_TEST: safe-phase-preserved$/m,
    'a complete allowlisted phase survives timeout and bounded child reap');
  assert.doesNotMatch(stdout + stderr, /UNAPPROVED_PROMPT_TEST_PAYLOAD|phase-payload-read-start-partial/,
    'unapproved or partial child output is never surfaced');
});
