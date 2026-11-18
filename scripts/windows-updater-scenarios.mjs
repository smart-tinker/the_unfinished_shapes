const safeWizardEvents = new Set([
  'process-found', 'process-ambiguous', 'process-not-found',
  'window-found', 'window-not-found', 'window-mismatch',
  'welcome-advanced', 'destination-entered', 'destination-verified', 'destination-unavailable', 'destination-mismatch',
  'next-unavailable', 'install-started',
  'finish-clicked', 'installer-exited',
  'installer-exited-early', 'installed-executable-missing', 'completed',
  'timeout', 'uia-unavailable', 'automation-failed',
]);

export function safeNsisWizardEvents(output) {
  return String(output ?? '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^TUS_NSIS_WIZARD event=([a-z-]+)(?: pid=(\d+))?$/);
    if (!match || !safeWizardEvents.has(match[1])) return [];
    return [`TUS_NSIS_WIZARD event=${match[1]}${match[2] ? ' pid=' + match[2] : ''}`];
  });
}

export async function runWindowsUpdaterScenarios({ portable, installer }) {
  const outcomes = {};
  for (const [name, run] of [['portable', portable], ['installer', installer]]) {
    try {
      outcomes[name] = { status: 'fulfilled', value: await run() };
    } catch (error) {
      outcomes[name] = { status: 'rejected', error };
    }
  }
  return outcomes;
}
