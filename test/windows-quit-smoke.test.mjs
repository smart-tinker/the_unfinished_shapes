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
  assert.match(windowsUI, /GetForegroundWindow/);
  assert.doesNotMatch(windowsUI, /GetForegroundOwnedWindow|foreground-window-not-owned/);

  const promptLookup = windowsUI.slice(
    windowsUI.indexOf('function FindExpectedQuitPrompt'),
    windowsUI.indexOf('switch ($Action)'),
  );
  assert.ok(promptLookup.includes('function FindExpectedQuitPrompt'), 'exact prompt matcher exists');
  const titleCheck = promptLookup.indexOf("$Window.Current.Name -ne 'Codex activity may continue'");
  const textCheck = promptLookup.indexOf('$Window.FindFirst');
  const buttonsCheck = promptLookup.indexOf('$Window.FindAll');
  assert.ok(titleCheck >= 0 && titleCheck < textCheck && textCheck < buttonsCheck,
    'foreground descendants are read only after the exact TUS dialog title matches');
  for (const text of [
    'Codex may still be working in this conversation.',
    'The current Codex activity is unknown.',
    'Keep the game open',
    'Quit anyway',
  ]) {
    assert.ok(promptLookup.includes(text), 'exact TUS prompt text includes ' + text);
  }
  assert.match(promptLookup, /\$buttons\.Count -ne 2/);
  assert.match(promptLookup, /\$buttonNames -notcontains 'Keep the game open'/);
  assert.match(promptLookup, /\$buttonNames -notcontains 'Quit anyway'/);
  assert.match(windowsUI, /\$foregroundHandle = \[TusWindowLookup\]::GetForegroundWindow\(\)/);
  const foregroundStart = windowsUI.indexOf('$foregroundHandle = [TusWindowLookup]::GetForegroundWindow()');
  const foregroundEnd = windowsUI.indexOf('if (-not $dialog) {', foregroundStart);
  const foregroundLookup = windowsUI.slice(foregroundStart, foregroundEnd);
  const nativeTitleRead = foregroundLookup.indexOf('[TusWindowLookup]::GetWindowTitle($foregroundHandle)');
  const exactTitleGate = foregroundLookup.indexOf("$foregroundTitle -eq 'Codex activity may continue'");
  const uiAutomationOpen = foregroundLookup.indexOf('[System.Windows.Automation.AutomationElement]::FromHandle($foregroundHandle)');
  assert.ok(nativeTitleRead >= 0 && nativeTitleRead < exactTitleGate && exactTitleGate < uiAutomationOpen,
    'native title must match before UI Automation opens the foreground window');
  assert.match(windowsUI, /TUS_UIA: foreground-window-content-not-found/);

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
  for (const marker of [
    'script-start', 'window-api-ready', 'locating-dialog', 'target-dialog-found',
    'dialog-accessible', 'no-owned-dialog-window', 'owned-window-content-not-found',
    'checking-foreground-window', 'foreground-handle-read', 'foreground-title-read',
    'foreground-title-matched', 'foreground-window-unavailable', 'foreground-window-content-not-found',
  ]) {
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
