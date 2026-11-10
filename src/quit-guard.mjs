export function isSmokeAutoConfirmQuit(env = process.env, argv = process.argv) {
  return env.CI === 'true' && argv.includes('--tus-smoke-confirm-quit');
}

export async function confirmQuitIfUnsafe(state, confirm) {
  const noConversation = state?.connected === false && state.threadId === null;
  const safe = noConversation || (state?.connected === true &&
    typeof state.goalSupported === 'boolean' &&
    state.thread?.status?.type === 'idle' &&
    state.turnId === null &&
    state.pendingApprovals === 0 &&
    state.goal === null);
  return safe || confirm(state);
}

export function installQuitGuard({ app, getWindow, readState, confirm, cleanup }) {
  let approved = false, prompting = false, cleaned = false;
  const requestQuit = event => {
    if (approved) return;
    event.preventDefault();
    if (prompting) return;
    prompting = true;
    void (async () => {
      try {
        let state = null;
        try { state = await readState(); } catch {}
        if (await confirmQuitIfUnsafe(state, confirm)) {
          approved = true;
          app.quit();
        }
      } catch {
        console.error('Quit confirmation failed; keeping TUS open.');
      } finally { prompting = false; }
    })();
  };
  app.on('before-quit', event => {
    if (approved || !getWindow()) {
      if (!cleaned) { cleaned = true; cleanup(); }
      return;
    }
    requestQuit(event);
  });
  return window => window.on('close', requestQuit);
}
