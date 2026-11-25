import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const automationScript = fileURLToPath(new URL('./windows-quit-prompt.ps1', import.meta.url));

const safeUiMarkers = new Set([
  'script-start', 'window-api-ready', 'expected-foreground-prompt-unavailable',
  'prompt-dialog-process-match',
  'expected-body-recognized', 'quit-dialog-not-found', 'test-prompt-not-found', 'test-prompt-dismissed',
  'modified-body-button-returned', 'modified-body-unverified', 'modified-body-rejected',
  'ui-child-starting', 'ui-child-started', 'ui-payload-preparing', 'ui-payload-ready',
  'ui-payload-writing', 'ui-payload-written', 'ui-child-waiting', 'ui-child-finished',
  'ui-child-killing', 'ui-child-kill-waiting', 'ui-child-exit-checking', 'ui-child-output-draining',
  'ui-child-finally-exit-checking', 'ui-child-finally-killing', 'ui-child-finally-waiting', 'ui-child-disposing',
]);
const safeUiPromptStatuses = new Set([
  'foreground-window-unavailable', 'foreground-title-mismatch', 'invalid-window',
  'title-mismatch', 'button-count-mismatch', 'expected-buttons-missing',
  'requested-button-missing', 'expected-message-mismatch', 'expected-message-unavailable',
  'expected-body-mismatch', 'expected-body-timeout', 'expected-body-unavailable',
  'owner-window-unavailable', 'window-not-found', 'window-title-mismatch', 'window-owner-mismatch', 'window-process-mismatch', 'window-ambiguous', 'foreground-activation-rejected',
]);
const safeUiTimeoutPhase = /^prompt-reader-timeout-phase-(?:child-start|payload-read-(?:start|done)|payload-parse-(?:start|done)|payload-decode-(?:start|done)|payload-json-(?:start|done)|addtype-(?:types|client)-(?:start|done)|fromhandle-(?:start|done)|first-child-(?:start|done)|child-name-(?:start|done)|next-sibling-(?:start|done))$/;
const safeUiActions = new Set([
  'keep-open', 'quit-anyway', 'assert-body-mismatch-rejected',
  'assert-exact-body-recognized', 'dismiss-test-prompt', 'file-menu-open', 'file-menu-exit',
]);
const safeUiTimingPattern = /^TUS_UIA_TIMING: (?:(?:window-api-init|reader-setup|process-start|fromhandle|payload-encode|payload-write|reader-wait|child-kill|child-reap|output-drain|child-finally-kill|child-finally-reap|taskkill|graphics-health|graphics-errors)-ms=\d{1,6}|app-close-ms=\d{1,8}|ui-(?:keep-open|quit-anyway|assert-body-mismatch-rejected|assert-exact-body-recognized|dismiss-test-prompt|file-menu-open|file-menu-exit)-ms=\d{1,6})$/;

export function safeUiTimingLine(line) {
  return typeof line === 'string' && safeUiTimingPattern.test(line) ? line : null;
}

export function safeUiFailureOutcome(tokens = [], processFailure = 'probe-failed') {
  if (Array.isArray(tokens) && tokens.includes('prompt-expected-body-timeout')) {
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      if (typeof token === 'string' &&
          (token === 'prompt-reader-timeout-no-phase' || safeUiTimeoutPhase.test(token))) return token;
    }
  }
  let marker;
  for (let index = Array.isArray(tokens) ? tokens.length - 1 : -1; index >= 0; index--) {
    const token = tokens[index];
    if (typeof token !== 'string') continue;
    if (token === 'prompt-reader-timeout-no-phase' || safeUiTimeoutPhase.test(token)) return token;
    const status = token.startsWith('prompt-') ? token.slice('prompt-'.length)
      : token.startsWith('expected-body-') ? token.slice('expected-body-'.length) : '';
    if (safeUiPromptStatuses.has(status)) return token;
    if (/^automation-error-[a-z0-9]{1,48}-at-[a-z0-9-]{1,64}$/.test(token)) return token;
    if (safeUiMarkers.has(token) && !marker) marker = token;
  }
  if (marker === 'script-start' || marker === 'window-api-ready') return marker + '-no-status';
  const failure = typeof processFailure === 'string' ? processFailure : '';
  return marker || (/^(?:exit-[A-Za-z0-9_-]{1,32}|timeout-[A-Za-z0-9-]{1,32})$/.test(failure) ? failure : 'probe-failed');
}

async function ui(action, pid, menuKey, apartment = 'MTA', ownerWindowHandle) {
  const startedAt = Date.now();
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', automationScript,
    '-Action', action, '-ProcessId', String(pid), '-Apartment', apartment,
  ];
  if (action === 'file-menu-exit') args.push('-MenuKey', menuKey);
  if (ownerWindowHandle) args.push('-OwnerWindowHandle', ownerWindowHandle);
  const { error, stdout, stderr } = await new Promise(resolve => {
    execFile('powershell.exe', args, { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  if (safeUiActions.has(action)) console.log('TUS_UIA_TIMING: ui-' + action + '-ms=' + (Date.now() - startedAt));
  if (error) {
    const output = [stdout, stderr].map(value => String(value ?? '')).join('\n');
    const outputLines = output.split(/\r?\n/).map(line => line.trim());
    const markers = outputLines.filter(line => /^TUS_UIA: [a-z0-9-]+$/i.test(line));
    const timingLines = outputLines.map(safeUiTimingLine).filter(Boolean);
    if (timingLines.length) console.log([...new Set(timingLines)].join('\n'));
    const processFailure = error.killed
      ? 'timeout-' + String(error.signal ?? 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '')
      : 'exit-' + (String(error.code ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown');
    const detail = safeUiFailureOutcome(markers.slice(-3).map(line => line.slice(9).toLowerCase()), processFailure);
    throw new Error('Windows native quit UI action failed: ' + action + ' (' + detail + ')');
  }
  if (stdout.trim()) console.log(stdout.trim());
  return stdout.trim();
}


async function promptOwnerWindowIdentity(app, expectedExecutable) {
  assert.equal(typeof expectedExecutable === 'string' && path.isAbsolute(expectedExecutable), true,
    'the native prompt uses the exact installed executable');
  const identity = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const window = windows.length === 1 ? windows[0] : null;
    const handle = window?.getNativeWindowHandle();
    const handleHex = handle?.length === 8 ? handle.readBigUInt64LE().toString(16)
      : handle?.length === 4 ? handle.readUInt32LE().toString(16) : '';
    return {
      processId: process.pid,
      executablePath: process.execPath,
      windowCount: windows.length,
      windowId: window?.id ?? null,
      handleHex,
    };
  });
  assert.equal(Number.isSafeInteger(identity.processId) && identity.processId > 0, true,
    'Electron main process has a positive PID');
  assert.equal(path.resolve(identity.executablePath).toLowerCase() === path.resolve(expectedExecutable).toLowerCase(), true,
    'Electron main process uses the exact installed executable');
  assert.equal(identity.windowCount, 1, 'the smoke process has one exact TUS owner window');
  assert.equal(/^[a-f0-9]{1,16}$/i.test(identity.handleHex), true, 'the owner HWND is captured without logging it');
  return identity;
}

async function assertModifiedPromptIsNotClicked(app, pid, modifiedField, ownerWindow) {
  assert.ok(['message', 'detail'].includes(modifiedField), 'only one prompt body field is changed at a time');
  await app.evaluate(({ dialog, BrowserWindow }, expected) => {
    const state = {
      original: dialog.showMessageBox.bind(dialog), invoked: false, resolved: false,
      processMatches: false, ownerWindowMatches: false,
      title: null, message: null, detail: null, buttons: null, response: null,
    };
    globalThis.__tusPromptTest = state;
    dialog.showMessageBox = async (window, options) => {
      state.invoked = true;
      const handle = window?.getNativeWindowHandle?.();
      const handleHex = handle?.length === 8 ? handle.readBigUInt64LE().toString(16)
        : handle?.length === 4 ? handle.readUInt32LE().toString(16) : '';
      state.processMatches = process.pid === expected.pid;
      state.ownerWindowMatches = window?.id === expected.windowId && handleHex === expected.handleHex &&
        BrowserWindow.getAllWindows().includes(window);
      const modifiedOptions = {
        ...options,
        [expected.field]: expected.field === 'message' ? 'Modified activity message.' : 'Modified activity detail.',
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
  }, { field: modifiedField, pid, windowId: ownerWindow.windowId, handleHex: ownerWindow.handleHex });

  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('The packaged TUS window is unavailable.');
      window.close();
    });

    const apartmentOrder = modifiedField === 'detail' ? ['STA', 'MTA'] : ['MTA', 'STA'];
    const apartmentOutcomes = new Map();
    for (const apartment of apartmentOrder) {
      let outcome = 'unavailable';
      try {
        const result = await ui('assert-body-mismatch-rejected', pid, undefined, apartment, ownerWindow.handleHex);
        outcome = /^TUS_UIA: modified-body-rejected$/m.test(result) ? 'mismatch'
          : /^TUS_UIA: modified-body-button-returned$/m.test(result) ? 'unexpected-match' : 'unexpected-result';
      } catch (error) {
        const safeOutcome = /exit-[a-z0-9_-]+|timeout-[a-z0-9-]+|(?:script-start|window-api-ready)-no-status|ui-(?:child-(?:starting|started|waiting|finished|killing|kill-waiting|exit-checking|output-draining|finally-exit-checking|finally-killing|finally-waiting|disposing)|payload-(?:preparing|ready|writing|written))|prompt-reader-timeout-[a-z0-9-]+|prompt-owner-window-unavailable|prompt-window-(?:not-found|title-mismatch|owner-mismatch|process-mismatch|ambiguous)|prompt-foreground-activation-rejected|expected-foreground-prompt-unavailable|quit-dialog-not-found|automation-error-[a-z0-9]+-at-[a-z0-9-]+|modified-body-(?:button-returned|unverified|rejected)|expected-body-(?:mismatch|unavailable|timeout)|test-prompt-not-found|test-prompt-dismissed|prompt-(?:foreground-window-unavailable|foreground-title-mismatch|expected-body-(?:mismatch|unavailable|timeout)|(?:invalid-window|title-mismatch|button-count-mismatch|expected-buttons-missing|requested-button-missing|expected-message-mismatch|expected-message-unavailable|matched))/gi;
        const outcomeTokens = [...String(error?.message || '').matchAll(safeOutcome)];
        const safeFailure = outcomeTokens.length ? outcomeTokens[outcomeTokens.length - 1][0].toLowerCase() : 'probe-failed';
        const timeout = safeFailure.match(/^prompt-reader-timeout-phase-([a-z0-9-]+)$/);
        outcome = timeout ? 'timeout-' + timeout[1] : safeFailure === 'modified-body-button-returned'
          ? 'unexpected-match' : safeFailure;
      }
      apartmentOutcomes.set(apartment, outcome);
      console.log('TUS_QUIT_COMPARE: ' + apartment.toLowerCase() + '=' + outcome);
      if (apartment === apartmentOrder[0]) {
        const prompt = await app.evaluate(() => {
          const state = globalThis.__tusPromptTest;
          return state ? {
            invoked: state.invoked === true,
            processMatches: state.processMatches === true,
            ownerWindowMatches: state.ownerWindowMatches === true,
            resolved: state.resolved === true,
            responseWasSafe: state.response === 0,
          } : null;
        }).catch(() => null);
        const token = value => value === true ? 'match' : value === false ? 'mismatch' : 'unknown';
        console.log('TUS_QUIT_PROMPT: invocation=' + token(prompt?.invoked) +
          ' process=' + token(prompt?.processMatches) +
          ' owner-window=' + token(prompt?.ownerWindowMatches));
        assert.deepEqual(
          { invoked: prompt?.invoked, processMatches: prompt?.processMatches, ownerWindowMatches: prompt?.ownerWindowMatches },
          { invoked: true, processMatches: true, ownerWindowMatches: true },
          'the fixture invoked the native dialog from the exact packaged process and BrowserWindow',
        );
      }
      if (/^prompt-(?:owner-window-unavailable|window-(?:not-found|title-mismatch|owner-mismatch|process-mismatch|ambiguous))$/.test(outcome)) {
        throw new Error('The native prompt was not found through its exact process and owner window.');
      }
    }

    const matcherRejected = apartmentOutcomes.get('MTA') === 'mismatch';
    const matcherOutcome = apartmentOutcomes.get('MTA') || 'unavailable';
    console.log('TUS_QUIT_TEST: ' + modifiedField + '-probe-' + matcherOutcome);

    let keepOpenRejected = false;
    if (matcherRejected) {
      try {
        await ui('keep-open', pid, undefined, 'MTA', ownerWindow.handleHex);
      } catch (error) {
        keepOpenRejected = /expected-body-mismatch/.test(error?.message || '');
      }
    }
    const beforeDismissal = await app.evaluate(({ app }, expectedPid) => {
      const state = globalThis.__tusPromptTest;
      return {
        mainProcessMatches: app.isReady() && process.pid === expectedPid,
        invoked: state?.invoked === true,
        processMatches: state?.processMatches === true,
        ownerWindowMatches: state?.ownerWindowMatches === true,
        resolved: state?.resolved === true,
        responseWasSafe: state?.response === 0,
        titleMatches: state?.title === 'Codex activity may continue',
        messageMutated: state?.message === 'Modified activity message.',
        detailMutated: state?.detail === 'Modified activity detail.',
        buttonsMatch: JSON.stringify(state?.buttons) === JSON.stringify(['Keep the game open', 'Quit anyway']),
      };
    }, pid);
    let dismissal = { resolved: beforeDismissal.resolved, responseWasSafe: beforeDismissal.responseWasSafe };
    if (beforeDismissal.invoked && beforeDismissal.processMatches && beforeDismissal.ownerWindowMatches && !beforeDismissal.resolved) {
      await ui('dismiss-test-prompt', pid, undefined, 'MTA', ownerWindow.handleHex);
      dismissal = await app.evaluate(async () => {
        const state = globalThis.__tusPromptTest;
        const deadline = Date.now() + 5000;
        while (!state.resolved && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        return { resolved: state.resolved, responseWasSafe: state.response === 0 };
      });
    }
    assert.equal(matcherRejected, true, 'the native matcher rejects the modified field as a definite body mismatch; safe outcome: ' + matcherOutcome);
    assert.equal(keepOpenRejected, true, 'keep-open refuses a changed body without clicking the button');
    assert.deepEqual(beforeDismissal, {
      mainProcessMatches: true,
      invoked: true,
      processMatches: true,
      ownerWindowMatches: true,
      resolved: false,
      responseWasSafe: false,
      titleMatches: true,
      messageMutated: modifiedField === 'message',
      detailMutated: modifiedField === 'detail',
      buttonsMatch: true,
    }, 'the modified native prompt remains open while keep-open is checked');
    assert.deepEqual(dismissal, { resolved: true, responseWasSafe: true }, 'test cleanup cancels the prompt with its safe default');
    assert.equal(await app.evaluate(({ app }, expectedPid) => app.isReady() && process.pid === expectedPid, pid), true, 'rejecting a modified prompt leaves the same TUS main process running');
  } finally {
    const pending = await app.evaluate(() => {
      const state = globalThis.__tusPromptTest;
      return state ? { invoked: state.invoked === true, processMatches: state.processMatches === true,
        ownerWindowMatches: state.ownerWindowMatches === true, resolved: state.resolved === true } : null;
    }).catch(() => null);
    if (pending?.invoked && pending.processMatches && pending.ownerWindowMatches && !pending.resolved) {
      try { await ui('dismiss-test-prompt', pid, undefined, 'MTA', ownerWindow.handleHex); } catch {}
    }
    await app.evaluate(({ dialog }) => {
      const state = globalThis.__tusPromptTest;
      if (state) dialog.showMessageBox = state.original;
      delete globalThis.__tusPromptTest;
    }).catch(() => {});
  }
}

async function assertKnownStatusDetailIsRecognized(app, pid, ownerWindow) {
  await app.evaluate(({ dialog, BrowserWindow }, expected) => {
    const state = {
      original: dialog.showMessageBox.bind(dialog), invoked: false, resolved: false,
      processMatches: false, ownerWindowMatches: false,
    };
    globalThis.__tusKnownPromptTest = state;
    dialog.showMessageBox = async (window, options) => {
      state.invoked = true;
      const handle = window?.getNativeWindowHandle?.();
      const handleHex = handle?.length === 8 ? handle.readBigUInt64LE().toString(16)
        : handle?.length === 4 ? handle.readUInt32LE().toString(16) : '';
      state.processMatches = process.pid === expected.pid;
      state.ownerWindowMatches = window?.id === expected.windowId && handleHex === expected.handleHex &&
        BrowserWindow.getAllWindows().includes(window);
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
  }, { pid, windowId: ownerWindow.windowId, handleHex: ownerWindow.handleHex });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('The packaged TUS window is unavailable.');
      window.close();
    });
    const result = await ui('assert-exact-body-recognized', pid, undefined, 'MTA', ownerWindow.handleHex);
    assert.match(result, /^TUS_UIA: expected-body-recognized$/m,
      'a known prompt with the native Goal status prefix is recognized');
    const snapshot = await app.evaluate(({ app }, expectedPid) => {
      const state = globalThis.__tusKnownPromptTest;
      return { mainProcessMatches: app.isReady() && process.pid === expectedPid, invoked: state?.invoked === true, processMatches: state?.processMatches === true, ownerWindowMatches: state?.ownerWindowMatches === true };
    }, pid);
    assert.deepEqual(snapshot, { mainProcessMatches: true, invoked: true, processMatches: true, ownerWindowMatches: true },
      'the production dialog belongs to the exact packaged process and BrowserWindow');
    assert.equal(await app.evaluate(({ app }, expectedPid) => app.isReady() && process.pid === expectedPid, pid), true, 'recognizing the known prompt leaves the same TUS main process running');
    await ui('dismiss-test-prompt', pid, undefined, 'MTA', ownerWindow.handleHex);
    const dismissed = await app.evaluate(async () => {
      const state = globalThis.__tusKnownPromptTest;
      const deadline = Date.now() + 5000;
      while (!state.resolved && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return state.resolved;
    });
    assert.equal(dismissed, true, 'test cleanup cancels the known prompt');
  } finally {
    const pending = await app.evaluate(() => {
      const state = globalThis.__tusKnownPromptTest;
      return state ? { invoked: state.invoked === true, processMatches: state.processMatches === true,
        ownerWindowMatches: state.ownerWindowMatches === true, resolved: state.resolved === true } : null;
    }).catch(() => null);
    if (pending?.invoked && pending.processMatches && pending.ownerWindowMatches && !pending.resolved) {
      try { await ui('dismiss-test-prompt', pid, undefined, 'MTA', ownerWindow.handleHex); } catch {}
    }
    await app.evaluate(({ dialog }) => {
      const state = globalThis.__tusKnownPromptTest;
      if (state) dialog.showMessageBox = state.original;
      delete globalThis.__tusKnownPromptTest;
    }).catch(() => {});
  }
}


export async function quitPromptAcceptance(app, page, graphics, expectedExecutable) {
  const launcher = app.process();
  assert.ok(launcher?.pid, 'Playwright launched the packaged TUS process');
  const launcherPid = launcher.pid;
  let timer;
  const exited = launcher.exitCode !== null ? Promise.resolve(launcher.exitCode) : new Promise((resolve, reject) => {
    launcher.once('exit', code => resolve(code));
    launcher.once('error', reject);
  });
  void exited.catch(() => {});

  try {
    const ownerWindow = await promptOwnerWindowIdentity(app, expectedExecutable);
    const pid = ownerWindow.processId;
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
    assert.equal(before.threadId === 'saved-game-thread-fixture', true, 'the native prompt scenario uses its isolated unsafe thread fixture');
    console.log('TUS_QUIT_WINDOW: app-exe=match main-process=identified owner-window=captured');
    await assertModifiedPromptIsNotClicked(app, pid, 'detail', ownerWindow);
    await assertModifiedPromptIsNotClicked(app, pid, 'message', ownerWindow);
    await assertKnownStatusDetailIsRecognized(app, pid, ownerWindow);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error('The packaged TUS window is unavailable.'); window.close(); });
    const exactPromptEvidence = await ui('assert-exact-body-recognized', pid, undefined, 'MTA', ownerWindow.handleHex);
    assert.match(exactPromptEvidence, /^TUS_UIA: expected-body-recognized$/m, 'the exact production message and detail are recognized before clicking');
    const closePrompt = await ui('keep-open', pid, undefined, 'MTA', ownerWindow.handleHex);
    assert.match(closePrompt, /^TUS_UIA: exact-foreground-prompt-matched$/m, 'window-close prompt is the exact TUS dialog');
    assert.equal(await app.evaluate(({ app }, expectedPid) => app.isReady() && process.pid === expectedPid, pid), true, 'Keep the game open leaves the same TUS main process running');
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
    const exitPrompt = await ui('quit-anyway', pid, undefined, 'MTA', ownerWindow.handleHex);
    assert.match(exitPrompt, /^TUS_UIA: exact-foreground-prompt-matched$/m, 'File → Exit prompt is the exact TUS dialog');
    const exitCode = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged TUS did not exit after Quit anyway.')), 15000); }),
    ]);
    assert.equal(exitCode, 0, 'Quit anyway exits the packaged client cleanly');
  } catch (error) {
    if (launcher.exitCode === null) {
      const startedAt = Date.now();
      console.log('TUS_WINDOWS_CLOSE: taskkill-started');
      let outcome = 'failed';
      try {
        await run('taskkill.exe', ['/PID', String(launcherPid), '/T', '/F'], { timeout: 10000, windowsHide: true });
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Packaged TUS did not exit after process-tree cleanup.'), { code: 'ETIMEDOUT' })), 5000);
          }),
        ]);
        outcome = 'completed';
      } catch {}
      console.log('TUS_UIA_TIMING: taskkill-ms=' + (Date.now() - startedAt));
      console.log('TUS_WINDOWS_CLOSE: taskkill-' + outcome);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
