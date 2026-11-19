import path from 'node:path';

const safeWizardEvents = new Set([
  'process-found', 'process-ambiguous', 'process-not-found',
  'window-found', 'window-not-found', 'window-mismatch',
  'install-mode-verified', 'install-mode-unavailable', 'directory-advanced', 'destination-entered', 'destination-verified', 'destination-unavailable', 'destination-mismatch',
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

const safeWizardSnapshotPattern = /^TUS_NSIS_WIZARD snapshot stage=(entry|install-mode|directory|installing|finish|unknown) process=path-match window=pid-match title=(product-match|product-missing|unknown) mode=(present|absent|unknown) current-user=(selected|unselected|unknown) radios=(none|one|two|many) edits=(none|one|many) next=(match|missing) install=(match|missing) finish=(match|missing) destination=(match|mismatch|unknown) uia-top-level=(none|one|two|many|unknown) main-window=(present|absent|unknown) wizard-window=(main|other|ambiguous|none|unknown) foreground=(installer|other|none|unknown) window-class=(native-dialog|other|unknown) native-title=(error-like|other|empty|unknown) uia-provider=(empty|available|error|unknown) uia-descendants=(none|one|two|many|unknown) win32-children=(none|one|two|many|unknown) win32-buttons=(none|one|two|many|unknown) win32-static=(none|one|two|many|unknown) session=(match|mismatch|unknown) desktop=(default-interactive|other|unknown) visible=(visible|hidden|unknown) pid=(\d{1,10})$/;

export function windowsInstallerHandoffInstallDir(localData) {
  return path.join(localData, 'Programs', 'TheUnfinishedShapes');
}

export function safeNsisWizardEvents(output) {
  return String(output ?? '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^TUS_NSIS_WIZARD event=([a-z-]+)(?: pid=(\d+))?$/);
    if (match && safeWizardEvents.has(match[1])) {
      return ['TUS_NSIS_WIZARD event=' + match[1] + (match[2] ? ' pid=' + match[2] : '')];
    }
    const snapshot = line.match(safeWizardSnapshotPattern);
    if (!snapshot) return [];
    return [
      'TUS_NSIS_WIZARD snapshot stage=' + snapshot[1] +
      ' process=path-match window=pid-match title=' + snapshot[2] +
      ' mode=' + snapshot[3] + ' current-user=' + snapshot[4] +
      ' radios=' + snapshot[5] + ' edits=' + snapshot[6] +
      ' next=' + snapshot[7] + ' install=' + snapshot[8] +
      ' finish=' + snapshot[9] + ' destination=' + snapshot[10] +
      ' uia-top-level=' + snapshot[11] + ' main-window=' + snapshot[12] + ' wizard-window=' + snapshot[13] +
      ' foreground=' + snapshot[14] + ' window-class=' + snapshot[15] + ' native-title=' + snapshot[16] +
      ' uia-provider=' + snapshot[17] + ' uia-descendants=' + snapshot[18] +
      ' win32-children=' + snapshot[19] + ' win32-buttons=' + snapshot[20] + ' win32-static=' + snapshot[21] +
      ' session=' + snapshot[22] + ' desktop=' + snapshot[23] + ' visible=' + snapshot[24] +
      ' pid=' + snapshot[25],
    ];
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
