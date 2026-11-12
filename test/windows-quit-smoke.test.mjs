import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('real native quit prompt runs without CI auto-confirm and skips closed-app cleanup', async () => {
  const source = await readFile(new URL('../scripts/windows-installer-smoke.mjs', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const launch = source.match(/async function launch[\s\S]*?(?=\nasync function close)/)?.[0];
  assert.ok(launch, 'installer smoke launch helper exists');
  assert.match(launch, /realQuitPrompt\s*\?\s*\[\]\s*:\s*\['--tus-smoke-confirm-quit'\]/);

  const acceptance = source.slice(source.indexOf('const promptApp ='), source.indexOf('// Restart the installed candidate'));
  assert.match(acceptance, /promptProcess\s*=\s*instance\.process\(\)/);
  assert.match(acceptance, /promptProcess\.exitCode/);
  assert.doesNotMatch(acceptance, /promptGraphics\.assertNoErrors\(\)/);
  assert.match(automation, /const \{ error, stdout, stderr \} = await new Promise/);
  assert.match(automation, /const output = \[stdout, stderr\]/);
  assert.match(windowsUI, /TUS_UIA: quit-dialog-not-found/);
  assert.match(windowsUI, /TUS_UIA: automation-error-/);
  assert.match(windowsUI, /Codex activity may continue/);
  assert.match(windowsUI, /GetForegroundOwnedWindow/);
  for (const marker of ['foreground-window-unavailable', 'foreground-window-not-owned', 'foreground-window-content-not-found']) {
    assert.ok(windowsUI.includes("$foregroundStatus = '" + marker + "'"), 'PowerShell classifies ' + marker);
  }
  assert.match(windowsUI, /HasForegroundWindow/);
  assert.ok(windowsUI.includes('Write-Output "TUS_UIA: $foregroundStatus"'));
  assert.match(windowsUI, /GetProcessWindows/);
  assert.match(windowsUI, /EnumWindows/);
  assert.match(windowsUI, /IsWindowVisible/);
  assert.match(windowsUI, /GetWindowThreadProcessId/);
  assert.doesNotMatch(windowsUI, /FindWindow\(/);
  assert.doesNotMatch(windowsUI, /\$root\.FindFirst\(/);
  assert.doesNotMatch(windowsUI, /\$candidate\.FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Descendants/);
});


test('Windows UI automation preserves child output for safe failure reporting', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const ui = source.slice(source.indexOf('async function ui'), source.indexOf('export async function'));
  assert.match(ui, /execFile\('powershell\.exe'/);
  assert.match(ui, /resolve\(\{\s*error,\s*stdout,\s*stderr\s*\}\)/);
  assert.match(ui, /error\.killed/);
  assert.match(ui, /error\.signal/);
});


test('quit prompt acceptance helper loads as valid ESM', async () => {
  await import('../scripts/quit-prompt-acceptance.mjs');
});


test('Windows quit UI reports its latest safe phase when native automation times out', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const timeout = Number(automation.match(/timeout:\s*(\d+)/)?.[1]);
  assert.ok(timeout >= 25000, 'PowerShell timeout includes startup plus the full 15-second dialog wait');
  for (const marker of ['script-start', 'window-api-ready', 'locating-dialog', 'target-dialog-found', 'dialog-accessible', 'no-owned-dialog-window', 'owned-window-content-not-found', 'checking-foreground-window']) {
    assert.ok(windowsUI.includes('TUS_UIA: ' + marker), 'PowerShell reports ' + marker);
  }
  assert.match(windowsUI, /automation-error-\$errorType-at-\$script:uiPhase/);
  assert.match(windowsUI, /\$script:uiPhase = 'reading-owned-window'/);
  assert.match(windowsUI, /if \(\$handle -eq \$mainWindowHandle\) \{ continue \}/);
  assert.ok(
    automation.includes("markers.slice(-2).join(' after ')"),
    'timeout errors report the failure marker and the phase before it',
  );
});
