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

  assert.match(windowsUI, /\$foregroundHandle = \[TusWindowLookup\]::GetForegroundWindow\(\)/);
  assert.match(windowsUI, /\[System\.Windows\.Automation\.AutomationElement\]::FromHandle\(\$dialog\)/);
  assert.match(windowsUI, /\$root\.FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Descendants/);
  assert.match(windowsUI, /\[string\]::Equals\(\$name, \$expected, \[StringComparison\]::Ordinal\)/);
  assert.match(windowsUI, /FindExpectedQuitButton/);
  assert.match(windowsUI, /ClickNativePromptButton/);
  assert.match(windowsUI, /buttons\.Count != 2/);
  const foregroundStart = windowsUI.indexOf('$foregroundHandle = [TusWindowLookup]::GetForegroundWindow()');
  const foregroundEnd = windowsUI.indexOf("\n  'file-menu-open' {", foregroundStart);
  const foregroundLookup = windowsUI.slice(foregroundStart, foregroundEnd);
  const exactTitleGate = foregroundLookup.indexOf("GetWindowTitle($foregroundHandle) -eq 'Codex activity may continue'");
  const exactTextGate = foregroundLookup.indexOf('if (Test-ExactPromptText');
  const nativeButtonFind = foregroundLookup.indexOf('[TusWindowLookup]::FindExpectedQuitButton');
  const nativeButtonClick = foregroundLookup.indexOf('[TusWindowLookup]::ClickNativePromptButton');
  assert.ok(exactTitleGate >= 0 && exactTitleGate < exactTextGate && exactTextGate < nativeButtonFind && nativeButtonFind < nativeButtonClick,
    'only exact foreground TUS title and accessible prompt text reach native button automation');
  assert.match(windowsUI, /TUS_UIA: exact-foreground-prompt-matched/);
  assert.doesNotMatch(foregroundLookup, /GetProcessWindows|GetWindowThreadProcessId/);

  assert.doesNotMatch(windowsUI, /GetProcessWindows|EnumWindows\(|IsWindowVisible|GetWindowThreadProcessId/);
  assert.doesNotMatch(windowsUI, /FindWindow\(/);  assert.doesNotMatch(windowsUI, /\$root\.FindFirst\(/);
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
    'script-start', 'window-api-ready', 'locating-foreground-dialog', 'checking-foreground-window',
    'foreground-title-matched', 'checking-exact-dialog-text', 'checking-exact-dialog-buttons',
    'exact-foreground-prompt-matched', 'dialog-accessible', 'quit-dialog-not-found',
  ]) {
    assert.ok(windowsUI.includes('TUS_UIA: ' + marker), 'PowerShell reports ' + marker);
  }
  assert.match(windowsUI, /automation-error-\$errorType-at-\$script:uiPhase/);
  assert.match(windowsUI, /\$script:uiPhase = 'checking-exact-dialog-text'/);
  assert.match(windowsUI, /TUS_UIA: prompt-\$promptStatus/);
  assert.doesNotMatch(windowsUI, /GetProcessWindows|reading-owned-window/);
  assert.ok(
    automation.includes("markers.slice(-3).join(' after ')"),
    'timeout errors report the failure marker, phase and safe prompt status',
  );
});


test('native prompt acceptance requires an exact UIA text match', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const promptStart = windowsUI.indexOf("  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {");
  const promptEnd = windowsUI.indexOf("\n  'file-menu-open' {", promptStart);
  const prompt = windowsUI.slice(promptStart, promptEnd);
  assert.match(windowsUI, /AutomationElement\]::FromHandle\(\$dialog\)/);
  assert.match(windowsUI, /StringComparison\]::Ordinal/);
  assert.match(windowsUI, /\$root\.FindAll\(/);
  assert.ok(prompt.indexOf('if (Test-ExactPromptText') < prompt.indexOf('FindExpectedQuitButton'));
  assert.ok(prompt.indexOf('FindExpectedQuitButton') < prompt.indexOf('ClickNativePromptButton'));
  assert.match(prompt, /TUS_UIA: exact-foreground-prompt-matched/);
  assert.doesNotMatch(prompt, /prompt-title-buttons-text-unavailable|GetProcessWindows/);
});

test('production native quit dialog carries the exact known and unknown message text', async () => {
  const { createQuitConfirmation } = await import('../src/quit-guard.mjs');
  const window = { id: 'main-window' }, calls = [];
  const confirm = createQuitConfirmation({
    dialog: { showMessageBox: async (parent, options) => { calls.push({ parent, options }); return { response: 0 }; } },
    getWindow: () => window,
    isSmokeAutoConfirm: () => false,
  });
  await confirm({ connected: true, goal: { status: 'active' } });
  await confirm(null);
  assert.equal(calls[0].options.title, 'Codex activity may continue');
  assert.equal(calls[0].options.message, 'Codex may still be working in this conversation.');
  assert.equal(calls[0].options.detail, 'Native Goal status: active. Quitting TUS closes its Codex connection but does not confirm that a Goal or turn stopped. Keep the game open to pause or clear the Goal, or quit anyway.');
  assert.equal(calls[1].options.message, 'The current Codex activity is unknown.');
  assert.equal(calls[1].options.detail, 'Codex state could not be confirmed. Keep the game open and reconnect to check the conversation, or quit anyway.');
  assert.deepEqual(calls[0].options.buttons, ['Keep the game open', 'Quit anyway']);
  assert.deepEqual(calls[1].options.buttons, ['Keep the game open', 'Quit anyway']);
});

test('native prompt buttons require the exact foreground TUS dialog title', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  assert.match(windowsUI, /GetWindowTitle\(dialog\) != "Codex activity may continue"/);
  assert.match(windowsUI, /buttons\.Count != 2/);
  assert.match(windowsUI, /control\.Text == "Keep the game open"/);
  assert.match(windowsUI, /control\.Text == "Quit anyway"/);
  assert.match(windowsUI, /control\.Text == requestedButton/);
  const promptStart = windowsUI.indexOf("  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {");
  const promptEnd = windowsUI.indexOf("\n  'file-menu-open' {", promptStart);
  const prompt = windowsUI.slice(promptStart, promptEnd);
  assert.ok(prompt.indexOf('if (Test-ExactPromptText') < prompt.indexOf('FindExpectedQuitButton'));
  assert.doesNotMatch(prompt, /prompt-title-buttons-text-unavailable/);
});


test('File -> Exit selects the exact Electron menu command on the TUS window', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  assert.match(automation, /Menu\.getApplicationMenu\(\)/);
  assert.match(automation, /menu-will-show/);
  assert.match(automation, /item\.role === 'quit'|\['Exit', 'Quit'\]\.includes\(item\.label\)/);
  assert.match(automation, /file\.submenu\.popup\(\{ window \}\)/);
  assert.match(automation, /await ui\('file-menu-exit', pid, exitMenuKey\)/);
  assert.match(windowsUI, /SendKeys\]::SendWait\(\$MenuKey\)/);
  assert.match(windowsUI, /SendKeys\]::SendWait\('\{ENTER\}'\)/);
  assert.doesNotMatch(windowsUI, /GetMenu\(/);
  const fileExit = windowsUI.slice(windowsUI.indexOf("  'file-menu-exit' {"));
  const titleGate = fileExit.indexOf("GetWindowTitle($windowHandle) -ne 'The Unfinished Shapes'");
  const chooseQuit = fileExit.indexOf("SendKeys]::SendWait($MenuKey)");
  const activateQuit = fileExit.indexOf("SendKeys]::SendWait('{ENTER}')");
  assert.ok(titleGate >= 0 && chooseQuit > titleGate && activateQuit > chooseQuit,
    'the visible Electron File submenu receives input only after validating the exact TUS window');
});
