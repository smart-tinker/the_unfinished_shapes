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
  const safe = 'TUS_NSIS_WIZARD snapshot stage=install-mode process=path-match window=pid-match title=product-match mode=present current-user=selected radios=two edits=none next=match install=missing finish=missing destination=unknown native-page=unknown uia-page=install-mode directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=main foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=4321';
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
  const emptyMain = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const otherWizard = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=two main-window=present wizard-window=other foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const ambiguous = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=unknown mode=unknown current-user=unknown radios=many edits=one next=match install=missing finish=missing destination=unknown native-page=unknown uia-page=unknown directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=many main-window=present wizard-window=ambiguous foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=9692';
  const events = safeNsisWizardEvents([
    emptyMain,
    otherWizard,
    ambiguous,
    'TUS_NSIS_WIZARD snapshot stage=entry process=C:/private/path window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown uia-top-level=C:/private/path main-window=present wizard-window=other pid=9692',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [emptyMain, otherWizard, ambiguous]);
  assert.doesNotMatch(JSON.stringify(events), /C:\/private\/path/);
});

test('NSIS timeout snapshot classifies the exact HWND without exposing native text or names', async () => {
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=unknown uia-page=other directory-edit=unknown directory-browse=unknown directory-text=unknown install-progress=unknown uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=error-like uia-provider=empty uia-descendants=none win32-children=two win32-buttons=one win32-static=one session=match desktop=default-interactive visible=visible pid=4321';
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
  const safe = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown native-page=directory uia-page=other directory-edit=match directory-browse=match directory-text=match install-progress=missing uia-top-level=one main-window=present wizard-window=none foreground=installer window-class=native-dialog native-title=other uia-provider=available uia-descendants=many win32-children=many win32-buttons=many win32-static=many session=match desktop=default-interactive visible=visible pid=4321';
  const unsafe = safe.replace('directory-edit=match', 'directory-edit=C:/private/path');
  const events = safeNsisWizardEvents([safe, unsafe, 'raw native text C:/private/path'].join(String.fromCharCode(10)));

  assert.deepEqual(events, [safe]);
  assert.equal(JSON.stringify(events).includes('C:/private'), false);

  const script = await readFile(new URL('../scripts/windows-nsis-wizard.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('[TUSWindowApi]::GetDlgItem($Window, $ControlId)'));
  for (const controlId of ['1019', '1001', '1006', '1004']) assert.ok(script.includes('-ControlId ' + controlId));
  assert.ok(script.includes('[System.Windows.Automation.ControlType]::ProgressBar'));
  assert.ok(script.includes('native-page=$NativePage'));
});
