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
  assert.match(windowsUI, /FindExpectedQuitButton/);
  assert.match(windowsUI, /ClickNativePromptButton/);
  assert.match(windowsUI, /SendMessageTimeout/);
  assert.match(windowsUI, /WM_GETTEXT/);
  assert.match(windowsUI, /BM_CLICK/);
  assert.match(windowsUI, /buttons\.Count != 2/);
  assert.doesNotMatch(windowsUI, /AutomationElement\]::FromHandle\(\$foregroundHandle\)/);
  for (const text of [
    'Codex may still be working in this conversation.',
    'The current Codex activity is unknown.',
    'Quitting TUS closes its Codex connection but does not confirm that a Goal or turn stopped.',
    'Codex state could not be confirmed. Keep the game open and reconnect to check the conversation, or quit anyway.',
    'Keep the game open',
    'Quit anyway',
  ]) {
    assert.ok(windowsUI.includes(text), 'native matcher includes exact TUS text ' + text);
  }
  const foregroundStart = windowsUI.indexOf('$foregroundHandle = [TusWindowLookup]::GetForegroundWindow()');
  const foregroundEnd = windowsUI.indexOf('if (-not $dialog) {', foregroundStart);
  const foregroundLookup = windowsUI.slice(foregroundStart, foregroundEnd);
  const nativeTitleRead = foregroundLookup.indexOf('[TusWindowLookup]::GetWindowTitle($foregroundHandle)');
  const exactTitleGate = foregroundLookup.indexOf("$foregroundTitle -eq 'Codex activity may continue'");
  const nativeButtonFind = foregroundLookup.indexOf('[TusWindowLookup]::FindExpectedQuitButton');
  const nativeButtonClick = foregroundLookup.indexOf('[TusWindowLookup]::ClickNativePromptButton');
  assert.ok(nativeTitleRead >= 0 && nativeTitleRead < exactTitleGate && exactTitleGate < nativeButtonFind && nativeButtonFind < nativeButtonClick,
    'only an exact foreground TUS dialog title reaches native text and button automation');
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
    automation.includes("markers.slice(-3).join(' after ')"),
    'timeout errors report the failure marker, phase and safe prompt status',
  );
});


test('native prompt inspection matches exact message or detail text in child controls', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  assert.match(windowsUI, /public static string LastPromptStatus/);
  for (const status of [
    'title-mismatch', 'button-count-mismatch', 'expected-buttons-missing',
    'requested-button-missing', 'title-buttons-text-unavailable', 'matched',
  ]) {
    assert.ok(windowsUI.includes('LastPromptStatus = "' + status + '"'), 'native scan reports ' + status);
  }
  assert.ok(windowsUI.includes('TUS_UIA: prompt-$promptStatus'));
  assert.match(windowsUI, /NormalizePromptText/);
  assert.match(windowsUI, /String\.IsNullOrWhiteSpace\(text\)/);
  assert.ok(windowsUI.includes('normalizedText.IndexOf(message, StringComparison.Ordinal) >= 0'));
  assert.ok(!windowsUI.includes('name != "Static" && name != "Button"'));
  assert.match(automation, /markers\.slice\(-3\)\.join\(' after '\)/);
  assert.doesNotMatch(windowsUI, /Write-Output.*(?:control|foreground).*(?:Text|Title)/);
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

test('native prompt fallback requires exact title and both exact buttons before clicking', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  assert.ok(windowsUI.includes('LastPromptStatus = "title-buttons-text-unavailable"'));
  const safeMarker = "if ($promptStatus -eq 'title-buttons-text-unavailable') { Write-Output 'TUS_UIA: prompt-title-buttons-text-unavailable' }";
  assert.equal(windowsUI.split(safeMarker).length - 1, 2, 'both native click paths report unavailable body text safely');
  const buttons = windowsUI.indexOf('if (buttons.Count != 2)');
  const labels = windowsUI.indexOf('if (!hasKeepOpen || !hasQuitAnyway)');
  const requested = windowsUI.indexOf('if (requested == IntPtr.Zero)');
  const text = windowsUI.indexOf('if (!hasExpectedMessage)');
  assert.ok(buttons >= 0 && labels > buttons && requested > labels && text > requested,
    'body-text fallback occurs only after both exact button names and the requested button match');
});


test('File -> Exit uses only the exact foreground TUS window when Electron has no main HWND', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const fileExit = windowsUI.slice(windowsUI.indexOf("  'file-exit' {"));
  const foreground = fileExit.indexOf('[TusWindowLookup]::GetForegroundWindow()');
  const titleCheck = fileExit.indexOf("GetWindowTitle($windowHandle) -ne 'The Unfinished Shapes'");
  const automation = fileExit.indexOf('[System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)');
  assert.ok(fileExit.includes('$process.MainWindowHandle'), 'uses Electron HWND when Windows provides it');
  assert.ok(foreground >= 0 && titleCheck > foreground && automation > titleCheck,
    'missing main HWND falls back to foreground, then requires exact TUS title before UIA');
});


test('File -> Exit opens the native File menu before locating its exit command', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const fileExit = windowsUI.slice(windowsUI.indexOf("  'file-exit' {"));
  const openFileMenu = fileExit.indexOf("[System.Windows.Forms.SendKeys]::SendWait('%f')");
  const findFile = fileExit.indexOf('$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileCondition)');
  const findExit = fileExit.indexOf("if ($item.Current.Name -match '^(Exit|Quit)$')");
  assert.ok(openFileMenu >= 0 && findFile > openFileMenu && findExit > findFile,
    'opens File with its keyboard mnemonic before reading and selecting the exact Exit/Quit item');
});
