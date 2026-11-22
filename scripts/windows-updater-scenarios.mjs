import path from 'node:path';
import { safeUpdaterFailureCode } from '../src/update-package.mjs';

const safeWizardEvents = new Set([
  'process-found', 'process-ambiguous', 'process-not-found',
  'window-found', 'window-not-found', 'window-mismatch',
  'install-mode-verified', 'install-mode-unavailable', 'directory-advanced', 'destination-entered', 'destination-postset-edit-match', 'destination-postset-edit-mismatch', 'destination-postset-edit-unknown', 'destination-verified', 'destination-unavailable', 'destination-mismatch', 'destination-edits-ambiguous',
  'destination-set-precondition-unavailable', 'destination-set-provenance-unavailable', 'destination-set-control-unavailable', 'destination-set-message-failed', 'destination-set-uia-fallback', 'destination-set-exception', 'destination-set-unknown',
  'destination-uia-element-unavailable', 'destination-uia-owner-mismatch', 'destination-uia-handle-mismatch', 'destination-uia-pattern-unavailable', 'destination-uia-value-state-unavailable', 'destination-uia-offscreen', 'destination-uia-disabled', 'destination-uia-control-mismatch', 'destination-uia-read-only', 'destination-uia-set-error', 'destination-uia-postset-mismatch', 'destination-uia-unknown',
  'destination-readback-product-leaf-appended', 'destination-readback-same-parent', 'destination-readback-same-leaf', 'destination-readback-same-root', 'destination-readback-different-root', 'destination-readback-not-rooted', 'destination-readback-other', 'destination-readback-unchanged', 'destination-before-read-unavailable', 'destination-before-read-empty', 'destination-before-read-invalid', 'destination-before-read-not-rooted',
  'next-unavailable', 'install-started',
  'finish-clicked', 'installer-exited',
  'installer-exited-early', 'installed-executable-missing', 'completed',
  'timeout', 'uia-unavailable', 'automation-failed',
  'cleanup-not-found', 'cleanup-ambiguous', 'cleanup-stopped', 'cleanup-failed',
]);
const safeHandoffStages = new Set([
  'source-setup-started', 'source-setup-complete', 'source-identity-verified', 'source-fixture-verified',
  'target-identity-verified', 'target-fixture-verified',
]);
const safeHandoffChecks = new Set(['build-label', 'build-title-sha', 'app-version', 'user-data', 'startup-health', 'relaunch-request', 'other']);
const safeHandoffCheckResults = new Set(['match', 'mismatch', 'failed']);
const safeScenarioStages = new Set([
  'source-setup', 'source-identity', 'source-prepare', 'check-download',
  'extract', 'relaunch', 'relaunch-cancel', 'relaunch-approve', 'relaunch-exit',
  'relaunch-click', 'relaunch-source-exit', 'relaunch-cleanup',
  'relaunch-prompt', 'relaunch-request', 'relaunch-target', 'wizard', 'target-verify', 'complete',
]);
const safeScenarioCategories = new Set([
  'none', 'assertion', 'timeout', 'filesystem', 'process-exit',
  'rate_limited', 'http_error', 'invalid_response', 'check_failed', 'provenance', 'uia',
  'build-label', 'build-title-sha', 'app-version', 'user-data', 'startup-health', 'other',
]);

const safeWizardSnapshotPattern = /^TUS_NSIS_WIZARD snapshot stage=(entry|install-mode|directory|installing|finish|unknown) process=path-match window=pid-match page-window=(present|missing|ambiguous|unknown) page-parent=(match|mismatch|unknown) page-process=(match|mismatch|unknown) page-visible=(visible|hidden|unknown) page-class=(native-dialog|other|unknown) option-page=(install-options|other|unknown) option-radio-count=(none|one|two|many|unknown) option-radio-style=(match|mismatch|unknown) current-user-preset=(match|mismatch|unknown) all-users-preset=(match|mismatch|unknown) current-user-selected=(selected|unselected|unknown) all-users-selected=(selected|unselected|unknown) option-next=(match|missing|disabled|hidden|wrong-class|owner-mismatch|unknown) title=(product-match|product-missing|unknown) mode=(present|absent|unknown) current-user=(selected|unselected|unknown) radios=(none|one|two|many) edits=(none|one|many) next=(match|missing) install=(match|missing) finish=(match|missing) destination=(match|mismatch|unknown) native-page=(directory|install-files|other|unknown) uia-page=(install-mode|directory|install-files|finish|other|unknown) directory-edit=(match|missing|wrong-class|unknown) directory-browse=(match|missing|wrong-class|unknown) directory-text=(match|missing|wrong-class|unknown) install-progress=(match|missing|wrong-class|unknown) uia-top-level=(none|one|two|many|unknown) main-window=(present|absent|unknown) wizard-window=(main|other|ambiguous|none|unknown) foreground=(installer|other|none|unknown) window-class=(native-dialog|other|unknown) native-title=(error-like|other|empty|unknown) uia-provider=(empty|available|error|unknown) uia-descendants=(none|one|two|many|unknown) win32-children=(none|one|two|many|unknown) win32-buttons=(none|one|two|many|unknown) win32-static=(none|one|two|many|unknown) session=(match|mismatch|unknown) desktop=(default-interactive|other|unknown) visible=(visible|hidden|unknown) pid=(\d{1,10})$/;

export function windowsRelaunchRequestStatus(marker, expectedInstallerPath) {
  let options;
  try { options = JSON.parse(marker); } catch { return 'failed'; }
  if (!options || typeof options !== 'object' ||
      typeof options.execPath !== 'string' ||
      typeof expectedInstallerPath !== 'string' ||
      !Array.isArray(options.args)) return 'failed';
  try {
    const exactPath = path.win32.resolve(options.execPath).toLowerCase() ===
      path.win32.resolve(expectedInstallerPath).toLowerCase();
    return exactPath && options.args.length === 0 ? 'match' : 'mismatch';
  } catch { return 'failed'; }
}

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
      ' process=path-match window=pid-match page-window=' + snapshot[2] + ' page-parent=' + snapshot[3] +
      ' page-process=' + snapshot[4] + ' page-visible=' + snapshot[5] + ' page-class=' + snapshot[6] +
      ' option-page=' + snapshot[7] + ' option-radio-count=' + snapshot[8] +
      ' option-radio-style=' + snapshot[9] + ' current-user-preset=' + snapshot[10] +
      ' all-users-preset=' + snapshot[11] + ' current-user-selected=' + snapshot[12] +
      ' all-users-selected=' + snapshot[13] + ' option-next=' + snapshot[14] + ' title=' + snapshot[15] +
      ' mode=' + snapshot[16] + ' current-user=' + snapshot[17] +
      ' radios=' + snapshot[18] + ' edits=' + snapshot[19] +
      ' next=' + snapshot[20] + ' install=' + snapshot[21] +
      ' finish=' + snapshot[22] + ' destination=' + snapshot[23] +
      ' native-page=' + snapshot[24] + ' uia-page=' + snapshot[25] +
      ' directory-edit=' + snapshot[26] + ' directory-browse=' + snapshot[27] +
      ' directory-text=' + snapshot[28] + ' install-progress=' + snapshot[29] +
      ' uia-top-level=' + snapshot[30] + ' main-window=' + snapshot[31] + ' wizard-window=' + snapshot[32] +
      ' foreground=' + snapshot[33] + ' window-class=' + snapshot[34] + ' native-title=' + snapshot[35] +
      ' uia-provider=' + snapshot[36] + ' uia-descendants=' + snapshot[37] +
      ' win32-children=' + snapshot[38] + ' win32-buttons=' + snapshot[39] + ' win32-static=' + snapshot[40] +
      ' session=' + snapshot[41] + ' desktop=' + snapshot[42] + ' visible=' + snapshot[43] +
      ' pid=' + snapshot[44],
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

export function safeWindowsScenarioFailureCategory(error) {
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'ERR_SCRIPT_EXECUTION_TIMEOUT'].includes(error?.code)) return 'timeout';
  const childOutput = String(error?.stdout || '') + String(error?.stderr || '');
  if (error?.code === 'ERR_ASSERTION' || childOutput.includes('AssertionError [ERR_ASSERTION]')) return 'assertion';
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO'].includes(error?.code)) return 'filesystem';
  if (['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed'].includes(error?.code)) return error.code;
  const failureCode = safeUpdaterFailureCode(error?.failureCode);
  if (['rate_limited', 'http_error', 'invalid_response', 'timeout', 'check_failed'].includes(failureCode)) return failureCode;
  if (failureCode === 'SIGNATURE_REJECTED') return 'provenance';
  if (Number.isInteger(error?.code)) return 'process-exit';
  return 'other';
}

export async function runWindowsRelaunch({ child, click, waitForExit, cleanup, validateRequest }) {
  let order = 0;
  const capture = (stage, operation) => Promise.resolve().then(operation).then(() => null, error => {
    const failure = error instanceof Error ? error : new Error('Windows updater relaunch failed.');
    failure.tusScenarioDiagnostic = { stage, category: safeWindowsScenarioFailureCategory(failure) };
    return { order: order++, error: failure };
  });
  const [clickFailure, exitFailure] = await Promise.all([
    capture('relaunch-click', click),
    capture('relaunch-source-exit', () => waitForExit(child)),
  ]);
  const failures = [clickFailure, exitFailure].filter(Boolean);
  if (validateRequest) {
    const requestFailure = await capture('relaunch-request', validateRequest);
    if (requestFailure) failures.push(requestFailure);
  }
  failures.sort((left, right) => left.order - right.order);
  const primary = failures[0]?.error;
  let cleanupFailure = null;
  try { await cleanup(child, primary); } catch (error) {
    const failure = error instanceof Error ? error : new Error('Windows updater cleanup failed.');
    failure.tusScenarioDiagnostic = { stage: 'relaunch-cleanup', category: safeWindowsScenarioFailureCategory(failure) };
    cleanupFailure = failure;
  }
  if (primary && cleanupFailure) {
    const combined = new AggregateError([primary, cleanupFailure], 'Windows updater relaunch and cleanup failed', { cause: primary });
    combined.tusScenarioDiagnostic = primary.tusScenarioDiagnostic;
    throw combined;
  }
  if (primary) throw primary;
  if (cleanupFailure) throw cleanupFailure;
}

function safeScenarioDiagnostic(error) {
  const diagnostic = error?.tusScenarioDiagnostic;
  return {
    stage: safeScenarioStages.has(diagnostic?.stage) ? diagnostic.stage : 'unknown',
    category: safeScenarioCategories.has(diagnostic?.category) ? diagnostic.category : 'other',
  };
}

export async function runWindowsUpdaterScenarios({ portable, installer, cleanupInstaller }) {
  const outcomes = {};
  for (const [name, run] of [['portable', portable], ['installer', installer]]) {
    try {
      outcomes[name] = { status: 'fulfilled', value: await run(), diagnostic: { stage: 'complete', category: 'none' } };
    } catch (error) {
      if (name === 'installer' && cleanupInstaller) await cleanupInstaller(error);
      outcomes[name] = { status: 'rejected', error, diagnostic: safeScenarioDiagnostic(error) };
    }
  }
  return outcomes;
}
