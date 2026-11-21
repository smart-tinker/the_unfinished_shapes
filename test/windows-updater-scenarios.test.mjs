import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { runWindowsUpdaterScenarios, safeInstallerHandoffEvents, safeNsisWizardEvents } from '../scripts/windows-updater-scenarios.mjs';

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


test('NSIS wizard snapshot preserves bounded page facts without UIA names or paths', () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=install-mode process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-match mode=present current-user=selected radios=two edits=none next=match install=missing finish=missing destination=unknown native-page=unknown uia-page=install-mode directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=main foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=4321';
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
  const emptyMain = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const otherWizard = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=two main-window=present wizard-window=other foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const ambiguous = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=unknown mode=unknown current-user=unknown radios=many edits=one next=match install=missing finish=missing destination=unknown native-page=unknown uia-page=unknown directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=many main-window=present wizard-window=ambiguous foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const events = safeNsisWizardEvents([
    emptyMain,
    otherWizard,
    ambiguous,
    'TUS_NSIS_WIZARD snapshot stage=entry process=C:/private/path window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown uia-top-level=C:/private/path main-window=present wizard-window=other pid=9692',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [emptyMain, otherWizard, ambiguous]);
  assert.doesNotMatch(JSON.stringify(events), /C:\/private\/path/);
});

test('NSIS timeout snapshot classifies the exact HWND without exposing native text or names', async () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=4321';
  const unsafe = safe.replace('window-class=native-dialog', 'window-class=C:/private/window')
    .replace('native-title=error-like', 'native-title=C:/private/title')
    .replace('desktop=default-interactive', 'desktop=Default/user');
  const events = safeNsisWizardEvents([safe, unsafe, 'raw window title C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('GetForegroundWindow'));
  assert.ok(script.includes('GetWindowText'));
  assert.ok(script.includes('GetUserObjectInformation'));
  assert.ok(script.includes('foreground=$Foreground'));
  assert.ok(script.includes('uia-provider=$UiaProvider'));
});

test('NSIS timeout snapshot identifies pinned MUI page controls without exposing names', async () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=unknown page-parent=unknown page-process=unknown page-visible=unknown page-class=unknown option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=directory uia-page=other directory-edit=match directory-browse=match directory-text=match install-progress=missing uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=other uia-provider=available uia-descendants=many win32-children=many win32-buttons=many win32-static=many session=match desktop=default-interactive visible=visible pid=4321';
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
  assert.ok(script.indexOf('if ($null -eq $pageWindow)') < script.indexOf('$selection.Select()'));
  assert.ok(script.indexOf('if ($null -eq $pageWindow)') < script.indexOf('$valuePattern.SetValue($expectedInstallDir)'));
});

test('NSIS child-page snapshot requires visible parent and process provenance', () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match page-window=present page-parent=match page-process=match page-visible=visible page-class=native-dialog option-page=unknown option-radio-count=unknown option-radio-style=unknown current-user-preset=unknown all-users-preset=unknown current-user-selected=unknown all-users-selected=unknown option-next=unknown title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=directory uia-page=other directory-edit=match directory-browse=match directory-text=match install-progress=missing uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=other uia-provider=available uia-descendants=many win32-children=many win32-buttons=many win32-static=many session=match desktop=default-interactive visible=visible pid=4321';
  const unsafe = safe.replace('page-process=match', 'page-process=C:/private/process');
  const events = safeNsisWizardEvents([safe, unsafe, 'raw page HWND C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);
});

test('NSIS snapshot maps the production writer fields and rejects private option values', async () => {
  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  const template = script.match(/^\s*\[Console\]::Out\.WriteLine\("(TUS_NSIS_WIZARD snapshot [^"]+)"\)$/m)?.[1];
  assert.ok(template, 'snapshot test exercises the production PowerShell writer format');
  assert.equal(template.includes('option-next=$OptionNext'), true, 'the production writer maps the pinned native Next status');

  const values = new Map(Object.entries({
    Stage: 'entry', PageWindow: 'present', PageParent: 'match', PageProcess: 'match',
    PageVisible: 'visible', PageClass: 'native-dialog',
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
  ]) {
    const start = recognizedSchema.indexOf(field + '=') + field.length + 1;
    const end = recognizedSchema.indexOf(' ', start);
    const unsafe = recognizedSchema.slice(0, start) + 'C:/private/account' + recognizedSchema.slice(end);
    assert.deepEqual(safeNsisWizardEvents(unsafe), [], field + ' rejects raw captions and paths');
  }
  assert.deepEqual(safeNsisWizardEvents(recognizedSchema + ' caption=C:/private/account'), []);

  const pageReader = script.slice(script.indexOf('function Get-NsisPageSummary'), script.indexOf('function Get-Win32WindowSummary'));
  assert.ok(pageReader.includes('GetWindow($pageHandle, 5)'), 'radio controls are read from the verified child page');
  assert.ok(pageReader.includes('($_.Style -band 0x0f) -eq 9'), 'only the pinned auto-radio style is counted');
  assert.ok(pageReader.includes('Get-NativeRadioSelection'), 'selected state is read through the bounded native query');
  assert.equal(script.includes('option-page=$OptionPage'), true);
  assert.equal(script.includes('caption=$Caption'), false);
  const nextReader = script.slice(script.indexOf('function Get-OptionNextControl'), script.indexOf('function Get-NsisPageSummary'));
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
    'Get-OptionNextControl -ProcessId $script:installerProcessId -MainWindowHandle $script:mainWindowHandle',
    'SendMessageTimeout($nextControl.Handle, 0x00F5',
  ]) assert.ok(optionAction.includes(check), 'native Next action remains fail-closed: ' + check);
  assert.equal(script.includes('option-next=$OptionNext'), true);
  assert.equal(script.includes('caption=$Caption'), false);
});
