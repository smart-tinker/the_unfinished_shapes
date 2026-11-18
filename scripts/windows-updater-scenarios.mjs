const safeWizardEvents = new Set([
  'process-found', 'process-ambiguous', 'process-not-found',
  'window-found', 'window-not-found', 'window-mismatch',
  'welcome-advanced', 'destination-entered', 'destination-verified', 'destination-unavailable', 'destination-mismatch',
  'next-unavailable', 'install-started',
  'finish-clicked', 'installer-exited',
  'installer-exited-early', 'installed-executable-missing', 'completed',
  'timeout', 'uia-unavailable', 'automation-failed',
]);
const safeHandoffStages = new Set([
  'source-setup-started', 'source-setup-complete', 'source-identity-verified', 'source-fixture-verified',
  'target-identity-verified', 'target-fixture-verified',
]);
const safeScenarioStages = new Set([
  'source-setup', 'source-identity', 'source-prepare', 'check-download',
  'extract', 'relaunch', 'wizard', 'target-verify', 'complete',
]);
const safeScenarioCategories = new Set([
  'none', 'assertion', 'timeout', 'filesystem', 'process-exit',
  'rate_limited', 'http_error', 'invalid_response', 'check_failed', 'provenance', 'uia', 'other',
]);

export function safeNsisWizardEvents(output) {
  return String(output ?? '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^TUS_NSIS_WIZARD event=([a-z-]+)(?: pid=(\d+))?$/);
    if (!match || !safeWizardEvents.has(match[1])) return [];
    return ['TUS_NSIS_WIZARD event=' + match[1] + (match[2] ? ' pid=' + match[2] : '')];
  });
}

export function safeInstallerHandoffEvents(output) {
  return String(output ?? '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^TUS_INSTALLER_HANDOFF stage=([a-z-]+)$/);
    return match && safeHandoffStages.has(match[1]) ? ['TUS_INSTALLER_HANDOFF stage=' + match[1]] : [];
  });
}

function safeScenarioDiagnostic(error) {
  const diagnostic = error?.tusScenarioDiagnostic;
  return {
    stage: safeScenarioStages.has(diagnostic?.stage) ? diagnostic.stage : 'unknown',
    category: safeScenarioCategories.has(diagnostic?.category) ? diagnostic.category : 'other',
  };
}

export async function runWindowsUpdaterScenarios({ portable, installer }) {
  const outcomes = {};
  for (const [name, run] of [['portable', portable], ['installer', installer]]) {
    try {
      outcomes[name] = { status: 'fulfilled', value: await run(), diagnostic: { stage: 'complete', category: 'none' } };
    } catch (error) {
      outcomes[name] = { status: 'rejected', error, diagnostic: safeScenarioDiagnostic(error) };
    }
  }
  return outcomes;
}
