import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { waitForExit } from '../scripts/graphics-smoke.mjs';
import { test } from 'node:test';
import path from 'node:path';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { runWindowsRelaunch, runWindowsUpdaterScenarios, safeInstallerHandoffEvents, safeNsisWizardEvents, safeWindowsScenarioFailureCategory, windowsRelaunchRequestStatus } from '../scripts/windows-updater-scenarios.mjs';

test('installer scenario failure awaits bounded Setup cleanup before returning', async () => {
  const events = [];
  const installerFailure = new Error('installer scenario failed');
  const outcomes = await runWindowsUpdaterScenarios({
    portable: async () => { events.push('portable'); return 'portable result'; },
    installer: async () => { events.push('installer'); throw installerFailure; },
    cleanupInstaller: async failure => {
      events.push('cleanup');
      assert.equal(failure, installerFailure, 'cleanup receives the original installer failure');
    },
  });

  assert.deepEqual(events, ['portable', 'installer', 'cleanup']);
  assert.equal(outcomes.portable.status, 'fulfilled', 'portable result remains independent');
  assert.equal(outcomes.installer.status, 'rejected');
  assert.equal(outcomes.installer.error, installerFailure, 'successful cleanup preserves the original installer error');
});

test('Windows installer acceptance still runs when portable acceptance fails', async () => {
  const calls = [];
  const portableFailure = new Error('portable acceptance failed');
  portableFailure.tusScenarioDiagnostic = { stage: 'extract', category: 'timeout', path: 'C:/private/path' };
  let outcomes, failure;
  try {
    outcomes = await runWindowsUpdaterScenarios({
      portable: async () => { calls.push('portable'); throw portableFailure; },
      installer: async () => { calls.push('installer'); return 'installed-source handoff'; },
    });
  } catch (error) {
    failure = error;
  }

  assert.deepEqual(calls, ['portable', 'installer'], 'both required package outcomes are attempted independently');
  assert.equal(failure, undefined, 'the runner returns both outcomes before the caller fails the job');
  assert.equal(outcomes.portable.status, 'rejected');
  assert.equal(outcomes.portable.error, portableFailure);
  assert.deepEqual(outcomes.portable.diagnostic, { stage: 'extract', category: 'timeout' });
  assert.deepEqual(outcomes.installer, {
    status: 'fulfilled',
    value: 'installed-source handoff',
    diagnostic: { stage: 'complete', category: 'none' },
  });
  assert.equal(JSON.stringify([outcomes.portable.diagnostic, outcomes.installer.diagnostic]).includes('C:/private/path'), false);
});

test('independent Windows scenario failures retain only safe stage and category', async () => {
  const calls = [];
  const portable = new Error('C:/private/archive exception');
  portable.tusScenarioDiagnostic = { stage: 'extract', category: 'timeout', path: 'C:/private/archive' };
  const installer = new Error('raw setup output /private/token');
  installer.tusScenarioDiagnostic = { stage: 'source-identity', category: 'process-exit', message: '/private/token' };
  const outcomes = await runWindowsUpdaterScenarios({
    portable: async () => { calls.push('portable'); throw portable; },
    installer: async () => { calls.push('installer'); throw installer; },
  });

  assert.deepEqual(calls, ['portable', 'installer']);
  assert.deepEqual(outcomes.portable.diagnostic, { stage: 'extract', category: 'timeout' });
  assert.deepEqual(outcomes.installer.diagnostic, { stage: 'source-identity', category: 'process-exit' });
  assert.equal(outcomes.portable.error, portable);
  assert.equal(outcomes.installer.error, installer);
  assert.equal(JSON.stringify([outcomes.portable.diagnostic, outcomes.installer.diagnostic]).includes('C:/private/archive'), false);
  assert.equal(JSON.stringify([outcomes.portable.diagnostic, outcomes.installer.diagnostic]).includes('token'), false);
});

test('NSIS wizard output drops paths and raw details while keeping fixed events', () => {
  const events = safeNsisWizardEvents([
    'TUS_NSIS_WIZARD event=process-found pid=4321',
    'TUS_NSIS_WIZARD event=destination-entered pid=4321',
    'TUS_NSIS_WIZARD event=destination-verified pid=4321',
    'TUS_NSIS_WIZARD event=completed pid=4321',
    'TUS_NSIS_WIZARD event=automation-failed C:/private/path',
    'raw exception C:/private/path',
  ].join('\n'));

  assert.deepEqual(events, [
    'TUS_NSIS_WIZARD event=process-found pid=4321',
    'TUS_NSIS_WIZARD event=destination-entered pid=4321',
    'TUS_NSIS_WIZARD event=destination-verified pid=4321',
    'TUS_NSIS_WIZARD event=completed pid=4321',
  ]);
  assert.equal(JSON.stringify(events).includes('C:/private/path'), false);
});

test('installer helper failures expose only fixed progress stages', () => {
  const events = safeInstallerHandoffEvents([
    'TUS_INSTALLER_HANDOFF stage=source-setup-started',
    'TUS_INSTALLER_HANDOFF stage=source-setup-complete',
    'TUS_INSTALLER_HANDOFF stage=source-identity-verified',
    'TUS_INSTALLER_HANDOFF stage=source-fixture-verified',
    'TUS_INSTALLER_HANDOFF stage=target-fixture-verified C:/private/path',
    'raw error /private/token',
  ].join('\n'));

  assert.deepEqual(events, [
    'TUS_INSTALLER_HANDOFF stage=source-setup-started',
    'TUS_INSTALLER_HANDOFF stage=source-setup-complete',
    'TUS_INSTALLER_HANDOFF stage=source-identity-verified',
    'TUS_INSTALLER_HANDOFF stage=source-fixture-verified',
  ]);
  assert.equal(JSON.stringify(events).includes('C:/private/path'), false);
  assert.equal(JSON.stringify(events).includes('token'), false);
});


test('installer relaunch request emits only a fixed path-free outcome', () => {
  const events = safeInstallerHandoffEvents([
    'TUS_INSTALLER_HANDOFF check=relaunch-request:match',
    'TUS_INSTALLER_HANDOFF check=relaunch-request:mismatch',
    'TUS_INSTALLER_HANDOFF check=relaunch-request:failed',
    'TUS_INSTALLER_HANDOFF check=relaunch-request:/private/path',
    'raw exception /private/path',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [
    'TUS_INSTALLER_HANDOFF check=relaunch-request:match',
    'TUS_INSTALLER_HANDOFF check=relaunch-request:mismatch',
    'TUS_INSTALLER_HANDOFF check=relaunch-request:failed',
  ]);
  assert.equal(JSON.stringify(events).includes('/private/path'), false);
});

test('Windows relaunch request requires exact Setup path and empty arguments', () => {
  const expected = 'C:/ci/downloads/TheUnfinishedShapes-Setup.exe';
  const outcomes = [
    windowsRelaunchRequestStatus(JSON.stringify({ execPath: expected, args: [] }), expected),
    windowsRelaunchRequestStatus(JSON.stringify({ execPath: expected.replace('TheUnfinishedShapes', 'THEUNFINISHEDSHAPES'), args: [] }), expected),
    windowsRelaunchRequestStatus(JSON.stringify({ execPath: 'C:/ci/downloads/other.exe', args: [] }), expected),
    windowsRelaunchRequestStatus(JSON.stringify({ execPath: expected, args: ['/S'] }), expected),
    windowsRelaunchRequestStatus('{invalid', expected),
  ];

  assert.deepEqual(outcomes, ['match', 'match', 'mismatch', 'mismatch', 'failed']);
  assert.equal(JSON.stringify(outcomes).includes(expected), false);
});

test('NSIS wizard snapshot preserves bounded page facts without UIA names or paths', () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=install-mode process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-match mode=present current-user=selected radios=two edits=none next=match install=missing finish=missing destination=unknown native-page=unknown uia-page=install-mode directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=main foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=4321';
  const events = safeNsisWizardEvents([
    safe,
    'TUS_NSIS_WIZARD snapshot stage=directory process=C:/private/user window=raw title=C:/private/user mode=present current-user=selected radios=two edits=one next=match install=missing finish=missing destination=C:/private/dir pid=4321',
    'raw UIA output C:/private/user',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);
});

test('NSIS handoff directory keeps the product filename leaf', async () => {
  const helpers = await import('../scripts/windows-updater-scenarios.mjs');
  assert.equal(
    helpers.windowsInstallerHandoffInstallDir?.('/runner/temp/Local') ?? 'missing',
    path.join('/runner/temp/Local', 'Programs', 'TheUnfinishedShapes'),
  );
});


test('NSIS snapshot distinguishes an empty main HWND from another process-owned wizard page', () => {
  const emptyMain = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const otherWizard = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=two main-window=present wizard-window=other foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const ambiguous = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=unknown mode=unknown current-user=unknown radios=many edits=one next=match install=missing finish=missing destination=unknown native-page=unknown uia-page=unknown directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=many main-window=present wizard-window=ambiguous foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const events = safeNsisWizardEvents([
    emptyMain,
    otherWizard,
    ambiguous,
    'TUS_NSIS_WIZARD snapshot stage=entry process=C:/private/path window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown uia-top-level=C:/private/path main-window=present wizard-window=other pid=9692',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [emptyMain, otherWizard, ambiguous]);
  assert.doesNotMatch(JSON.stringify(events), /C:\/private\/path/);
});

test('NSIS timeout snapshot classifies the exact HWND without exposing native text or names', async () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=4321';
  const finish = safe.replace('stage=entry', 'stage=finish')
    .replace('native-page=unknown', 'native-page=finish')
    .replace('uia-page=other', 'uia-page=finish');
  const unsafe = safe.replace('window-class=native-dialog', 'window-class=C:/private/window')
    .replace('native-title=error-like', 'native-title=C:/private/title')
    .replace('desktop=default-interactive', 'desktop=Default/user');
  const events = safeNsisWizardEvents([safe, finish, unsafe, 'raw window title C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe, finish]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('GetForegroundWindow'));
  assert.ok(script.includes('GetWindowText'));
  assert.ok(script.includes('GetUserObjectInformation'));
  assert.ok(script.includes('foreground=$Foreground'));
  assert.ok(script.includes('uia-provider=$UiaProvider'));
});

test('NSIS page snapshot sanitizes capped controls from the matched child HWND', async () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=installing process=path-match window=pid-match page-window=present page-parent=match page-process=match page-visible=visible page-class=native-dialog page-controls=two page-buttons=one page-edits=none page-static=one page-progress=none page-dialogs=none page-other=none option-page=other option-radio-count=none option-radio-style=mismatch current-user-preset=mismatch all-users-preset=mismatch current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=match native-page=other uia-page=other directory-edit=missing directory-browse=missing directory-text=missing install-progress=missing uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=other uia-provider=available uia-descendants=many win32-children=many win32-buttons=many win32-static=many session=match desktop=default-interactive visible=visible pid=4321';
  const pageFields = ['page-controls', 'page-buttons', 'page-edits', 'page-static', 'page-progress', 'page-dialogs', 'page-other'];
  const unsafe = pageFields.map((field) => {
    const value = safe.split(field + '=')[1].split(' ')[0];
    return safe.replace(field + '=' + value, field + '=C:/private/path');
  });
  const events = safeNsisWizardEvents([safe, ...unsafe, 'raw page caption C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('[TUSWindowApi]::GetWindow($pageHandle, 5)'));
  assert.ok(script.includes('page-controls=$PageControls page-buttons=$PageButtons page-edits=$PageEdits page-static=$PageStatic page-progress=$PageProgress page-dialogs=$PageDialogs page-other=$PageOther'));
});

test('NSIS timeout snapshot identifies pinned MUI page controls without exposing names', async () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=directory uia-page=other directory-edit=match directory-browse=match directory-text=match install-progress=missing uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=other uia-provider=available uia-descendants=many win32-children=many win32-buttons=many win32-static=many session=match desktop=default-interactive visible=visible pid=4321';
  const unsafe = safe.replace('directory-edit=match', 'directory-edit=C:/private/path');
  const events = safeNsisWizardEvents([safe, unsafe, 'raw native text C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes("FindWindowEx($MainWindowHandle, $after, '#32770', $null)"));
  assert.ok(script.includes('[TUSWindowApi]::GetParent($child)'));
  assert.ok(script.includes('Get-NativeControlStatus -Window $pageHandle -ControlId 1019'));
  assert.ok(!script.includes('Get-NativeControlStatus -Window $Handle -ControlId 1019'));
  for (const controlId of ['1019', '1001', '1006', '1004']) assert.ok(script.includes('-ControlId ' + controlId));
  assert.ok(script.includes('[System.Windows.Automation.ControlType]::ProgressBar'));
  assert.ok(script.includes('native-page=$NativePage'));
  assert.ok(script.indexOf("if ($null -eq $pageWindow -and -not $nativeDirectoryPage)") < script.indexOf('$selection.Select()'));
  assert.ok(script.indexOf("if ($null -eq $pageWindow -and -not $nativeDirectoryPage)") < script.indexOf("if ($stage -eq 'directory') {"));
});

test('NSIS child-page snapshot requires visible parent and process provenance', () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=present page-parent=match page-process=match page-visible=visible page-class=native-dialog page-controls=unknown page-buttons=unknown page-edits=unknown page-static=unknown page-progress=unknown page-dialogs=unknown page-other=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=directory uia-page=other directory-edit=match directory-browse=match directory-text=match install-progress=missing uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=other uia-provider=available uia-descendants=many win32-children=many win32-buttons=many win32-static=many session=match desktop=default-interactive visible=visible pid=4321';
  const unsafe = safe.replace('page-process=match', 'page-process=C:/private/process');
  const events = safeNsisWizardEvents([safe, unsafe, 'raw page HWND C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);
});
test('NSIS destination setter failure emits current page enums before failing closed', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const start = script.indexOf("if ($nativeEdit.SetStatus -ne 'sent') {");
  const end = script.indexOf("\n    if ($nativeEdit.SetMethod", start);
  const failureBranch = script.slice(start, end);
  const snapshotAt = failureBranch.indexOf('Write-WizardStateSnapshot -Snapshot $snapshot -WindowSummary $nativeWindow');
  const exitAt = failureBranch.lastIndexOf('exit 2');

  assert.ok(start >= 0 && end > start, 'the failure branch is bounded');
  assert.ok(snapshotAt >= 0 && snapshotAt < exitAt, 'the same verified page snapshot is emitted before fail-closed exit');
});


test('NSIS snapshot maps the production writer fields and rejects private option values', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const template = script.match(/^\s*\[Console\]::Out\.WriteLine\("(TUS_NSIS_WIZARD snapshot [^"]+)"\)$/m)?.[1];
  assert.ok(template, 'snapshot test exercises the production PowerShell writer format');
  assert.equal(template.includes('option-next=$OptionNext'), true, 'the production writer maps the pinned native Next status');

  const values = new Map(Object.entries({
    Stage: 'entry', PageWindow: 'present', PageParent: 'match', PageProcess: 'match',
    PageVisible: 'visible', PageClass: 'native-dialog',
    PageControls: 'unknown', PageButtons: 'unknown', PageEdits: 'unknown', PageStatic: 'unknown',
    PageProgress: 'unknown', PageDialogs: 'unknown', PageOther: 'unknown',
    OptionPage: 'unknown', OptionRadioCount: 'unknown', OptionRadioStyle: 'unknown',
    CurrentUserPreset: 'unknown', AllUsersPreset: 'unknown',
    CurrentUserSelected: 'unknown', AllUsersSelected: 'unknown', OptionNext: 'unknown',
    Title: 'product-missing', Mode: 'absent', CurrentUser: 'unknown',
    Radios: 'none', Edits: 'none', Next: 'missing', Install: 'missing', Finish: 'missing',
    Destination: 'unknown', NativePage: 'other', UiaPage: 'other',
    DirectoryEdit: 'missing', DirectoryBrowse: 'missing', DirectoryText: 'missing',
    InstallProgress: 'missing', UiaTopLevel: 'one', MainWindow: 'present',
    WizardWindow: 'none', Foreground: 'installer', WindowClass: 'native-dialog',
    NativeTitle: 'other', UiaProvider: 'available', UiaDescendants: 'many',
    Win32Children: 'many', Win32Buttons: 'many', Win32Static: 'many',
    Session: 'match', Desktop: 'default-interactive', Visible: 'visible', ProcessId: '4321',
  }));
  const actualBoundary = template.replace(/\$(\w+)/g, (_, name) => {
    assert.ok(values.has(name), 'writer field is covered: ' + name);
    return values.get(name);
  });
  assert.deepEqual(safeNsisWizardEvents(actualBoundary), [actualBoundary]);

  // Only the new enum tuple changes here; the #882 title/mode/radio/Next boundary stays unchanged.
  const recognizedSchema = actualBoundary
    .replace('option-page=unknown', 'option-page=install-options')
    .replace('option-radio-count=unknown', 'option-radio-count=two')
    .replace('option-radio-style=unknown', 'option-radio-style=match')
    .replace('current-user-preset=unknown', 'current-user-preset=match')
    .replace('all-users-preset=unknown', 'all-users-preset=match')
    .replace('current-user-selected=unknown', 'current-user-selected=selected')
    .replace('all-users-selected=unknown', 'all-users-selected=unselected')
    .replace('option-next=unknown', 'option-next=match');
  assert.deepEqual(safeNsisWizardEvents(recognizedSchema), [recognizedSchema], 'enum mapping is not page-recognition evidence');

  for (const field of [
    'option-page', 'option-radio-count', 'option-radio-style',
    'current-user-preset', 'all-users-preset',
    'current-user-selected', 'all-users-selected', 'option-next',
    'page-controls', 'page-buttons', 'page-edits', 'page-static', 'page-progress', 'page-dialogs', 'page-other',
  ]) {
    const start = recognizedSchema.indexOf(field + '=') + field.length + 1;
    const end = recognizedSchema.indexOf(' ', start);
    const unsafe = recognizedSchema.slice(0, start) + 'C:/private/account' + recognizedSchema.slice(end);
    assert.deepEqual(safeNsisWizardEvents(unsafe), [], field + ' rejects raw captions and paths');
  }
  assert.deepEqual(safeNsisWizardEvents(recognizedSchema + ' caption=C:/private/account'), []);

  const pageReader = script.slice(script.indexOf('function Get-NsisPageSummary'), script.indexOf('function Get-Win32WindowSummary'));
  assert.ok(pageReader.includes('GetWindow($pageHandle, 5)'), 'native controls are read from the verified child page');
  assert.ok(pageReader.includes('$pageControlsCount++'), 'direct child counts come from the verified page HWND');
  assert.ok(pageReader.includes('Get-SafeControlCount -Count $pageControlsCount'), 'the producer emits capped page counts');
  assert.ok(pageReader.includes('($_.Style -band 0x0f) -eq 9'), 'only the pinned auto-radio style is counted');
  assert.ok(pageReader.includes('Get-NativeRadioSelection'), 'selected state is read through the bounded native query');
  assert.equal(script.includes('option-page=$OptionPage'), true);
  assert.equal(script.includes('caption=$Caption'), false);
  const nextReader = script.slice(script.indexOf('function Get-MuiNextControl'), script.indexOf('function Get-NsisPageSummary'));
  for (const check of [
    'GetDlgItem($MainWindowHandle, 1)', 'GetParent($control) -ne $MainWindowHandle',
    'GetWindowThreadProcessId($MainWindowHandle, [ref]$mainWindowProcessId)',
    'GetWindowThreadProcessId($control, [ref]$controlProcessId)',
    'GetClassName($control', 'IsWindowVisible($control)', 'IsWindowEnabled($control)',
  ]) assert.ok(nextReader.includes(check), 'native Next must match its direct child window facts');
  const optionActionStart = script.indexOf("if ($nativeWindow.OptionPage -eq 'install-options') {", script.indexOf("if ($stage -eq 'entry') {"));
  const optionActionEnd = script.indexOf("if ($modeStatus -eq 'unknown')", optionActionStart);
  assert.ok(optionActionStart >= 0 && optionActionEnd > optionActionStart);
  const optionAction = script.slice(optionActionStart, optionActionEnd);
  for (const check of [
    "$nativeWindow.CurrentUserSelected -ne 'selected'",
    "$nativeWindow.AllUsersSelected -ne 'unselected'",
    "$nativeWindow.PageProcess -ne 'match'",
    "$nativeWindow.PageParent -ne 'match'",
    "$nativeWindow.OptionNext -ne 'match'",
    'Get-MuiNextControl -ProcessId $script:installerProcessId -MainWindowHandle $script:mainWindowHandle',
    'SendMessageTimeout($nextControl.Handle, 0x00F5',
  ]) assert.ok(optionAction.includes(check), 'native Next action remains fail-closed: ' + check);
  assert.equal(script.includes('option-next=$OptionNext'), true);
  assert.equal(script.includes('caption=$Caption'), false);
});

test('NSIS directory target uses native Edit 1019 and exact readback before install', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageTimeout'), 'native Edit text uses Unicode for the UTF-16 message buffer');
  const readerStart = script.indexOf('function Get-NativeDirectoryEditText');
  const setterStart = script.indexOf('function Set-NativeDirectoryEdit');
  const setterEnd = script.indexOf('function Get-NativeRadioSelection', setterStart);
  assert.ok(readerStart >= 0 && setterStart > readerStart && setterEnd > setterStart, 'the native directory edit writer and reader exist');
  const reader = script.slice(readerStart, setterStart);
  const setter = script.slice(setterStart, setterEnd);
  assert.ok(reader.includes('SendMessageTimeout($Control, 0x000D') && reader.includes('0x0002, 500'),
    'WM_GETTEXT is bounded inside the native readback helper');
  assert.ok(setter.includes('Get-NativeDirectoryEditText -Control $control'),
    'the setter verifies the exact control through the native reader');
  for (const check of [
    'GetDlgItem($PageHandle, 1019)',
    'GetWindowThreadProcessId($control',
    'GetParent($control) -ne $PageHandle',
    'GetClassName($control',
    'IsWindowVisible($control)',
    'IsWindowEnabled($control)',
    'SendMessageTimeout($control, 0x000C',
    '[System.IO.Path]::GetFullPath($value)',
  ]) assert.ok(setter.includes(check), 'native Edit setter keeps the verified control and exact readback: ' + check);

  const directoryStart = script.indexOf("if ($stage -eq 'directory') {");
  const installStart = script.indexOf("if ($stage -eq 'installing') {", directoryStart);
  assert.ok(directoryStart >= 0 && installStart > directoryStart);
  const directory = script.slice(directoryStart, installStart);
  const setAt = directory.indexOf('Set-NativeDirectoryEdit -ProcessId $script:installerProcessId');
  const enteredAt = directory.indexOf("Write-WizardEvent -Name 'destination-entered'");
  const verifiedAt = directory.indexOf("Write-WizardEvent -Name 'destination-verified'");
  const clickAt = directory.indexOf('SendMessageTimeout($nextControl.Handle, 0x00F5');
  assert.ok(setAt >= 0 && enteredAt > setAt && verifiedAt > enteredAt && clickAt > verifiedAt,
    'the exact native field readback precedes any wizard advance');
  assert.ok(directory.includes('if (-not $nativeDirectoryPage)'));
  assert.equal(directory.includes("$uiaPageStatus -ne 'directory'"), false,
    'a missing UIA page label does not block the independently verified native Directory controls');
  assert.equal(directory.includes('$valuePattern.SetValue'), false,
    'destination entry does not depend on the unavailable UIA ValuePattern');
});

test('NSIS destination mismatch diagnostics expose only fixed readback categories', async () => {
  const safeLines = [
    'TUS_NSIS_WIZARD event=destination-readback-product-leaf-appended pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-same-parent pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-same-leaf pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-other pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-unchanged pid=4321',
    'TUS_NSIS_WIZARD event=destination-before-read-unavailable pid=4321',
    'TUS_NSIS_WIZARD event=destination-before-read-empty pid=4321',
    'TUS_NSIS_WIZARD event=destination-before-read-invalid pid=4321',
  ];
  const events = safeNsisWizardEvents([
    ...safeLines,
    'TUS_NSIS_WIZARD event=destination-readback-same-parent C:/private/path pid=4321',
    'TUS_NSIS_WIZARD event=destination-before-read-unavailable value=C:/private/path pid=4321',
    'TUS_NSIS_WIZARD event=destination-before-read-empty value=C:/private/path pid=4321',
    'TUS_NSIS_WIZARD event=destination-before-read-invalid value=C:/private/path pid=4321',
    'raw destination C:/private/path',
  ].join(String.fromCharCode(10)));
  assert.deepEqual(events, safeLines);
  assert.equal(JSON.stringify(events).includes('C:/private/path'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const writerStart = script.indexOf('function Write-WizardEvent');
  const trapStart = script.indexOf('trap {', writerStart);
  assert.ok(writerStart >= 0 && trapStart > writerStart);
  const writer = script.slice(writerStart, trapStart);
  for (const name of [
    'destination-readback-product-leaf-appended',
    'destination-readback-same-parent',
    'destination-readback-same-leaf',
    'destination-readback-other',
    'destination-readback-unchanged',
    'destination-before-read-unavailable',
    'destination-before-read-empty',
    'destination-before-read-invalid',
  ]) assert.ok(writer.includes("'" + name + "'"), 'writer permits only fixed readback event: ' + name);

  const setterStart = script.indexOf('function Set-NativeDirectoryEdit');
  const setterEnd = script.indexOf('function Get-NativeRadioSelection', setterStart);
  const setter = script.slice(setterStart, setterEnd);
  for (const category of ['product-leaf-appended', 'same-parent', 'same-leaf', 'other', 'unchanged']) {
    assert.ok(setter.includes("$result.MismatchClass = '" + category + "'"),
      'the actual native readback producer maps to a fixed category: ' + category);
  }

  const beforeReadAt = setter.indexOf('$beforeValue = Get-NativeDirectoryEditText -Control $control');
  const setValueAt = setter.indexOf('SendMessageTimeout($control, 0x000C');
  const afterReadAt = setter.indexOf('$value = Get-NativeDirectoryEditText -Control $control');
  assert.ok(beforeReadAt >= 0 && setValueAt > beforeReadAt && afterReadAt > setValueAt,
    'the bounded native reader brackets WM_SETTEXT without changing the destination gate');
  assert.ok(setter.includes('[String]::Equals($normalizedBeforeValue, $normalizedValue, [StringComparison]::OrdinalIgnoreCase)') &&
      setter.includes("$result.MismatchClass = 'unchanged'"),
    'only an unchanged post-set value receives the fixed unchanged category');
  for (const status of ['unavailable', 'empty', 'invalid', 'read']) {
    assert.ok(setter.includes("$beforeReadClass = '" + status + "'"),
      'the pre-set reader records only a fixed local status: ' + status);
  }
  assert.ok(setter.includes('[String]::IsNullOrWhiteSpace($beforeValue)') &&
      setter.includes('$result.BeforeReadClass = $beforeReadClass') &&
      !setter.includes("$result.MismatchClass = 'before-read-invalid'"),
    'pre-read failures stay separate from the post-set mismatch class');

  const directoryStart = script.indexOf("if ($stage -eq 'directory') {");
  const installStart = script.indexOf("if ($stage -eq 'installing') {", directoryStart);
  const directory = script.slice(directoryStart, installStart);
  assert.ok(directory.includes('switch ($nativeEdit.MismatchClass)'));
  assert.ok(directory.includes("'unchanged' { 'destination-readback-unchanged' }"));
  assert.ok(directory.includes('switch ($nativeEdit.BeforeReadClass)'));
  assert.ok(directory.includes("'invalid' { 'destination-before-read-invalid' }"));
  assert.ok(directory.includes("'empty' { 'destination-before-read-empty' }"));
  assert.ok(directory.includes("'unavailable' { 'destination-before-read-unavailable' }"));
  assert.ok(directory.includes("Write-WizardEvent -Name $beforeReadEvent"));
  assert.ok(directory.includes("Write-WizardEvent -Name $readbackEvent"));
});

test('NSIS mismatch keeps pre-read status separate from post-readback relation', async () => {
  const safeLines = [
    'TUS_NSIS_WIZARD event=destination-before-read-invalid pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-same-parent pid=4321',
  ];
  const events = safeNsisWizardEvents([
    ...safeLines,
    'TUS_NSIS_WIZARD event=destination-before-read-invalid value=C:/private/path pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-same-parent value=C:/private/path pid=4321',
  ].join(String.fromCharCode(10)));
  assert.deepEqual(events, safeLines);
  assert.equal(JSON.stringify(events).includes('C:/private/path'), false);
});

test('NSIS destination producer keeps before-read and post-readback classifications independent', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const setterStart = script.indexOf('function Set-NativeDirectoryEdit');
  const setterEnd = script.indexOf('function Get-NativeRadioSelection', setterStart);
  const setter = script.slice(setterStart, setterEnd);
  assert.ok(setter.includes("$beforeReadClass = 'unavailable'"));
  assert.ok(setter.includes('$result.BeforeReadClass = $beforeReadClass'));
  assert.equal(setter.includes("$result.MismatchClass = 'before-read-invalid'"), false);

  const directoryStart = script.indexOf("if ($stage -eq 'directory') {");
  const installStart = script.indexOf("if ($stage -eq 'installing') {", directoryStart);
  const directory = script.slice(directoryStart, installStart);
  assert.ok(directory.includes('switch ($nativeEdit.BeforeReadClass)'));
  assert.ok(directory.includes('switch ($nativeEdit.MismatchClass)'));
  assert.ok(directory.includes("Write-WizardEvent -Name $beforeReadEvent"));
  assert.ok(directory.includes("Write-WizardEvent -Name $readbackEvent"));
});


test('NSIS destination readback preserves only safe root relation events', () => {
  const sameRoot = 'TUS_NSIS_WIZARD event=destination-readback-same-root pid=4321';
  const differentRoot = 'TUS_NSIS_WIZARD event=destination-readback-different-root pid=4321';
  const events = safeNsisWizardEvents([
    sameRoot,
    differentRoot,
    'TUS_NSIS_WIZARD event=destination-readback-same-root pid=4321 C:/private/path',
    'raw destination C:/private/path',
  ].join(String.fromCharCode(10)));
  assert.deepEqual(events, [sameRoot, differentRoot]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);
});


test('NSIS destination readback relation events are accepted by the PowerShell writer', async () => {
  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const start = source.indexOf('function Write-WizardEvent {');
  const end = source.indexOf('\ntrap {', start);
  assert.ok(start >= 0 && end > start, 'the event writer and its following trap exist');
  const validateSet = source.slice(start, end).match(/\[ValidateSet\(([\s\S]*?)\)\]/)?.[1] ?? '';
  for (const event of ['destination-readback-same-root', 'destination-readback-different-root']) {
    assert.ok(validateSet.includes("'" + event + "'"), event + ' is allowed by the writer');
  }
});


test('NSIS destination diagnostics map reachable producer failure paths', async () => {
  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const writerStart = source.indexOf('function Write-WizardEvent {');
  const writerEnd = source.indexOf('\ntrap {', writerStart);
  const setterStart = source.indexOf('function Set-NativeDirectoryEdit {');
  const setterEnd = source.indexOf('\nfunction Get-NativeRadioSelection', setterStart);
  const mappingStart = source.indexOf('$setFailureEvent = switch ($nativeEdit.SetFailureStage)');
  const mappingEnd = source.indexOf('\n      Write-WizardEvent -Name $setFailureEvent', mappingStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart);
  assert.ok(setterStart >= 0 && setterEnd > setterStart);
  assert.ok(mappingStart >= 0 && mappingEnd > mappingStart);

  const validateSet = source.slice(writerStart, writerEnd).match(/\[ValidateSet\(([\s\S]*?)\)\]/)?.[1] ?? '';
  const setter = source.slice(setterStart, setterEnd);
  const mappingSource = source.slice(mappingStart, mappingEnd);
  const stages = new Map([
    ['precondition', 'destination-set-precondition-unavailable'],
    ['provenance', 'destination-set-provenance-unavailable'],
    ['control', 'destination-set-control-unavailable'],
    ['message', 'destination-set-message-failed'],
    ['exception', 'destination-set-exception'],
  ]);
  const reachableStages = [...stages.keys()].filter(stage => {
    const start = setter.indexOf("SetFailureStage = '" + stage + "'");
    const next = setter.indexOf('SetFailureStage =', start + 1);
    return start >= 0 && setter.slice(start, next < 0 ? setter.length : next).includes('return [pscustomobject]$result');
  }).sort();
  const producerMapping = Object.fromEntries([...mappingSource.matchAll(/(?:'([a-z-]+)'|default)\s*\{\s*'([a-z-]+)'\s*\}/g)]
    .map(([, stage, event]) => [stage ?? 'default', event]));
  const editsBranchStart = source.indexOf('} elseif ($edits.Count -gt 1) {');
  const editsBranchEnd = source.indexOf('\n    } else {', editsBranchStart);
  const editsBranch = source.slice(editsBranchStart, editsBranchEnd);
  const editEvents = [...editsBranch.matchAll(/Write-WizardEvent\s+-Name\s+'([a-z-]+)'/g)].map(([, event]) => event);
  const exitCode = editsBranch.match(/exit\s+(\d+)/)?.[1] ?? null;
  const lines = [...stages.values()].map(event => 'TUS_NSIS_WIZARD event=' + event + ' pid=4321');
  const fallback = 'TUS_NSIS_WIZARD event=destination-set-unknown pid=4321';
  const ambiguous = 'TUS_NSIS_WIZARD event=destination-edits-ambiguous pid=4321';
  const prepare = 'TUS_NSIS_WIZARD event=destination-set-prepare-unavailable pid=4321';
  const actual = {
    reachableStages,
    producerMapping,
    prepareAllowed: validateSet.includes("'destination-set-prepare-unavailable'"),
    prepareSanitized: safeNsisWizardEvents(prepare).length > 0,
    editEvents,
    writerAllowsAmbiguousEdit: validateSet.includes("'destination-edits-ambiguous'"),
    exitCode,
    sanitized: safeNsisWizardEvents([
      ...lines, fallback, ambiguous, ambiguous + ' C:/private/path', 'raw destination C:/private/path',
    ].join(String.fromCharCode(10))),
  };
  const expected = {
    reachableStages: [...stages.keys()].sort(),
    producerMapping: Object.fromEntries([...stages, ['default', 'destination-set-unknown']]),
    prepareAllowed: false,
    prepareSanitized: false,
    editEvents: ['destination-edits-ambiguous', 'destination-unavailable'],
    writerAllowsAmbiguousEdit: true,
    exitCode: '2',
    sanitized: [...lines, fallback, ambiguous],
  };
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual.sanitized).includes('C:/private'), false);
  for (const line of [...lines, fallback, ambiguous]) {
    const event = line.match(/event=([a-z-]+)/)[1];
    assert.ok(validateSet.includes("'" + event + "'"), event + ' is accepted by the writer');
  }
  assert.ok(validateSet.includes("'destination-set-uia-fallback'"));
  assert.ok(source.includes("Write-WizardEvent -Name 'destination-set-uia-fallback'"));
});


test('NSIS destination setter rechecks same Edit ownership after WM_SETTEXT and logs only safe result enums', async () => {
  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const setterStart = source.indexOf('function Set-NativeDirectoryEdit {');
  const setterEnd = source.indexOf(String.fromCharCode(10) + 'function Get-NativeRadioSelection', setterStart);
  const setter = source.slice(setterStart, setterEnd);
  assert.ok(setterStart >= 0 && setterEnd > setterStart);

  const sent = setter.indexOf("$result.SetStatus = 'sent'");
  const readback = setter.indexOf('$value = Get-NativeDirectoryEditText -Control $control', sent);
  assert.ok(sent >= 0 && readback > sent);
  const postSetCheck = setter.slice(sent, readback);
  for (const check of [
    '[TUSWindowApi]::GetWindowThreadProcessId($control',
    '$postSetProcessId -ne [uint32]$ProcessId',
    '[TUSWindowApi]::GetParent($control) -ne $PageHandle',
    '[TUSWindowApi]::GetClassName($control',
    "$postSetClass.ToString() -ne 'Edit'",
    '[TUSWindowApi]::GetDlgItem($PageHandle, 1019) -ne $control',
  ]) {
    assert.ok(postSetCheck.includes(check), 'post-set check verifies the same Edit: ' + check);
  }

  const directoryStart = source.indexOf("if ($stage -eq 'directory') {");
  const installStart = source.indexOf("if ($stage -eq 'installing') {", directoryStart);
  const directory = source.slice(directoryStart, installStart);
  const setterCall = directory.indexOf('$nativeEdit = Set-NativeDirectoryEdit');
  const eventMapStart = directory.indexOf('$postSetEvent = switch ($nativeEdit.PostSetControlStatus)');
  const eventMapEnd = directory.indexOf('Write-WizardEvent -Name $postSetEvent', eventMapStart);
  const rejectStart = directory.indexOf("if ($nativeEdit.PostSetControlStatus -ne 'match')", eventMapEnd);
  const readbackGate = directory.indexOf("if ($nativeEdit.Readback -eq 'unknown')", rejectStart);
  assert.ok(setterCall >= 0 && eventMapStart > setterCall && eventMapEnd > eventMapStart);
  assert.ok(rejectStart > eventMapEnd && readbackGate > rejectStart);
  const reject = directory.slice(rejectStart, readbackGate);
  assert.ok(reject.includes('exit 2'), 'non-matching provenance exits before using the destination readback');
  assert.ok(setter.includes('[String]::Equals($normalizedValue, $normalizedExpected, [StringComparison]::OrdinalIgnoreCase)'), 'the exact normalized destination gate remains');

  const writerStart = source.indexOf('function Write-WizardEvent {');
  const writerEnd = source.indexOf(String.fromCharCode(10) + 'trap {', writerStart);
  const validateSet = source.slice(writerStart, writerEnd).match(/\[ValidateSet\(([\s\S]*?)\)\]/)?.[1] ?? '';
  const mapping = directory.slice(eventMapStart, eventMapEnd);
  const statuses = ['match', 'mismatch', 'unknown'];
  const safeLines = statuses.map(status => 'TUS_NSIS_WIZARD event=destination-postset-edit-' + status + ' pid=4321');
  for (const status of statuses) {
    const event = 'destination-postset-edit-' + status;
    assert.ok(mapping.includes("'" + status + "' { '" + event + "' }"), status + ' maps to its fixed event');
    assert.ok(validateSet.includes("'" + event + "'"), event + ' is accepted by the writer');
  }
  assert.ok(mapping.includes("default { 'destination-postset-edit-unknown' }"));
  const sanitized = safeNsisWizardEvents([
    ...safeLines,
    ...safeLines.map(line => line + ' value=C:/private/path'),
    'raw window output C:/private/path',
  ].join(String.fromCharCode(10)));
  assert.deepEqual(sanitized, safeLines);
  assert.equal(JSON.stringify(sanitized).includes('C:/private/path'), false);
});

test('Windows installer relaunch failures preserve fixed safe stage enums', async () => {
  const stages = [
    'relaunch-cancel', 'relaunch-approve', 'relaunch-exit',
    'relaunch-prompt', 'relaunch-request', 'relaunch-target',
  ];
  const diagnosticFor = async stage => {
    const failure = new Error('C:/private/installer output');
    failure.tusScenarioDiagnostic = { stage, category: 'other', path: 'C:/private/installer output' };
    const outcomes = await runWindowsUpdaterScenarios({
      portable: async () => 'portable result',
      installer: async () => { throw failure; },
    });
    return outcomes.installer.diagnostic;
  };

  for (const stage of stages) {
    assert.deepEqual(await diagnosticFor(stage), { stage, category: 'other' });
  }
  assert.deepEqual(await diagnosticFor('relaunch-C:/private/path'), { stage: 'unknown', category: 'other' });
  assert.equal(JSON.stringify(stages).includes('C:/private'), false);
});

test('installer click rejection is separate and cleanup receives the exact started child', async () => {
  const child = { exitCode: null };
  const clickFailure = Object.assign(new Error('C:/private/click failure'), { name: 'TimeoutError' });
  let cleanedChild;
  const outcomes = await runWindowsUpdaterScenarios({
    portable: async () => {},
    installer: () => runWindowsRelaunch({
      child,
      click: async () => { throw clickFailure; },
      waitForExit: async observedChild => { assert.equal(observedChild, child); },
      cleanup: async observedChild => { cleanedChild = observedChild; },
    }),
  });

  assert.equal(cleanedChild, child);
  assert.equal(outcomes.installer.error, clickFailure);
  assert.equal(safeWindowsScenarioFailureCategory(clickFailure), 'timeout');
  assert.deepEqual(outcomes.installer.diagnostic, { stage: 'relaunch-click', category: 'timeout' });
  assert.doesNotMatch(JSON.stringify(outcomes.installer.diagnostic), /C:\/private/);
});

test('relaunch request validation failure cleans the exact Setup after source exit', async () => {
  const child = { exitCode: 0 };
  const completed = new Set();
  const validationFailure = new Error('private relaunch marker mismatch');
  let cleanupChild;
  let cleanupFailure;
  const result = await runWindowsRelaunch({
    child,
    click: async () => { completed.add('click'); },
    waitForExit: async observedChild => {
      assert.equal(observedChild, child);
      completed.add('exit');
    },
    validateRequest: async () => {
      assert.deepEqual([...completed].sort(), ['click', 'exit'], 'request validation waits for click and source exit');
      throw validationFailure;
    },
    cleanup: async (observedChild, failure) => {
      cleanupChild = observedChild;
      cleanupFailure = failure;
    },
  }).then(value => ({ value }), error => ({ error }));

  assert.equal(result.error, validationFailure);
  assert.equal(cleanupChild, child, 'cleanup uses the exact started updater child');
  assert.equal(cleanupFailure, validationFailure, 'cleanup receives the request validation failure');
  assert.deepEqual(validationFailure.tusScenarioDiagnostic, { stage: 'relaunch-request', category: 'other' });
  assert.equal(JSON.stringify(validationFailure.tusScenarioDiagnostic).includes('private'), false);
});

test('installer bounded source exit timeout is distinct and cleans its exact child', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  let cleanedChild;
  const outcomes = await runWindowsUpdaterScenarios({
    portable: async () => {},
    installer: () => runWindowsRelaunch({
      child,
      click: async () => {},
      waitForExit: observedChild => waitForExit(observedChild, 5),
      cleanup: async observedChild => { cleanedChild = observedChild; },
    }),
  });

  assert.equal(cleanedChild, child);
  assert.equal(outcomes.installer.error?.code, 'ETIMEDOUT');
  assert.deepEqual(outcomes.installer.diagnostic, { stage: 'relaunch-source-exit', category: 'timeout' });
  assert.equal(child.listenerCount('exit'), 0);
});

test('installer relaunch cleanup failure is distinct and does not expose details', async () => {
  const child = { exitCode: 0 };
  const cleanupFailure = new Error('C:/private/cleanup failure');
  const outcomes = await runWindowsUpdaterScenarios({
    portable: async () => {},
    installer: () => runWindowsRelaunch({
      child,
      click: async () => {},
      waitForExit: async observedChild => { assert.equal(observedChild, child); },
      cleanup: async observedChild => {
        assert.equal(observedChild, child);
        throw cleanupFailure;
      },
    }),
  });

  assert.equal(outcomes.installer.error, cleanupFailure);
  assert.deepEqual(outcomes.installer.diagnostic, { stage: 'relaunch-cleanup', category: 'other' });
  assert.doesNotMatch(JSON.stringify(outcomes.installer.diagnostic), /C:\/private/);
});


test('NSIS UIA fallback trusts the verified native Edit and ValuePattern over UIA type label', async () => {
  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const fallbackStart = source.indexOf('function Set-NativeDirectoryEditWithUIA {');
  const fallbackEnd = source.indexOf(String.fromCharCode(10) + 'function Set-NativeDirectoryEdit {', fallbackStart);
  const setterEnd = source.indexOf(String.fromCharCode(10) + 'function Get-NativeRadioSelection', fallbackEnd);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart && setterEnd > fallbackEnd);
  const fallback = source.slice(fallbackStart, fallbackEnd);
  const setter = source.slice(fallbackEnd, setterEnd);

  for (const identity of [
    '[System.Windows.Automation.AutomationElement]::FromHandle($Control)',
    '$uiCurrent.ProcessId -ne $ProcessId',
    '[IntPtr]$uiCurrent.NativeWindowHandle -ne $Control',
    '$uiCurrent.IsOffscreen',
    '-not $uiCurrent.IsEnabled',
    '$valuePattern.Current.IsReadOnly',
    '$valuePattern.SetValue($ExpectedValue)',
    "[TUSWindowApi]::GetDlgItem($PageHandle, 1019) -ne $Control",
    "$controlClass.ToString() -ne 'Edit'",
  ]) assert.ok(fallback.includes(identity) || setter.includes(identity), 'exact native/UIA value identity remains guarded: ' + identity);

  assert.equal(fallback.includes('$uiCurrent.ControlType'), false,
    'the confirmed type-label mismatch cannot reject a native Edit 1019 with the matching HWND');
  assert.ok(fallback.includes("return 'postset-mismatch'") &&
    fallback.includes('[TUSWindowApi]::GetDlgItem($PageHandle, 1019) -ne $Control'),
    'post-set native provenance remains fail-closed');
});
test('NSIS directory UIA fallback is bound to the same writable native Edit and read back', async () => {
  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const fallbackStart = source.indexOf('function Set-NativeDirectoryEditWithUIA {');
  const fallbackEnd = source.indexOf(String.fromCharCode(10) + 'function Set-NativeDirectoryEdit {', fallbackStart);
  const fallback = source.slice(fallbackStart, fallbackEnd);
  const setterStart = fallbackEnd;
  const setterEnd = source.indexOf(String.fromCharCode(10) + 'function Get-NativeRadioSelection', setterStart);
  const setter = source.slice(setterStart, setterEnd);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart && setterEnd > setterStart);
  for (const guard of [
    '[System.Windows.Automation.AutomationElement]::FromHandle($Control)',
    '[IntPtr]$uiCurrent.NativeWindowHandle -ne $Control',
    '$uiCurrent.ProcessId -ne $ProcessId',
    '$uiCurrent.IsOffscreen',
    '-not $uiCurrent.IsEnabled',
    '[TUSWindowApi]::GetDlgItem($PageHandle, 1019) -ne $Control',
    '$valuePattern.Current.IsReadOnly',
  ]) assert.ok(fallback.includes(guard), 'UIA fallback guard exists: ' + guard);

  const setValue = fallback.indexOf('$valuePattern.SetValue($ExpectedValue)');
  assert.ok(setValue >= 0, 'fallback uses ValuePattern on the verified Edit');
  const postsetControlCheck = fallback.indexOf('[TUSWindowApi]::GetDlgItem($PageHandle, 1019) -ne $Control -or', setValue);
  const postsetReject = fallback.indexOf("return 'postset-mismatch'", setValue);
  assert.ok(postsetControlCheck > setValue && postsetReject > postsetControlCheck, 'fallback rechecks and fails closed on changed native provenance');
  assert.doesNotMatch(fallback, /FindAll|AutomationEdits/);

  const retryCondition = setter.indexOf("if ($result.SetMethod -eq 'message' -and -not $readbackMatches)");
  const retryCall = setter.indexOf('Set-NativeDirectoryEditWithUIA', retryCondition);
  const retryReadback = setter.indexOf('$value = Get-NativeDirectoryEditText -Control $control', retryCall);
  const finalGate = setter.indexOf('if ($readbackMatches)', retryReadback);
  assert.ok(retryCondition >= 0 && retryCall > retryCondition && retryReadback > retryCall && finalGate > retryReadback,
    'a successful message with mismatched readback retries UIA once, then uses native readback');
  assert.ok(setter.includes('$result.SetMethod = \'uia\''));

  const directoryStart = source.indexOf("if ($stage -eq 'directory') {");
  const installStart = source.indexOf("if ($stage -eq 'installing') {", directoryStart);
  const directory = source.slice(directoryStart, installStart);
  assert.ok(!directory.includes('-AutomationEdits $edits'));
  assert.ok(directory.includes("$nativeEdit.SetMethod -eq 'uia'"));
});

test('NSIS UIA element diagnostics preserve only the exact fixed guard outcome', async () => {
  const statuses = ['owner-mismatch', 'handle-mismatch', 'offscreen', 'disabled'];
  const safe = statuses.map(status => 'TUS_NSIS_WIZARD event=destination-uia-' + status + ' pid=4321');
  const output = [...safe, ...safe.map(line => line + ' value=C:/private/path')].join(String.fromCharCode(10));
  assert.deepEqual(safeNsisWizardEvents(output), safe);
  assert.equal(JSON.stringify(safeNsisWizardEvents(output)).includes('C:/private/path'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const start = script.indexOf('function Set-NativeDirectoryEditWithUIA {');
  const end = script.indexOf(String.fromCharCode(10) + 'function Set-NativeDirectoryEdit {', start);
  assert.ok(start >= 0 && end > start);
  const fallback = script.slice(start, end);
  const guards = [
    ["$uiCurrent.ProcessId -ne $ProcessId", "return 'owner-mismatch'"],
    ["[IntPtr]$uiCurrent.NativeWindowHandle -ne $Control", "return 'handle-mismatch'"],
    ['$uiCurrent.IsOffscreen', "return 'offscreen'"],
    ['-not $uiCurrent.IsEnabled', "return 'disabled'"],
  ];
  const setValue = fallback.indexOf('$valuePattern.SetValue($ExpectedValue)');
  assert.ok(setValue >= 0);
  for (const [guard, result] of guards) {
    const guardAt = fallback.indexOf(guard);
    const resultAt = fallback.indexOf(result, guardAt);
    assert.ok(guardAt >= 0 && resultAt > guardAt && resultAt < setValue,
      'the exact UIA property has its own fail-closed outcome: ' + result);
  }
});

test('NSIS UIA fallback outcomes use safe, producer-mapped enums', async () => {
  const statuses = ['element-unavailable', 'owner-mismatch', 'handle-mismatch', 'offscreen', 'disabled', 'control-mismatch', 'read-only', 'set-error', 'postset-mismatch', 'unknown'];
  const events = ['TUS_NSIS_WIZARD event=destination-set-uia-fallback pid=4321', ...statuses.map(status => 'TUS_NSIS_WIZARD event=destination-uia-' + status + ' pid=4321')];
  assert.deepEqual(
    safeNsisWizardEvents([...events, ...events.map(line => line + ' value=C:/private/path')].join(String.fromCharCode(10))),
    events,
  );
  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const writerStart = source.indexOf('function Write-WizardEvent {');
  const writerEnd = source.indexOf(String.fromCharCode(10) + 'trap {', writerStart);
  const validateSet = source.slice(writerStart, writerEnd).match(/\[ValidateSet\(([\s\S]*?)\)\]/)?.[1] ?? '';
  const callStart = source.indexOf('$uiaFallbackEvent = switch ($nativeEdit.UiaFallbackStatus)');
  const callEnd = source.indexOf('if ($uiaFallbackEvent)', callStart);
  const mapping = source.slice(callStart, callEnd);
  for (const status of statuses) {
    const event = 'destination-uia-' + status;
    assert.ok(mapping.includes("'" + status + "' { '" + event + "' }"), status + ' maps to a fixed producer event');
    assert.ok(validateSet.includes("'" + event + "'"), event + ' is accepted by the writer');
  }
});


test('NSIS UIA ValuePattern failures stay distinct, mapped, and private', async () => {
  const statuses = ['pattern-unavailable', 'value-state-unavailable'];
  const safe = statuses.map(status => 'TUS_NSIS_WIZARD event=destination-uia-' + status + ' pid=4321');
  const output = [...safe, ...safe.map(line => line + ' value=C:/private/path'), 'raw UIA error /private/user'].join(String.fromCharCode(10));
  assert.deepEqual(safeNsisWizardEvents(output), safe);
  assert.equal(JSON.stringify(safeNsisWizardEvents(output)).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const start = script.indexOf('function Set-NativeDirectoryEditWithUIA {');
  const end = script.indexOf(String.fromCharCode(10) + 'function Set-NativeDirectoryEdit {', start);
  const fallback = script.slice(start, end);
  assert.ok(fallback.includes("catch { return 'pattern-unavailable' }"));
  assert.ok(fallback.includes("catch { return 'value-state-unavailable' }"));

  const callStart = script.indexOf('$uiaFallbackEvent = switch ($nativeEdit.UiaFallbackStatus)');
  const callEnd = script.indexOf('if ($uiaFallbackEvent)', callStart);
  const mapping = script.slice(callStart, callEnd);
  const writerStart = script.indexOf('function Write-WizardEvent {');
  const writerEnd = script.indexOf(String.fromCharCode(10) + 'trap {', writerStart);
  const validateSet = script.slice(writerStart, writerEnd).split('[ValidateSet(')[1]?.split(')]')[0] ?? '';
  for (const status of statuses) {
    const event = 'destination-uia-' + status;
    assert.ok(mapping.includes("'" + status + "' { '" + event + "' }"), status + ' maps to its fixed event');
    assert.ok(validateSet.includes("'" + event + "'"), event + ' is accepted by the writer');
  }
});

test('Windows relaunch failure cleanup stops only the exact verified Setup path', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tus-setup-cleanup-'));
  const exactPath = path.join(root, 'TheUnfinishedShapes-0.1.0-rc.11-Setup-x64.exe');
  const otherPath = path.join(root, 'other.exe');
  const systemCommand = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  await Promise.all([copyFile(systemCommand, exactPath), copyFile(systemCommand, otherPath)]);

  const start = executablePath => spawn(executablePath, ['/c', 'ping -t 127.0.0.1 >NUL'], { windowsHide: true, stdio: 'ignore' });
  let exact, other;
  const stop = async child => {
    if (!child?.pid || child.exitCode !== null) return;
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }).catch(() => {});
    await waitForExit(child, 5000).catch(() => {});
  };
  t.after(async () => {
    await stop(exact);
    await stop(other);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  exact = start(exactPath);
  other = start(otherPath);
  await Promise.all([once(exact, 'spawn'), once(other, 'spawn')]);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(exact.exitCode, null, 'the exact-path process fixture remains active');
  assert.equal(other.exitCode, null, 'the unrelated-path process fixture remains active');

  let result;
  try {
    result = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows-nsis-wizard.ps1',
      '-InstallerPath', exactPath,
      '-ExpectedInstallDir', path.join(root, 'install'),
      '-CleanupOnly',
    ], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
  } catch {
    assert.equal(exact.exitCode, null, 'the exact-path process remains active if cleanup is unavailable');
    throw new Error('exact-path installer cleanup did not stop the matched process');
  }

  const event = `TUS_NSIS_WIZARD event=cleanup-stopped pid=${exact.pid}`;
  assert.deepEqual(safeNsisWizardEvents(result.stdout), [event]);
  assert.equal(result.stdout.includes(exactPath), false, 'cleanup output does not expose the verified path');
  assert.equal(result.stdout.includes(otherPath), false, 'cleanup output does not expose unrelated paths');
  await waitForExit(exact, 5000);
  assert.equal(other.exitCode, null, 'cleanup leaves a different executable path untouched');
});


test('NSIS readback classifies unrooted text before normalization without exposing it', async () => {
  const safe = [
    'TUS_NSIS_WIZARD event=destination-before-read-not-rooted pid=4321',
    'TUS_NSIS_WIZARD event=destination-readback-not-rooted pid=4321',
  ];
  const events = safeNsisWizardEvents([
    ...safe,
    ...safe.map(line => line + ' value=C:/private/path'),
    'raw destination /private/user',
  ].join(String.fromCharCode(10)));
  assert.deepEqual(events, safe);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const setterStart = script.indexOf('function Set-NativeDirectoryEdit');
  const setterEnd = script.indexOf(String.fromCharCode(10) + 'function Get-NativeRadioSelection', setterStart);
  const setter = script.slice(setterStart, setterEnd);
  const beforeReadAt = setter.indexOf('$beforeValue = Get-NativeDirectoryEditText -Control $control');
  const beforeRootedAt = setter.indexOf('$beforeValueRooted = [System.IO.Path]::IsPathRooted($beforeValue)', beforeReadAt);
  const beforeFullPathAt = setter.indexOf('GetFullPath($beforeValue)', beforeReadAt);
  assert.ok(beforeReadAt >= 0 && beforeRootedAt > beforeReadAt && beforeFullPathAt > beforeRootedAt);
  assert.ok(setter.includes("$beforeReadClass = 'not-rooted'"));

  let readbackAt = 0;
  let readbackSites = 0;
  while ((readbackAt = setter.indexOf('$value = Get-NativeDirectoryEditText -Control $control', readbackAt)) >= 0) {
    const rootedAt = setter.indexOf('$valueIsRooted = [System.IO.Path]::IsPathRooted($value)', readbackAt);
    const fullPathAt = setter.indexOf('GetFullPath($value)', readbackAt);
    assert.ok(rootedAt > readbackAt && fullPathAt > rootedAt, 'each post-set read checks the original text before normalization');
    readbackSites++;
    readbackAt += 10;
  }
  assert.equal(readbackSites, 2);
  assert.ok(setter.includes("$result.MismatchClass = 'not-rooted'"));

  const directoryStart = script.indexOf("if ($stage -eq 'directory') {");
  const installStart = script.indexOf("if ($stage -eq 'installing') {", directoryStart);
  const directory = script.slice(directoryStart, installStart);
  assert.ok(directory.includes("'not-rooted' { 'destination-before-read-not-rooted' }"));
  assert.ok(directory.includes("'not-rooted' { 'destination-readback-not-rooted' }"));

  const writerStart = script.indexOf('function Write-WizardEvent {');
  const writerEnd = script.indexOf(String.fromCharCode(10) + 'trap {', writerStart);
  const validateSet = script.slice(writerStart, writerEnd).split('[ValidateSet(')[1]?.split(')]')[0] ?? '';
  for (const line of safe) assert.ok(validateSet.includes("'" + line.match(/event=([a-z-]+)/)[1] + "'"));
});




test('NSIS mode path events keep only bounded UIA, native, and unknown markers', () => {
  const safeLines = [
    'TUS_NSIS_WIZARD event=install-mode-path-uia pid=4321',
    'TUS_NSIS_WIZARD event=install-mode-path-native pid=4321',
    'TUS_NSIS_WIZARD event=install-mode-path-unknown pid=4321',
  ];
  const output = [
    ...safeLines,
    ...safeLines.map((line) => line + ' caption=C:/private/account'),
    'raw NSIS caption C:/private/account',
  ].join(String.fromCharCode(10));

  assert.deepEqual(safeNsisWizardEvents(output), safeLines);
  assert.equal(JSON.stringify(safeNsisWizardEvents(output)).includes('C:/private'), false);
});

test('NSIS InstallFiles and Finish pages require pinned native signatures', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const scenarioSource = await readFile(new URL('../scripts/windows-updater-scenarios.mjs', import.meta.url), 'utf8');
  const pageReader = script.slice(script.indexOf('function Get-NsisPageSummary'), script.indexOf('function Get-Win32WindowSummary'));
  const loopStart = script.indexOf('$script:mainWindowHandle = $handle');
  const finishStart = script.indexOf('$finish = @(', loopStart);
  const snapshotStart = script.indexOf('$snapshot = [ordered]@{', finishStart);
  const uiaLoop = script.slice(finishStart, snapshotStart);
  assert.ok(loopStart >= 0 && finishStart > loopStart && snapshotStart > finishStart);
  const snapshotWriter = script.slice(script.indexOf('function Write-WizardSnapshot'), script.indexOf('function Write-WizardStateSnapshot'));
  const stateWriter = script.slice(script.indexOf('function Write-WizardStateSnapshot'), script.indexOf('function Write-WizardEvent'));

  assert.ok(pageReader.includes("Get-NativeControlStatus -Window $pageHandle -ControlId 1006 -ExpectedClass 'Static'"));
  assert.ok(pageReader.includes("Get-NativeControlStatus -Window $pageHandle -ControlId 1004 -ExpectedClass 'msctls_progress32'"));
  assert.ok(pageReader.includes("$result.NativePage = 'install-files'"));
  assert.ok(pageReader.includes("$result.NativePage = 'finish'"));
  assert.ok(pageReader.includes('$pageControlsCount -eq 3') && pageReader.includes('$pageStaticCount -eq 3'),
    'the pinned no-reboot Finish page has only its bitmap, title, and text statics');
  assert.ok(pageReader.includes('$pageButtonsCount -eq 0') && pageReader.includes('$pageEditsCount -eq 0') &&
    pageReader.includes('$pageProgressCount -eq 0') && pageReader.includes('$pageOtherCount -eq 0'),
    'Finish does not accept a generic child page layout');
  assert.ok(uiaLoop.includes("$nativeWindow.NativePage -eq 'install-files'"),
    'UIA progress alone does not identify the pinned InstallFiles page');
  assert.ok(uiaLoop.includes("$nativeWindow.NativePage -eq 'finish'"),
    'a generic Finish-named control alone does not identify the pinned Finish page');
  assert.ok(uiaLoop.includes('$finishButtonHandle -eq $finishNext.Handle'),
    'the Finish action maps to NSIS main-button ID 1 on the matched Setup window');
  assert.ok(snapshotWriter.includes('native-page=$NativePage') && snapshotWriter.includes('uia-page=$UiaPage'),
    'the producer writes the fixed page enums into the snapshot');
  assert.ok(stateWriter.includes('-NativePage $WindowSummary.NativePage') && stateWriter.includes('-UiaPage $Snapshot.UiPage'),
    'the timeout snapshot maps actual producer fields rather than synthetic page values');
  assert.ok(scenarioSource.includes('native-page=(directory|install-files|finish|other|unknown)'),
    'the sanitizer accepts the fixed Finish enum');
});

test('NSIS native-only Finish fallback requires pinned ID1 after destination verification', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const helperStart = script.indexOf('function Get-NativeFinishControl');
  const helperEnd = script.indexOf('function Get-NsisPageSummary', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'native Finish control reader is present');
  const helper = script.slice(helperStart, helperEnd);
  assert.ok(helper.includes('Get-MuiNextControl'));
  assert.ok(helper.includes('GetWindowText'));
  assert.ok(helper.includes("'&Finish'") || helper.includes("'Finish'"));
  assert.ok(helper.includes('GetParent') && helper.includes('ProcessId'));

  const finishStart = script.indexOf("if ($stage -eq 'installing') {");
  const finishEnd = script.indexOf("\n  Start-Sleep -Milliseconds 100", finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart, 'installing branch is bounded');
  const finishFlow = script.slice(finishStart, finishEnd);
  assert.ok(finishFlow.includes("$finish.Count -eq 0"), 'native fallback applies only when UIA has no Finish button');
  assert.ok(finishFlow.includes("$nativeWindow.NativePage -eq 'finish'"));
  assert.ok(finishFlow.includes('$destinationVerified') && finishFlow.includes("$destinationStatus -eq 'match'"));
  assert.ok(finishFlow.includes('Get-NativeFinishControl'));
  assert.ok(finishFlow.includes('0x00F5'), 'native action is limited to the verified NSIS ID1 button');
});
 
test('NSIS install mode identifies AllUsers and checks radio visibility before native Next', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const modeStart = script.indexOf("if ($nativeWindow.OptionPage -eq 'install-options') {");
  const modeEnd = script.indexOf("if ($modeStatus -eq 'unknown')", modeStart);
  const nativeMode = script.slice(modeStart, modeEnd);

  assert.ok(script.includes('Anyone who uses this computer (&all users)'),
    'AllUsers is matched to the pinned English preset, not any nonempty caption');
  assert.ok(script.includes('Anyone who uses this computer (&all users) (must run as admin)'),
    'the pinned disabled preset remains identifiable');
  assert.equal(script.includes('$otherRadio.Caption.Length -gt 0'), false);
  assert.ok(script.includes('[TUSWindowApi]::IsWindowVisible($Handle)'),
    'the bounded native radio reader rejects hidden controls');
  assert.ok(script.includes('CurrentUserEnabled') && script.includes('AllUsersVisible'),
    'native mode requires a visible pair and an enabled CurrentUser radio');
  for (const source of ['install-mode-path-uia', 'install-mode-path-native', 'install-mode-path-unknown']) {
    assert.ok(script.includes("Write-WizardEvent -Name '" + source + "'"), source + ' is emitted by the producer');
  }
  assert.ok(nativeMode.includes("$nativeWindow.AllUsersPreset -ne 'match'"));
  assert.ok(nativeMode.includes("$nativeWindow.AllUsersSelected -ne 'unselected'"));
  assert.ok(nativeMode.includes("$nativeWindow.CurrentUserPreset -ne 'match'"));
  assert.ok(nativeMode.includes("$nativeWindow.CurrentUserSelected -ne 'selected'"));
  assert.ok(nativeMode.indexOf("$nativeWindow.AllUsersPreset -ne 'match'") < nativeMode.indexOf('SendMessageTimeout($nextControl.Handle, 0x00F5'),
    'unknown or noncanonical mode evidence cannot advance native Next');
  assert.ok(script.includes("'install-mode-path-unknown'"), 'unrecognized path has a bounded safe category');
});

test('NSIS directory setter checks exact native readback after WM_SETTEXT rejection before UIA fallback', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const setterStart = script.indexOf('function Set-NativeDirectoryEdit {');
  const setterEnd = script.indexOf(String.fromCharCode(10) + 'function Get-NativeRadioSelection', setterStart);
  assert.ok(setterStart >= 0 && setterEnd > setterStart);
  const setter = script.slice(setterStart, setterEnd);

  const writeAt = setter.indexOf('SendMessageTimeout($control, 0x000C');
  const rejectionAt = setter.indexOf('if ($setSent -eq [IntPtr]::Zero -or $setResult.ToInt64() -eq 0)', writeAt);
  const failedWriteReadbackAt = setter.indexOf('$afterSetValue = Get-NativeDirectoryEditText -Control $control', rejectionAt);
  const uiFallbackAt = setter.indexOf('Set-NativeDirectoryEditWithUIA', rejectionAt);
  assert.ok(writeAt >= 0 && rejectionAt > writeAt && failedWriteReadbackAt > rejectionAt && uiFallbackAt > failedWriteReadbackAt,
    'a rejected native set is read back before using UIA or failing the directory step');
  assert.ok(setter.includes('$afterSetValueIsRooted') && setter.includes('$normalizedAfterSetValue'),
    'the fallback accepts only a rooted path normalized against the exact expected destination');
  assert.ok(setter.includes("$result.SetMethod = 'readback'"),
    'an exact native readback is distinguished from a successful WM_SETTEXT result');
  assert.equal(setter.includes('$alreadyMatchesExpected'), false,
    'the preselected path still receives the native set notification that refreshes the NSIS page');

  const finalReadbackAt = setter.indexOf('$value = Get-NativeDirectoryEditText -Control $control', failedWriteReadbackAt);
  assert.ok(finalReadbackAt > failedWriteReadbackAt,
    'the normal final native readback remains after control provenance checks');
});

test('NSIS directory-set result enums are sanitized and mapped from the native producer', async () => {
  const safe = [
    'TUS_NSIS_WIZARD event=destination-set-dispatch-failed pid=4321',
    'TUS_NSIS_WIZARD event=destination-set-message-rejected pid=4321',
  ];
  const output = [
    ...safe,
    ...safe.map(line => line + ' value=C:/private/path detail=raw error'),
    'TUS_NSIS_WIZARD event=destination-set-message-rejected-extra pid=4321',
    'raw setter error C:/private/path',
  ].join(String.fromCharCode(10));
  const events = safeNsisWizardEvents(output);
  assert.deepEqual(events, safe);
  assert.equal(JSON.stringify(events).includes('C:/private/path'), false);
  assert.equal(JSON.stringify(events).includes('raw error'), false);

  const source = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const setterStart = source.indexOf('function Set-NativeDirectoryEdit {');
  const setterEnd = source.indexOf(String.fromCharCode(10) + 'function Get-NativeRadioSelection', setterStart);
  const setter = source.slice(setterStart, setterEnd);
  const dispatchAt = setter.indexOf("$result.SetMessageOutcome = 'dispatch-failed'");
  const rejectedAt = setter.indexOf("$result.SetMessageOutcome = 'message-rejected'");
  const acceptedAt = setter.indexOf("$result.SetMessageOutcome = 'accepted'");
  assert.ok(dispatchAt >= 0 && rejectedAt > dispatchAt && acceptedAt > rejectedAt);
  assert.ok(setter.slice(0, dispatchAt).includes('if ($setSent -eq [IntPtr]::Zero)'));
  assert.ok(setter.slice(dispatchAt, rejectedAt).includes('elseif ($setResult.ToInt64() -eq 0)'));

  const dispatchMapping = source.indexOf("'dispatch-failed' { 'destination-set-dispatch-failed' }");
  const rejectedMapping = source.indexOf("'message-rejected' { 'destination-set-message-rejected' }");
  const emitted = source.indexOf('Write-WizardEvent -Name $messageOutcomeEvent');
  assert.ok(dispatchMapping >= 0 && rejectedMapping > dispatchMapping && emitted > rejectedMapping);
});
