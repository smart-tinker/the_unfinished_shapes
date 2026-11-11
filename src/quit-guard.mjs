export function isSmokeAutoConfirmQuit(env = process.env, argv = process.argv) {
  return env.CI === 'true' && argv.includes('--tus-smoke-confirm-quit');
}

export function createQuitConfirmation({ dialog, getWindow, isSmokeAutoConfirm }) {
  return async state => {
    if (isSmokeAutoConfirm()) return true;
    const known = state?.connected === true;
    const goalStatus = state?.goal?.status;
    const detail = known
      ? `${goalStatus ? `Native Goal status: ${goalStatus}. ` : ''}Quitting TUS closes its Codex connection but does not confirm that a Goal or turn stopped. Keep the game open to pause or clear the Goal, or quit anyway.`
      : 'Codex state could not be confirmed. Keep the game open and reconnect to check the conversation, or quit anyway.';
    const result = await dialog.showMessageBox(getWindow(), {
      type: 'warning', title: 'Codex activity may continue',
      message: known ? 'Codex may still be working in this conversation.' : 'The current Codex activity is unknown.',
      detail, buttons: ['Keep the game open', 'Quit anyway'], defaultId: 0, cancelId: 0,
    });
    return result.response === 1;
  };
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
