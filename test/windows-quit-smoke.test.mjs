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
  const titleStart = windowsUI.indexOf('public static string GetWindowTitle');
  const titleEnd = windowsUI.indexOf('private static string NormalizePromptText', titleStart);
  const titleReader = windowsUI.slice(titleStart, titleEnd);
  assert.match(titleReader, /SendMessageTimeoutText/);
  assert.match(titleReader, /WM_GETTEXT/);
  assert.match(titleReader, /SMTO_ABORTIFHUNG\s*\|\s*SMTO_BLOCK,\s*1000/);
  assert.match(windowsUI, /SendMessageTimeoutText/);
  assert.match(windowsUI, /SMTO_ABORTIFHUNG\s*\|\s*SMTO_BLOCK,\s*1000/);
  assert.match(windowsUI, /FindExpectedQuitButton/);
  assert.match(windowsUI, /ClickNativePromptButton/);
  assert.match(windowsUI, /buttons\.Count != 2/);
  const foregroundStart = windowsUI.indexOf('$foregroundHandle = [TusWindowLookup]::GetForegroundWindow()');
  const foregroundEnd = windowsUI.indexOf("\n  'file-menu-open' {", foregroundStart);
  const foregroundLookup = windowsUI.slice(foregroundStart, foregroundEnd);
  const exactTitleGate = foregroundLookup.indexOf("GetWindowTitle($foregroundHandle) -eq 'Codex activity may continue'");
  const nativeButtonFind = foregroundLookup.indexOf('Find-ValidatedPromptButton');
  const nativeButtonClick = foregroundLookup.indexOf('[TusWindowLookup]::ClickNativePromptButton');
  assert.ok(exactTitleGate >= 0 && exactTitleGate < nativeButtonFind && nativeButtonFind < nativeButtonClick,
    'only the exact TUS dialog title and native prompt match reach the click');
  assert.match(windowsUI, /TUS_UIA: exact-foreground-prompt-matched/);
  assert.doesNotMatch(foregroundLookup, /GetProcessWindows|GetWindowThreadProcessId/);

  assert.doesNotMatch(windowsUI, /GetProcessWindows|EnumWindows\(|IsWindowVisible|GetWindowThreadProcessId/);
  assert.doesNotMatch(windowsUI, /FindWindow\(/);
});


test('Windows UI automation preserves child output for safe failure reporting', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const ui = source.slice(source.indexOf('async function ui'), source.indexOf('export async function'));
  assert.match(ui, /execFile\('powershell\.exe'/);
  assert.match(ui, /resolve\(\{\s*error,\s*stdout,\s*stderr\s*\}\)/);
  assert.match(ui, /error\.killed/);
  assert.match(ui, /error\.signal/);
  assert.doesNotMatch(ui, /stderrLine/);
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
    'script-start', 'window-api-ready', 'locating-foreground-dialog',
    'foreground-title-matched', 'exact-foreground-prompt-matched', 'dialog-accessible', 'quit-dialog-not-found',
  ]) {
    assert.ok(windowsUI.includes('TUS_UIA: ' + marker), 'PowerShell reports ' + marker);
  }
  assert.match(windowsUI, /automation-error-\$errorType-at-\$script:uiPhase/);
  assert.match(windowsUI, /\$script:uiPhase = 'checking-foreground-window'/);
  assert.match(windowsUI, /\$script:uiPhase = 'reading-foreground-title'/);
  assert.match(windowsUI, /\$script:uiPhase = 'checking-exact-dialog-buttons'/);
  assert.match(windowsUI, /TUS_UIA: prompt-\$promptStatus/);
  assert.doesNotMatch(windowsUI, /GetProcessWindows|reading-owned-window/);
});


test('native quit prompt body uses exact message text and bounded STA UI Automation', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const expectedBlock = windowsUI.slice(windowsUI.indexOf('$expectedMessages ='), windowsUI.indexOf('switch ($Action)'));
  assert.match(expectedBlock, /Codex may still be working in this conversation/);
  assert.match(expectedBlock, /The current Codex activity is unknown/);
  assert.match(expectedBlock, /Quitting TUS closes its Codex connection/);
  assert.match(expectedBlock, /Codex state could not be confirmed/);
  assert.match(expectedBlock, /Native Goal status:/);

  const uia = await readFile(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url), 'utf8');
  assert.match(uia, /TreeScope\]::Children/);
  assert.match(uia, /\.FindFirst\(/);
  assert.match(uia, /GetNextSibling/);
  assert.match(uia, /detail/);
  assert.match(uia, /TUS_UIA_CHILD: phase-fromhandle-start/);
  for (const marker of ['phase-child-start', 'phase-payload-read-start', 'phase-payload-parse-start', 'phase-addtype-types-start', 'phase-addtype-client-start']) {
    assert.ok(uia.includes('TUS_UIA_CHILD: ' + marker), 'UIA child reports ' + marker);
  }
  assert.match(uia, /TUS_UIA_CHILD: phase-findfirst-\' \+ \$index \+ \'-start/);
  assert.match(uia, /TUS_UIA_CHILD: phase-current-name-\' \+ \$index \+ \'-start/);
  assert.match(uia, /TUS_UIA_CHILD: phase-next-sibling-/);
  assert.match(uia, /Test-ExpectedPromptDetail/);
  assert.match(uia, /-STA -EncodedCommand/);
  assert.match(uia, /UseShellExecute = \$false/);
  assert.match(uia, /RedirectStandardInput = \$true/);
  assert.match(uia, /WaitForExit\(\$remaining\)/);
  assert.match(uia, /3000 - \[int\]\$watch\.ElapsedMilliseconds/);
  assert.match(uia, /\.Kill\(\)/);
  assert.doesNotMatch(uia, /TreeScope\]::Descendants|\.FindAll\(/);
});


test('Windows quit prompt acceptance mutates message and detail independently', async () => {
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  assert.match(automation, /assertModifiedPromptIsNotClicked\(app, pid, process, 'message'\)/);
  assert.match(automation, /assertModifiedPromptIsNotClicked\(app, pid, process, 'detail'\)/);
  assert.match(automation, /Modified activity detail\./);
  assert.match(automation, /TUS_UIA_TEST: detail-probe-/);
  assert.match(automation, /if \(matcherRejected\)\s*\{\s*try\s*\{\s*await ui\('keep-open', pid\)/);
  assert.match(automation, /prompt-reader-timeout-\[a-z0-9-\]\+/);
  assert.match(automation, /expected-foreground-prompt-unavailable/);
  assert.match(automation, /quit-dialog-not-found/);
  assert.match(automation, /automation-error-\[a-z0-9\]\+-at-\[a-z0-9-\]\+/i);
  assert.match(windowsUI, /TUS_UIA: prompt-\$status/);
});

test('Windows quit acceptance recognizes the status-prefixed known detail', async () => {
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  assert.match(automation, /assertKnownStatusDetailIsRecognized\(app, pid, process\)/);
  assert.match(automation, /Native Goal status: active\./);
});


test('Windows viewport restore retains its exact assertion and logs a bounded numeric snapshot', async () => {
  const source = await readFile(new URL('../scripts/windows-installer-smoke.mjs', import.meta.url), 'utf8');
  const restoreStart = source.indexOf('await dpiSession.send(\'Emulation.clearDeviceMetricsOverride\')');
  const restoreEnd = source.indexOf("graphics.phase('manual UI create, select, edit and remove')", restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.match(restore, /await page\.waitForFunction\(size => innerWidth === size\.width && innerHeight === size\.height, originalViewport\)/);
  assert.match(restore, /TUS_VIEWPORT: restore-timeout/);
  assert.match(restore, /devicePixelRatio/);
  assert.match(restore, /scaleFactor/);
  assert.match(restore, /setTimeout\(\(\) => resolve\(null\), 1000\)/);
});


test('native prompt acceptance uses bounded exact title, text and button checks', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const promptStart = windowsUI.indexOf("  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {");
  const promptEnd = windowsUI.indexOf("\n  'file-menu-open' {", promptStart);
  const prompt = windowsUI.slice(promptStart, promptEnd);
  assert.match(windowsUI, /SMTO_ABORTIFHUNG\s*\|\s*SMTO_BLOCK,\s*1000/);
  assert.match(windowsUI, /GetWindowTitle\(dialog\) != "Codex activity may continue"/);
  assert.match(windowsUI, /buttons\.Count != 2/);
  assert.match(windowsUI, /control\.Text == "Keep the game open"/);
  assert.match(windowsUI, /control\.Text == "Quit anyway"/);
  assert.ok(prompt.indexOf('Find-ValidatedPromptButton') >= 0 &&
    prompt.indexOf('Find-ValidatedPromptButton') < prompt.indexOf('[TusWindowLookup]::ClickNativePromptButton'));
  assert.match(prompt, /TUS_UIA: exact-foreground-prompt-matched/);
  assert.doesNotMatch(prompt, /GetProcessWindows/);
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
  assert.ok(prompt.indexOf('Find-ValidatedPromptButton') >= 0 &&
    prompt.indexOf('Find-ValidatedPromptButton') < prompt.indexOf('[TusWindowLookup]::ClickNativePromptButton'));
  assert.doesNotMatch(windowsUI, /\.FindAll\(/);
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

test('safe UIA failure classification distinguishes a child that reached the window API', async () => {
  const source = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const ui = source.slice(source.indexOf('async function ui'), source.indexOf('async function assertModifiedPromptIsNotClicked'));
  const mutationProbe = source.slice(source.indexOf('async function assertModifiedPromptIsNotClicked'), source.indexOf('async function assertKnownStatusDetailIsRecognized'));
  assert.match(ui, /const detail = safeUiFailureOutcome\(/,
    'production UI failures use the safe classifier');
  assert.match(mutationProbe, /\(\?:script-start\|window-api-ready\)-no-status/,
    'the mutation probe recognizes the safe no-status outcome');
  assert.match(mutationProbe, /console\.log\('TUS_UIA_TEST: detail-probe-' \+ matcherOutcome\)/,
    'the mutation probe emits the classified outcome as test evidence');
  const { safeUiFailureOutcome } = await import('../scripts/quit-prompt-acceptance.mjs');
  assert.equal(typeof safeUiFailureOutcome, 'function', 'failure classification is available');
  assert.equal(safeUiFailureOutcome(['script-start', 'window-api-ready']) === 'window-api-ready-no-status', true);
  assert.equal(safeUiFailureOutcome(['prompt-reader-timeout-phase-findfirst-0-start']) === 'prompt-reader-timeout-phase-findfirst-0-start', true);
  assert.equal(safeUiFailureOutcome(['script-start', 'window-api-ready', 'private dialog text']) === 'window-api-ready-no-status', true,
    'only allowlisted tokens can become CI evidence');
});


test('UIA wrapper phases are flushed and safely reach mutation evidence', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const { safeUiFailureOutcome } = await import('../scripts/quit-prompt-acceptance.mjs');
  assert.equal(safeUiFailureOutcome(['prompt-reader-timeout-no-phase']), 'prompt-reader-timeout-no-phase',
    'the fixed no-phase timeout outcome is preserved');
  assert.equal(safeUiFailureOutcome(['ui-child-starting']), 'ui-child-starting',
    'a fixed UIA process phase is retained by the safe whitelist');

  const writerStart = windowsUI.indexOf('function Write-UiaPhaseMarker');
  const writerEnd = windowsUI.indexOf('function Write-PromptEvidence', writerStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart, 'the UIA wrapper emits fixed phase markers');
  const markerWriter = windowsUI.slice(writerStart, writerEnd);
  for (const phase of [
    'ui-child-starting', 'ui-child-started', 'ui-payload-preparing', 'ui-payload-ready',
    'ui-payload-writing', 'ui-payload-written', 'ui-child-waiting', 'ui-child-finished',
  ]) {
    assert.ok(markerWriter.includes("'" + phase + "'"), 'the marker writer allows ' + phase);
  }
  assert.match(markerWriter, /\[Console\]::Out\.WriteLine/);
  assert.match(markerWriter, /\[Console\]::Out\.Flush\(\)/);
  assert.doesNotMatch(markerWriter, /Write-Output/);

  const uia = await readFile(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url), 'utf8');
  const phaseIndexes = [
    'ui-child-starting', 'ui-child-started', 'ui-payload-preparing', 'ui-payload-ready',
    'ui-payload-writing', 'ui-payload-written', 'ui-child-waiting', 'ui-child-finished',
  ].map(phase => uia.indexOf("Write-UiaPhaseMarker '" + phase + "'"));
  assert.ok(phaseIndexes.every((index, i) => index >= 0 && (i === 0 || index > phaseIndexes[i - 1])),
    'flushed wrapper markers bracket start, payload and wait operations in order');

  const ui = automation.slice(automation.indexOf('async function ui'), automation.indexOf('async function assertModifiedPromptIsNotClicked'));
  const mutationProbe = automation.slice(automation.indexOf('async function assertModifiedPromptIsNotClicked'), automation.indexOf('async function assertKnownStatusDetailIsRecognized'));
  assert.match(ui, /safeUiFailureOutcome\(markers\.slice\(-3\)/,
    'UI errors reduce captured markers through the safe classifier');
  assert.doesNotMatch(ui, /stderrLine|error\.message/);
  const safeOutcomeSource = mutationProbe.match(/const safeOutcome = \/(.*)\/gi;/);
  assert.ok(safeOutcomeSource, 'mutation probe retains a fixed safe outcome parser');
  const safeOutcomeMatcher = new RegExp(safeOutcomeSource[1], 'i');
  for (const phase of [
    'ui-child-starting', 'ui-child-started', 'ui-child-waiting', 'ui-child-finished',
    'ui-payload-preparing', 'ui-payload-ready', 'ui-payload-writing', 'ui-payload-written',
  ]) assert.ok(safeOutcomeMatcher.test(phase), phase + ' is allowlisted in mutation evidence');
  assert.match(mutationProbe, /console\.log\('TUS_UIA_TEST: detail-probe-' \+ matcherOutcome\)/);
});



test('UIA child wait and cleanup phases are fixed safe diagnostics', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const automation = await readFile(new URL('../scripts/quit-prompt-acceptance.mjs', import.meta.url), 'utf8');
  const { safeUiFailureOutcome } = await import('../scripts/quit-prompt-acceptance.mjs');
  const phases = [
    'ui-child-killing', 'ui-child-kill-waiting', 'ui-child-exit-checking',
    'ui-child-output-draining', 'ui-child-finally-exit-checking',
    'ui-child-finally-killing', 'ui-child-finally-waiting', 'ui-child-disposing',
  ];
  for (const phase of phases) {
    assert.equal(safeUiFailureOutcome([phase]), phase, phase + ' is a fixed safe failure outcome');
  }

  const writerStart = windowsUI.indexOf('function Write-UiaPhaseMarker');
  const writerEnd = windowsUI.indexOf('function Write-PromptEvidence', writerStart);
  const markerWriter = windowsUI.slice(writerStart, writerEnd);
  for (const phase of phases) assert.ok(markerWriter.includes("'" + phase + "'"), phase + ' is allowlisted');

  const uia = await readFile(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url), 'utf8');
  for (const phase of phases) assert.ok(uia.includes("Write-UiaPhaseMarker '" + phase + "'"), phase + ' is emitted');
  const processWait = uia.indexOf('$process.WaitForExit($remaining)');
  const processTimeoutBranch = uia.indexOf('if ($waitTimedOut) {', processWait);
  const killing = uia.indexOf("Write-UiaPhaseMarker 'ui-child-killing'");
  const killWait = uia.indexOf("Write-UiaPhaseMarker 'ui-child-kill-waiting'", killing);
  const kill = uia.indexOf('$process.Kill()', killing);
  assert.ok(
    processWait >= 0 && processTimeoutBranch > processWait &&
      killing > processTimeoutBranch && kill > killing && kill < killWait,
    'the process timeout branch gates kill after its wait outcome',
  );
  const reap = uia.indexOf('$process.WaitForExit(1000)', killWait);
  const processCheck = uia.indexOf('if ($process.HasExited)', reap);
  assert.ok(
    killWait >= 0 && reap > killWait && processCheck > reap,
    'the bounded one-second reap completes before checking process exit',
  );
  const draining = uia.indexOf("Write-UiaPhaseMarker 'ui-child-output-draining'");
  assert.ok(draining >= 0, 'the child output-drain phase remains visible');

  const mutationProbe = automation.slice(
    automation.indexOf('async function assertModifiedPromptIsNotClicked'),
    automation.indexOf('async function assertKnownStatusDetailIsRecognized'),
  );
  const safeOutcomeSource = mutationProbe.match(/const safeOutcome = \/(.*)\/gi;/);
  assert.ok(safeOutcomeSource, 'mutation probe retains a fixed safe outcome parser');
  const safeOutcomeMatcher = new RegExp(safeOutcomeSource[1], 'i');
  for (const phase of phases) assert.ok(safeOutcomeMatcher.test(phase), phase + ' is allowlisted in mutation evidence');
});


test('UIA output drain stays bounded and cleanup reaps remain capped', async () => {
  const windowsUI = await readFile(new URL('../scripts/windows-quit-prompt.ps1', import.meta.url), 'utf8');
  const uia = await readFile(new URL('../scripts/windows-uia-child-reader.ps1', import.meta.url), 'utf8');
  assert.ok(!uia.includes('$process.WaitForExit()'), 'no process wait is unbounded');
  assert.equal(uia.split('$process.WaitForExit(1000)').length - 1, 2, 'both bounded child-reap waits remain');

  const outputHandlerStart = uia.indexOf('private void OnOutputDataReceived(');
  const tokenMatcher = 'TokenMatcher.Match(eventArgs.Data)';
  const outputHandlerEnd = uia.indexOf(tokenMatcher, outputHandlerStart) + tokenMatcher.length;
  assert.ok(outputHandlerStart >= 0 && outputHandlerEnd > outputHandlerStart, 'stdout handler is present');
  const outputHandler = uia.slice(outputHandlerStart, outputHandlerEnd);
  assert.ok(
    /if\s*\(eventArgs\.Data\s*==\s*null\)\s*\{[\s\S]*?OutputReadComplete\.Set\(\)[\s\S]*?return;\s*\}[\s\S]*?TokenMatcher\.Match\(eventArgs\.Data\)/.test(outputHandler),
    'stdout EOF signals completion before token parsing',
  );
  assert.equal(uia.split('OutputReadComplete.Set()').length - 1, 1, 'stdout EOF has one completion signal');

  const outputWait = '$outputCapture.OutputReadComplete.WaitOne($remaining)';
  const timeoutOutputWait = uia.indexOf(outputWait);
  const normalOutputWait = uia.indexOf(outputWait, timeoutOutputWait + outputWait.length);
  const processDeadline = '$remaining = 3000 - [int]$watch.ElapsedMilliseconds';
  const drainDeadline = '$remaining = 1000 - [int]$watch.ElapsedMilliseconds';
  const processWait = uia.indexOf('$process.WaitForExit($remaining)');
  const cleanupReap = uia.indexOf('$process.WaitForExit(1000)', processWait);
  const processBudget = uia.lastIndexOf(processDeadline, processWait);
  const timeoutRestart = uia.indexOf('$watch.Restart()', processWait);
  const timeoutBudget = uia.indexOf(drainDeadline, timeoutRestart);
  const normalDrainBudgetStart = uia.lastIndexOf("Write-UiaPhaseMarker 'ui-child-output-draining'");
  const normalRestart = uia.indexOf('$watch.Restart()', normalDrainBudgetStart);
  const normalBudget = uia.indexOf(drainDeadline, normalRestart);
  assert.ok(uia.includes('$watch = [Diagnostics.Stopwatch]::StartNew()'), 'the process wait starts its bounded stopwatch');
  assert.ok(
    processBudget >= 0 && processBudget < processWait &&
      processWait < cleanupReap && cleanupReap < timeoutRestart &&
      timeoutRestart < timeoutBudget && timeoutBudget < timeoutOutputWait &&
      timeoutOutputWait < normalRestart && normalRestart < normalBudget &&
      normalBudget < normalOutputWait,
    'process, reap and fresh bounded EOF drains occur in order',
  );
  assert.equal(uia.split(processDeadline).length - 1, 1, 'process completion keeps its three-second budget');
  assert.equal(uia.split(drainDeadline).length - 1, 2, 'each EOF drain gets a fresh one-second budget');
  assert.equal(uia.split('$watch.Restart()').length - 1, 2, 'each EOF drain starts a fresh timer');

  const processTimeoutBranch = uia.indexOf('if ($waitTimedOut) {', processWait);
  const timeoutDrainGuard = uia.indexOf("if (-not $drainComplete) { return 'timeout-no-phase' }");
  const phasesRead = uia.indexOf('$phases = @($outputCapture.Tokens.ToArray()', timeoutDrainGuard);
  const firstTimeoutNoPhase = uia.indexOf("return 'timeout-no-phase'");
  const secondTimeoutNoPhase = uia.indexOf("return 'timeout-no-phase'", firstTimeoutNoPhase + 1);
  const normalDrainStart = uia.lastIndexOf("Write-UiaPhaseMarker 'ui-child-output-draining'");
  const normalBudgetExit = uia.indexOf("return 'unavailable'", normalDrainStart);
  const normalDrainGuard = uia.indexOf('if (-not $drainComplete) {', normalOutputWait);
  const normalDrainExit = uia.indexOf("return 'unavailable'", normalDrainGuard);
  const resultsRead = uia.indexOf('$results = @($outputCapture.Tokens.ToArray()', normalDrainExit);
  assert.equal(uia.split("return 'timeout-no-phase'").length - 1, 2, 'timeout-no-phase is reserved for the process-timeout branch');
  assert.ok(
    processTimeoutBranch >= processWait && processTimeoutBranch < timeoutDrainGuard &&
      timeoutOutputWait < timeoutDrainGuard && timeoutDrainGuard < phasesRead &&
      phasesRead < secondTimeoutNoPhase && secondTimeoutNoPhase < normalDrainStart &&
      normalDrainStart < normalBudget && normalBudget < normalBudgetExit &&
      normalBudgetExit < normalOutputWait && normalOutputWait < normalDrainGuard &&
      normalDrainGuard < normalDrainExit && normalDrainExit < resultsRead,
    'process timeout returns timeout-no-phase; normal EOF timeout returns unavailable before result tokens',
  );
});
