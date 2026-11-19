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
const safeHandoffChecks = new Set(['build-label', 'build-title-sha', 'app-version', 'user-data', 'startup-health', 'other']);
const safeHandoffCheckResults = new Set(['match', 'mismatch', 'failed']);
const safeScenarioStages = new Set([
  'source-setup', 'source-identity', 'source-prepare', 'check-download',
  'extract', 'relaunch', 'wizard', 'target-verify', 'complete',
]);
const safeScenarioCategories = new Set([
  'none', 'assertion', 'timeout', 'filesystem', 'process-exit',
  'rate_limited', 'http_error', 'invalid_response', 'check_failed', 'provenance', 'uia',
  'build-label', 'build-title-sha', 'app-version', 'user-data', 'startup-health', 'other',
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
    const stage = line.match(/^TUS_INSTALLER_HANDOFF stage=([a-z-]+)$/);
    if (stage && safeHandoffStages.has(stage[1])) return ['TUS_INSTALLER_HANDOFF stage=' + stage[1]];
    const check = line.match(/^TUS_INSTALLER_HANDOFF check=([a-z-]+):(match|mismatch|failed)$/);
    if (check && safeHandoffChecks.has(check[1]) && safeHandoffCheckResults.has(check[2])) {
      return ['TUS_INSTALLER_HANDOFF check=' + check[1] + ':' + check[2]];
    }
    return [];
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
