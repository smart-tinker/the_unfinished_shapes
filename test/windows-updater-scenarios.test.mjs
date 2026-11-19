import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
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
  const safe = 'TUS_NSIS_WIZARD snapshot stage=install-mode process=path-match window=pid-match title=product-match mode=present current-user=selected radios=two edits=none next=match install=missing finish=missing destination=unknown pid=4321';
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
  const emptyMain = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown uia-top-level=one main-window=present wizard-window=none pid=9692';
  const otherWizard = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown uia-top-level=two main-window=present wizard-window=other pid=9692';
  const ambiguous = 'TUS_NSIS_WIZARD snapshot stage=entry process=path-match window=pid-match title=unknown mode=unknown current-user=unknown radios=many edits=one next=match install=missing finish=missing destination=unknown uia-top-level=many main-window=present wizard-window=ambiguous pid=9692';
  const events = safeNsisWizardEvents([
    emptyMain,
    otherWizard,
    ambiguous,
    'TUS_NSIS_WIZARD snapshot stage=entry process=C:/private/path window=pid-match title=product-missing mode=absent current-user=unknown radios=none edits=none next=missing install=missing finish=missing destination=unknown uia-top-level=C:/private/path main-window=present wizard-window=other pid=9692',
  ].join(String.fromCharCode(10)));

  assert.deepEqual(events, [emptyMain, otherWizard, ambiguous]);
  assert.doesNotMatch(JSON.stringify(events), /C:\/private\/path/);
});
