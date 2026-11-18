import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWindowsUpdaterScenarios, safeNsisWizardEvents } from '../scripts/windows-updater-scenarios.mjs';

test('Windows installer acceptance still runs when portable acceptance fails', async () => {
  const calls = [];
  const portableFailure = new Error('portable acceptance failed');
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
  assert.deepEqual(outcomes.installer, { status: 'fulfilled', value: 'installed-source handoff' });
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
