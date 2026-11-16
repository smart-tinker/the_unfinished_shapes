import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const automationScript = fileURLToPath(new URL('./windows-quit-prompt.ps1', import.meta.url));

const safeUiMarkers = new Set([
  'script-start', 'window-api-ready', 'expected-foreground-prompt-unavailable',
  'expected-body-recognized', 'quit-dialog-not-found', 'modified-body-button-returned',
  'modified-body-unverified', 'modified-body-rejected',
  'ui-child-starting', 'ui-child-started', 'ui-payload-preparing', 'ui-payload-ready',
  'ui-payload-writing', 'ui-payload-written', 'ui-child-waiting', 'ui-child-finished',
]);
const safeUiPromptStatuses = new Set([
  'foreground-window-unavailable', 'foreground-title-mismatch', 'invalid-window',
  'title-mismatch', 'button-count-mismatch', 'expected-buttons-missing',
  'requested-button-missing', 'expected-message-mismatch', 'expected-message-unavailable',
  'expected-body-mismatch', 'expected-body-timeout', 'expected-body-unavailable',
]);
const safeUiTimeoutPhase = /^prompt-reader-timeout-phase-(?:child-start|payload-read-(?:start|done)|payload-parse-(?:start|done)|addtype-(?:types|client)-(?:start|done)|fromhandle-(?:start|done)|findfirst-[01]-(?:start|done)|current-name-[01](?:-[0-7])?-(?:start|done)|next-sibling-[01]-[0-7]-(?:start|done))$/;

export function safeUiFailureOutcome(tokens = [], processFailure = 'probe-failed') {
  let marker;
  for (let index = Array.isArray(tokens) ? tokens.length - 1 : -1; index >= 0; index--) {
    const token = tokens[index];
    if (typeof token !== 'string') continue;
    if (token === 'prompt-reader-timeout-no-phase' || safeUiTimeoutPhase.test(token)) return token;
    const status = token.startsWith('prompt-') ? token.slice('prompt-'.length)
      : token.startsWith('expected-body-') ? token.slice('expected-body-'.length) : '';
    if ((safeUiMarkers.has(token) || safeUiPromptStatuses.has(status)) && !marker) marker = token;
  }
  if (marker === 'script-start' || marker === 'window-api-ready') return marker + '-no-status';
  const failure = typeof processFailure === 'string' ? processFailure : '';
  return marker || (/^(?:exit-[A-Za-z0-9_-]{1,32}|timeout-[A-Za-z0-9-]{1,32})$/.test(failure) ? failure : 'probe-failed');
}

async function ui(action, pid, menuKey) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', automationScript,
    '-Action', action, '-ProcessId', String(pid),
  ];
  if (action === 'file-menu-exit') args.push('-MenuKey', menuKey);
  const { error, stdout, stderr } = await new Promise(resolve => {
    execFile('powershell.exe', args, { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  if (error) {
    const output = [stdout, stderr].map(value => String(value ?? '')).join('\n');
    const markers = output.split(/\r?\n/).map(line => line.trim()).filter(line => /^TUS_UIA: [a-z0-9-]+$/i.test(line));
    const processFailure = error.killed
      ? 'timeout-' + String(error.signal ?? 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '')
      : 'exit-' + (String(error.code ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown');
    const detail = safeUiFailureOutcome(markers.slice(-3).map(line => line.slice(9).toLowerCase()), processFailure);
    throw new Error('Windows native quit UI action failed: ' + action + ' (' + detail + ')');
  }
  if (stdout.trim()) console.log(stdout.trim());
  return stdout.trim();
}


async function assertModifiedPromptIsNotClicked(app, pid, process, modifiedField) {
  assert.ok(['message', 'detail'].includes(modifiedField), 'only one prompt body field is changed at a time');
  await app.evaluate(({ dialog }, field) => {
    const state = { original: dialog.showMessageBox.bind(dialog), resolved: false, title: null, message: null, detail: null, buttons: null, response: null };
    globalThis.__tusPromptTest = state;
    dialog.showMessageBox = async (window, options) => {
      const modifiedOptions = {
        ...options,
        [field]: field === 'message' ? 'Modified activity message.' : 'Modified activity detail.',
      };
      state.title = modifiedOptions.title;
      state.message = modifiedOptions.message;
      state.detail = modifiedOptions.detail;
      state.buttons = [...modifiedOptions.buttons];
      const result = await state.original(window, modifiedOptions);
      state.response = result.response;
      state.resolved = true;
      return result;
    };
  }, modifiedField);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('The packaged TUS window is unavailable.');
    window.close();
  });

  let matcherRejected = false;
  let matcherOutcome = 'unverified';
  try {
    const result = await ui('assert-body-mismatch-rejected', pid);
    matcherRejected = /^TUS_UIA: modified-body-rejected$/m.test(result);
    matcherOutcome = matcherRejected ? 'mismatch' : 'unexpected-result';
  } catch (error) {
    const safeOutcome = /exit-[a-z0-9_-]+|timeout-[a-z0-9-]+|(?:script-start|window-api-ready)-no-status|ui-(?:child-(?:starting|started|waiting|finished)|payload-(?:preparing|ready|writing|written))|prompt-reader-timeout-[a-z0-9-]+|expected-foreground-prompt-unavailable|quit-dialog-not-found|automation-error-[a-z0-9]+-at-[a-z0-9-]+|modified-body-(?:button-returned|unverified|rejected)|expected-body-(?:mismatch|unavailable|timeout)|prompt-(?:foreground-window-unavailable|foreground-title-mismatch|expected-body-(?:mismatch|unavailable|timeout)|(?:invalid-window|title-mismatch|button-count-mismatch|expected-buttons-missing|requested-button-missing|expected-message-mismatch|expected-message-unavailable|matched))/gi;
    const outcomeTokens = [...String(error?.message || '').matchAll(safeOutcome)];
    matcherOutcome = outcomeTokens.length ? outcomeTokens[outcomeTokens.length - 1][0].toLowerCase() : 'probe-failed';
    console.log('TUS_UIA_TEST: detail-probe-' + matcherOutcome);
  }

  let keepOpenRejected = false;
  if (matcherRejected) {
    try {
      await ui('keep-open', pid);
    } catch (error) {
      keepOpenRejected = /expected-body-mismatch/.test(error?.message || '');
    }
  }
  const beforeDismissal = await app.evaluate(() => {
    const state = globalThis.__tusPromptTest;
    return {
      resolved: state?.resolved,
      responseWasSafe: state?.response === 0,
      titleMatches: state?.title === 'Codex activity may continue',
      messageMutated: state?.message === 'Modified activity message.',
      detailMutated: state?.detail === 'Modified activity detail.',
      buttonsMatch: JSON.stringify(state?.buttons) === JSON.stringify(['Keep the game open', 'Quit anyway']),
    };
  });
  if (!beforeDismissal.resolved) await ui('dismiss-test-prompt', pid);
  const dismissal = await app.evaluate(async () => {
    const state = globalThis.__tusPromptTest;
    const deadline = Date.now() + 5000;
    while (!state.resolved && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { resolved: state.resolved, responseWasSafe: state.response === 0 };
  });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.__tusPromptTest.original;
    delete globalThis.__tusPromptTest;
  });
  assert.equal(matcherRejected, true, 'the native matcher rejects the modified field as a definite body mismatch; safe outcome: ' + matcherOutcome);
  assert.equal(keepOpenRejected, true, 'keep-open refuses a changed body without clicking the button');
  assert.deepEqual(beforeDismissal, {
    resolved: false,
    responseWasSafe: false,
    titleMatches: true,
    messageMutated: modifiedField === 'message',
    detailMutated: modifiedField === 'detail',
    buttonsMatch: true,
  }, 'the modified native prompt remains open while keep-open is checked');
  assert.deepEqual(dismissal, { resolved: true, responseWasSafe: true }, 'test cleanup cancels the prompt with its safe default');
  assert.equal(process.exitCode, null, 'rejecting a modified prompt leaves TUS running');
}


async function assertKnownStatusDetailIsRecognized(app, pid, process) {
  await app.evaluate(({ dialog }) => {
    const state = { original: dialog.showMessageBox.bind(dialog), resolved: false };
    globalThis.__tusKnownPromptTest = state;
    dialog.showMessageBox = async (window, options) => {
      const result = await state.original(window, {
        ...options,
        title: 'Codex activity may continue',
        message: 'Codex may still be working in this conversation.',
        detail: 'Native Goal status: active. Quitting TUS closes its Codex connection but does not confirm that a Goal or turn stopped. Keep the game open to pause or clear the Goal, or quit anyway.',
        buttons: ['Keep the game open', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
      });
      state.resolved = true;
      return result;
    };
  });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('The packaged TUS window is unavailable.');
    window.close();
  });
  const result = await ui('assert-exact-body-recognized', pid);
  assert.match(result, /^TUS_UIA: expected-body-recognized$/m,
    'a known prompt with the native Goal status prefix is recognized');
  assert.equal(process.exitCode, null, 'recognizing the known prompt does not click either button');
  await ui('dismiss-test-prompt', pid);
  const dismissed = await app.evaluate(async () => {
    const state = globalThis.__tusKnownPromptTest;
    const deadline = Date.now() + 5000;
    while (!state.resolved && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return state.resolved;
  });
  assert.equal(dismissed, true, 'test cleanup cancels the known prompt');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.__tusKnownPromptTest.original;
    delete globalThis.__tusKnownPromptTest;
  });
}

export async function quitPromptAcceptance(app, page, graphics) {
  const process = app.process();
  assert.ok(process?.pid, 'packaged TUS main process has a PID');
  const pid = process.pid;
  const before = await page.evaluate(async () => {
    const settings = await window.tus.loadSettings();
    const world = await window.tus.request({ ...settings, path: '/state' });
    return {
      workspacePath: settings.workspacePath,
      codexPath: settings.codexPath,
      threadId: settings.threadId,
      worldObjects: world.objects,
    };
  });
  let timer;
  const exited = new Promise((resolve, reject) => {
    process.once('exit', code => resolve(code));
    process.once('error', reject);
  });
  try {
    await assertModifiedPromptIsNotClicked(app, pid, process, 'detail');
    await assertModifiedPromptIsNotClicked(app, pid, process, 'message');
    await assertKnownStatusDetailIsRecognized(app, pid, process);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error('The packaged TUS window is unavailable.'); window.close(); });
    const exactPromptEvidence = await ui('assert-exact-body-recognized', pid);
    assert.match(exactPromptEvidence, /^TUS_UIA: expected-body-recognized$/m, 'the exact production message and detail are recognized before clicking');
    const closePrompt = await ui('keep-open', pid);
    assert.match(closePrompt, /^TUS_UIA: exact-foreground-prompt-matched$/m, 'window-close prompt is the exact TUS dialog');
    assert.equal(process.exitCode, null, 'Keep the game open leaves the packaged process running');
    await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'), null, { timeout: 10000 });
    const afterCancel = await page.evaluate(async () => {
      const settings = await window.tus.loadSettings();
      const world = await window.tus.request({ ...settings, path: '/state' });
      return {
        workspacePath: settings.workspacePath,
        codexPath: settings.codexPath,
        threadId: settings.threadId,
        worldObjects: world.objects,
      };
    });
    assert.deepEqual(afterCancel, before, 'canceling the native prompt leaves settings and world unchanged');
    await graphics.assertHealthy();
    const exitMenuKey = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const file = menu?.items.find(item => item.label.replace(/&/g, '').trim() === 'File');
      const exits = (file?.submenu?.items ?? []).filter(item => item.enabled !== false && item.visible !== false &&
        (item.role === 'quit' || ['Exit', 'Quit'].includes(item.label.replace(/&/g, '').trim())));
      if (exits.length !== 1) return null;
      const label = exits[0].label.replace(/&/g, '').trim();
      return ['Exit', 'Quit'].includes(label) ? label[0].toLowerCase() : null;
    });
    assert.ok(['e', 'q'].includes(exitMenuKey), 'Electron File menu exposes one exact Exit/Quit command');
    const fileMenuOpened = await app.evaluate(({ BrowserWindow, Menu }) => {
      const menu = Menu.getApplicationMenu();
      const file = menu?.items.find(item => item.label.replace(/&/g, '').trim() === 'File');
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === 'The Unfinished Shapes');
      if (!file?.submenu || !window) return false;
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 5000);
        file.submenu.once('menu-will-show', () => { clearTimeout(timer); resolve(true); });
        file.submenu.popup({ window });
      });
    });
    assert.equal(fileMenuOpened, true, 'Electron File submenu opens on the exact TUS window');
    await ui('file-menu-exit', pid, exitMenuKey);
    const exitPrompt = await ui('quit-anyway', pid);
    assert.match(exitPrompt, /^TUS_UIA: exact-foreground-prompt-matched$/m, 'File → Exit prompt is the exact TUS dialog');
    const exitCode = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged TUS did not exit after Quit anyway.')), 15000); }),
    ]);
    assert.equal(exitCode, 0, 'Quit anyway exits the packaged client cleanly');
  } catch (error) {
    if (process.exitCode === null) {
      try { await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true }); } catch {}
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
