import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { observeGraphics, closeSmokeApp, withSmokeCleanup } from './graphics-smoke.mjs';

import { stopServerProcess } from './server-smoke-process.mjs';
import { selectObject } from './ui-acceptance.mjs';
import { safeJumpTrace } from './shared-world-trace.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'tus-shared-'));
const tokens = { alice: randomBytes(24).toString('hex'), bob: randomBytes(24).toString('hex') };
const users = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [token, { id, role: 'builder' }]));
const dataPath = path.join(dir, 'world.json');
const clients = [];
let server, port, url;
async function startServer() {
  server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, WORLD_DATA_PATH: dataPath, WORLD_USERS_JSON: JSON.stringify(users), WORLD_PORT: String(port || 0) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Shared server did not start')), 15000);
    let output = '';
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Shared server exited: ' + code)); });
    server.stdout.on('data', chunk => {
      output = (output + chunk).slice(-4096);
      const match = output.match(/World server listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); port = Number(match[1]); url = 'http://127.0.0.1:' + port; resolve(); }
    });
    server.stderr.resume();
  });
}
async function stopServer() {
  const child = server; server = null;
  await stopServerProcess(child);
}
async function state(id = 'alice') {
  const response = await fetch(url + '/state', { headers: { Authorization: 'Bearer ' + tokens[id] }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function worldCommand(id, command) {
  const response = await fetch(url + '/command', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[id], 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
const jumpTraceResults = new Set(['accepted', 'stale', 'rejected', 'request-failed']);
const traceNumber = value => Number.isFinite(value) ? value : null;
const hasCompleteMoveResponse = response => Number.isSafeInteger(response?.serverRevision) &&
  ['x', 'y', 'z'].every(axis => Number.isFinite(response.serverPosition?.[axis])) && typeof response.clientApplied === 'boolean';
const qualifyingStatus = (evidence, complete) => evidence.length ? 'observed' : complete ? 'not_observed' : 'UNKNOWN';
const completeMoveSequence = events => {
  const moves = events.filter(event => event.type === 'move.request' || event.type === 'move.response');
  const requests = moves.filter(event => event.type === 'move.request'), responses = moves.filter(event => event.type === 'move.response');
  let pending = 0, badOrder = false;
  for (const event of moves) {
    if (event.type === 'move.request') { if (pending !== 0) badOrder = true; pending++; }
    else { if (pending !== 1) badOrder = true; pending = Math.max(0, pending - 1); }
  }
  return !badOrder && pending === 0 && requests.length === responses.length &&
    responses.every(event => jumpTraceResults.has(event.outcome) && event.outcome !== 'request-failed');
};
assert.equal(completeMoveSequence([{ type: 'move.request' }, { type: 'move.response', outcome: 'accepted' }]), true);
assert.equal(completeMoveSequence([{ type: 'move.request' }]), false);
assert.equal(hasCompleteMoveResponse({ serverRevision: 1, serverPosition: { x: 0, y: 0, z: 0 }, clientApplied: true }), true);
assert.equal(hasCompleteMoveResponse({ serverRevision: 1, serverPosition: { x: 0, y: 0, z: null }, clientApplied: true }), false);
assert.equal(qualifyingStatus([], true), 'not_observed');
assert.equal(qualifyingStatus([], false), 'UNKNOWN');
assert.equal(qualifyingStatus([{ revision: 1 }], false), 'observed');
const tracePosition = value => ({ x: traceNumber(value?.x), y: traceNumber(value?.y), z: traceNumber(value?.z) });
const safeMovementFrame = frame => Number.isSafeInteger(frame?.frameId) ? {
  frameId: frame.frameId, at: Number.isSafeInteger(frame.at) ? frame.at : null, dt: traceNumber(frame.dt),
  focused: typeof frame.focused === 'boolean' ? frame.focused : null,
  dHeld: typeof frame.dHeld === 'boolean' ? frame.dHeld : null,
  typing: typeof frame.typing === 'boolean' ? frame.typing : null,
  inputX: traceNumber(frame.inputX), jumpRequested: typeof frame.jumpRequested === 'boolean' ? frame.jumpRequested : null,
  before: tracePosition(frame.before), desired: tracePosition(frame.desired), resolved: tracePosition(frame.resolved),
  velocityYBefore: traceNumber(frame.velocityYBefore), velocityYAfter: traceNumber(frame.velocityYAfter),
  movementVersion: Number.isSafeInteger(frame.movementVersion) ? frame.movementVersion : null,
} : null;
assert.equal(safeMovementFrame(null), null);
assert.equal(safeMovementFrame({ frameId: 1, dHeld: true })?.dHeld, true);
assert.equal(safeMovementFrame({ frameId: 2, dt: .1, focused: true, typing: false, before: { x: 1 }, desired: { x: 2 }, resolved: { x: 1.5 } })?.desired.x, 2);
assert.equal(safeMovementFrame({ frameId: 2, dt: .1, focused: true, typing: false, before: { x: 1 }, desired: { x: 2 }, resolved: { x: 1.5 } })?.resolved.x, 1.5);
async function jumpTraceState(id) {
  const response = await fetch(url + '/state', { headers: { Authorization: 'Bearer ' + tokens[id] }, signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error('State trace unavailable');
  const snapshot = await response.json(), player = snapshot.players?.find(item => item.id === id), position = tracePosition(player?.position);
  return { at: Date.now(), revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : null, position,
    velocityY: traceNumber(player?.velocityY), valid: Number.isSafeInteger(snapshot.revision) && Object.values(position).every(Number.isFinite) };
}
async function installJumpTrace(client) {
  const trace = { observations: [], stateErrors: 0, droppedObservations: 0 };
  await client.page.evaluate(() => {
    const trace = { active: true, captureRafFrames: true, startedAt: Date.now(), rafFrames: [], droppedRafFrames: 0, events: [], droppedEvents: 0, droppedBeforeGate: 0, droppedAfterGate: 0, gateAt: null,
      spaceKeydown: false, jumpRequested: null, firstMoveJump: null, firstMoveSkip: null,
      firstMoveResult: null, jumpPostResponse: null, hudGate: null };
    const skips = new Set(['move-running', 'stationary', 'no-player', 'no-bridge']), results = new Set(['accepted', 'stale', 'rejected', 'request-failed']);
    const hud = () => {
      const match = /^X (-?\d+(?:\.\d+)?) · Y (-?\d+(?:\.\d+)?) · Z (-?\d+(?:\.\d+)?)$/.exec(document.querySelector('#coordinates')?.textContent || '');
      const revision = /^REV (\d+)$/.exec(document.querySelector('#revision')?.textContent || '');
      return { x: match ? Number(match[1]) : null, y: match ? Number(match[2]) : null, z: match ? Number(match[3]) : null,
        uiRevision: revision && Number.isSafeInteger(Number(revision[1])) ? Number(revision[1]) : null };
    };
    // shortcut: 128 events and 64 state samples, increase only if a slow 5s run reaches either cap.
    const record = (type, fields = {}) => {
      if (!trace.active) return;
      const at = Date.now();
      if (trace.events.length >= 128) {
        trace.droppedEvents++;
        if (trace.gateAt !== null && at > trace.gateAt) trace.droppedAfterGate++;
        else trace.droppedBeforeGate++;
        return;
      }
      trace.events.push({ sequence: trace.events.length + 1, at, type, ...fields });
    };
    window.__TUS_SMOKE_JUMP_TRACE_STATE = trace;
    window.__TUS_SMOKE_JUMP_TRACE = (name, value, details) => {
      if (!trace.active) return;
      if (name === 'jumpRequested') { trace.jumpRequested = value === true; record('jump.requested', { value: trace.jumpRequested }); }
      if (name === 'move.jump') {
        const jump = value === true;
        if (trace.spaceKeydown && trace.firstMoveJump === null) trace.firstMoveJump = jump;
        const target = details?.position;
        record('move.request', {
          jump,
          requestId: Number.isSafeInteger(details?.requestId) ? details.requestId : null,
          requestFrameId: Number.isSafeInteger(details?.movementFrame?.frameId) ? details.movementFrame.frameId : null,
          targetPosition: {
            x: Number.isFinite(target?.x) ? target.x : null,
            y: Number.isFinite(target?.y) ? target.y : null,
            z: Number.isFinite(target?.z) ? target.z : null,
          },
          movementFrame: details?.movementFrame ?? null, hud: hud(),
        });
      }
      if (name === 'move.skip') {
        const reason = skips.has(value) ? value : null;
        if (trace.spaceKeydown && trace.firstMoveSkip === null && reason) trace.firstMoveSkip = reason;
        record('move.skip', { reason, movementFrame: details?.movementFrame ?? null, hud: hud() });
      }
      if (name === 'move.result') {
        const response = details && typeof details === 'object' ? details : value && typeof value === 'object' ? value : {};
        const outcome = results.has(value) ? value : null;
        const position = response.position ?? response.serverPosition;
        const serverPosition = {
          x: Number.isFinite(position?.x) ? position.x : null,
          y: Number.isFinite(position?.y) ? position.y : null,
          z: Number.isFinite(position?.z) ? position.z : null,
        };
        const serverRevision = Number.isSafeInteger(response.revision) ? response.revision :
          Number.isSafeInteger(response.serverRevision) ? response.serverRevision : null;
        const clientApplied = typeof response.clientApplied === 'boolean' ? response.clientApplied : null;
        if (trace.spaceKeydown && trace.firstMoveResult === null && outcome) trace.firstMoveResult = outcome;
        record('move.response', {
          requestId: Number.isSafeInteger(response.requestId) ? response.requestId : null,
          requestFrameId: Number.isSafeInteger(response.requestFrameId) ? response.requestFrameId : null,
          responseFrameId: Number.isSafeInteger(response.responseFrameId) ? response.responseFrameId : null,
          requestMovementVersion: Number.isSafeInteger(response.requestMovementVersion) ? response.requestMovementVersion : null,
          responseMovementVersion: Number.isSafeInteger(response.responseMovementVersion) ? response.responseMovementVersion : null,
          outcome, serverPosition, serverRevision, clientApplied, hud: hud(),
        });
      }
      if (name === 'move.jump-response') {
        const position = value?.serverPosition, response = {
          requestId: Number.isSafeInteger(value?.requestId) ? value.requestId : null,
          requestFrameId: Number.isSafeInteger(value?.requestFrameId) ? value.requestFrameId : null,
          responseFrameId: Number.isSafeInteger(value?.responseFrameId) ? value.responseFrameId : null,
          responseReceived: value?.responseReceived === true, outcome: results.has(value?.outcome) ? value.outcome : null,
          serverPosition: { x: Number.isFinite(position?.x) ? position.x : null, y: Number.isFinite(position?.y) ? position.y : null, z: Number.isFinite(position?.z) ? position.z : null },
          serverVelocityY: Number.isFinite(value?.serverVelocityY) ? value.serverVelocityY : null,
          serverRevision: Number.isSafeInteger(value?.serverRevision) ? value.serverRevision : null,
          clientApplied: typeof value?.clientApplied === 'boolean' ? value.clientApplied : null,
        };
        if (trace.spaceKeydown && trace.jumpPostResponse === null) trace.jumpPostResponse = { postAttempted: true, ...response };
        record('jump.response', response);
      }
    };
    const code = event => ['Space', 'KeyD'].includes(event.code) ? event.code : null;
    window.addEventListener('keydown', event => {
      const key = code(event);
      if (key) { record('key', { code: key, edge: 'down', repeat: event.repeat === true }); if (key === 'Space') trace.spaceKeydown = true; }
    }, true);
    window.addEventListener('keyup', event => { const key = code(event); if (key) record('key', { code: key, edge: 'up', repeat: event.repeat === true }); }, true);
    return true;
  });
  return trace;
}
async function startJumpTraceWindow(client, trace) {
  trace.startedAt = Date.now(); trace.stopped = false;
  // Gravity advances only on move POSTs; sample faster than the renderer's 250ms sync interval.
  trace.sampleTask = (async () => {
    while (!trace.stopped) {
      const cycle = Date.now();
      try {
        const state = await jumpTraceState(client.id);
        const hud = await client.page.evaluate(() => {
          const match = /^X (-?\d+(?:\.\d+)?) · Y (-?\d+(?:\.\d+)?) · Z (-?\d+(?:\.\d+)?)$/.exec(document.querySelector('#coordinates')?.textContent || '');
          const revision = /^REV (\d+)$/.exec(document.querySelector('#revision')?.textContent || '');
          return { at: Date.now(), x: match ? Number(match[1]) : null, y: match ? Number(match[2]) : null, z: match ? Number(match[3]) : null,
            uiRevision: revision && Number.isSafeInteger(Number(revision[1])) ? Number(revision[1]) : null };
        });
        if (trace.observations.length < 64) trace.observations.push({ at: Date.now(), state, hud });
        else trace.droppedObservations++;
      } catch { trace.stateErrors++; }
      if (!trace.stopped) await new Promise(resolve => setTimeout(resolve, Math.max(0, 100 - (Date.now() - cycle))));
    }
  })();
}
async function stopJumpTraceWindow(client, trace, gateAt) {
  trace.gateAt = gateAt; trace.stopped = true;
  await client.page.evaluate(gateAt => {
    const current = window.__TUS_SMOKE_JUMP_TRACE_STATE;
    if (current) { current.gateAt = gateAt; current.captureRafFrames = false; }
  }, gateAt).catch(() => {});
}
async function reportJumpTrace(client, trace, gateResult, gateAt, initialSnapshot, landingResult = 'not-reached') {
  const raw = await client.page.evaluate(() => {
    const current = window.__TUS_SMOKE_JUMP_TRACE_STATE;
    if (!current) return {};
    current.active = false;
    return {
      startedAt: current.startedAt, spaceKeydown: current.spaceKeydown, jumpRequested: current.jumpRequested, firstMoveJump: current.firstMoveJump,
      firstMoveSkip: current.firstMoveSkip, firstMoveResult: current.firstMoveResult, jumpPostResponse: current.jumpPostResponse,
      rafFrames: current.rafFrames, droppedRafFrames: current.droppedRafFrames,
      events: current.events, droppedEvents: current.droppedEvents, droppedBeforeGate: current.droppedBeforeGate,
      droppedAfterGate: current.droppedAfterGate, gateAt: current.gateAt, endAt: Date.now(), hudGate: current.hudGate,
    };
  }).catch(() => ({}));
  await Promise.allSettled([trace.sampleTask]);
  const startAt = trace.startedAt ?? gateAt, durationMs = Math.max(0, gateAt - startAt);
  const gateBoundaryAt = Number.isSafeInteger(raw.gateAt) ? raw.gateAt : gateAt, endAt = Number.isSafeInteger(raw.endAt) ? raw.endAt : Date.now();
  const rafStartAt = Number.isSafeInteger(raw.startedAt) ? raw.startedAt : startAt;
  const allEvents = (raw.events ?? []).filter(event => event.at <= endAt);
  const events = allEvents.filter(event => event.at <= gateBoundaryAt), postGateEvents = allEvents.filter(event => event.at > gateBoundaryAt);
  const observations = trace.observations.filter(item => item.at <= gateBoundaryAt);
  const requests = events.filter(event => event.type === 'move.request'), responses = events.filter(event => event.type === 'move.response');
  const jumpRequests = requests.filter(event => event.jump), jumpResponses = events.filter(event => event.type === 'jump.response');
  const jumpResponsesComplete = jumpRequests.length > 0 && jumpRequests.length === jumpResponses.length && jumpResponses.every(event => event.responseReceived && jumpTraceResults.has(event.outcome) &&
    Number.isSafeInteger(event.serverRevision) && Object.values(event.serverPosition ?? {}).every(Number.isFinite));
  const movementResponsesComplete = raw.droppedBeforeGate === 0 && completeMoveSequence(events) && jumpResponsesComplete;
  // Polling can miss intermediate revisions; only a state-bearing result per POST proves a negative.
  const movementStateResponsesComplete = responses.length > 0 && responses.every(hasCompleteMoveResponse);
  const postGateResponses = postGateEvents.filter(event => event.type === 'move.response');
  const postGateComplete = Array.isArray(raw.events) && raw.droppedAfterGate === 0 &&
    completeMoveSequence(postGateEvents) && postGateResponses.every(hasCompleteMoveResponse);
  const postGateStatus = postGateComplete ? (postGateResponses.length ? 'complete' : 'not_observed') : 'UNKNOWN';
  const times = observations.map(item => item.at - startAt), maxGapMs = times.slice(1).reduce((max, at, index) => Math.max(max, at - times[index]), 0);
  const samplesComplete = trace.droppedObservations === 0 && observations.length > 0 && times[0] <= 200 &&
    times.at(-1) >= durationMs - 300 && maxGapMs <= 200 &&
    observations.every(item => item.state.valid && [item.hud.x, item.hud.y, item.hud.z].every(Number.isFinite) && Number.isSafeInteger(item.hud.uiRevision));
  const sameRevisionSamples = observations.filter(item => item.state.revision === item.hud.uiRevision).length;
  const jumpStates = events.filter(event => event.type === 'jump.response' && event.responseReceived && Number.isSafeInteger(event.serverRevision) &&
    Object.values(event.serverPosition ?? {}).every(Number.isFinite));
  const initialPlayer = initialSnapshot?.players?.find(item => item.id === client.id);
  const initialState = { revision: initialSnapshot?.revision, position: tracePosition(initialPlayer?.position) };
  const serverStates = [
    initialState,
    ...observations.filter(item => item.state.valid).map(item => ({ revision: item.state.revision, position: item.state.position })),
    ...events.filter(event => event.type === 'move.response' && hasCompleteMoveResponse(event)).map(event => ({ revision: event.serverRevision, position: event.serverPosition })),
    ...jumpStates.map(event => ({ revision: event.serverRevision, position: event.serverPosition })),
  ].filter(state => Number.isSafeInteger(state.revision) && ['x', 'y', 'z'].every(axis => Number.isFinite(state.position?.[axis])));
  const matchesHudState = hud => Number.isSafeInteger(hud?.uiRevision) && ['x', 'y', 'z'].every(axis => Number.isFinite(hud[axis])) &&
    serverStates.some(state => state.revision === hud.uiRevision && ['x', 'y', 'z'].every(axis => Number(state.position[axis].toFixed(1)) === hud[axis]));
  const linkedHudSamples = observations.filter(item => matchesHudState(item.hud)).length;
  const hudGateStateLinked = gateResult !== 'airborne' || matchesHudState(raw.hudGate);
  const hudRevisionStatus = observations.length && linkedHudSamples === observations.length && hudGateStateLinked ? 'linked' : 'UNKNOWN';
  const qualifying = [
    ...observations.filter(item => item.state.valid && item.state.position.x >= 15 && item.state.position.x < 17 && item.state.position.y > 0).map(item => ({ revision: item.state.revision, source: 'sample', atMs: item.state.at - startAt })),
    ...events.filter(event => event.type === 'move.response' && hasCompleteMoveResponse(event) && event.serverPosition.x >= 15 && event.serverPosition.x < 17 && event.serverPosition.y > 0).map(event => ({ revision: event.serverRevision, source: 'move-response', atMs: event.at - startAt })),
    ...jumpStates.filter(event => event.serverPosition.x >= 15 && event.serverPosition.x < 17 && event.serverPosition.y > 0).map(event => ({ revision: event.serverRevision, source: 'jump-response', atMs: event.at - startAt })),
  ];
  const fullWindow = gateResult === 'timeout' && durationMs >= 5000;
  const serverCoverageComplete = fullWindow && movementResponsesComplete && movementStateResponsesComplete && samplesComplete && hudRevisionStatus === 'linked' && trace.stateErrors === 0;
  const qualifyingRevision = { status: qualifyingStatus(qualifying, serverCoverageComplete),
    revisions: [...new Set(qualifying.map(item => item.revision))], evidence: qualifying };
  assert.ok(qualifyingRevision.status !== 'not_observed' || serverCoverageComplete, 'A negative revision result requires complete trace coverage.');
  const finalState = await jumpTraceState(client.id).catch(() => null);
  const summary = safeJumpTrace({
    spaceKeydown: raw.spaceKeydown, jumpRequested: raw.jumpRequested, firstMoveJump: raw.firstMoveJump,
    firstMoveSkip: raw.firstMoveSkip, firstMoveResult: raw.firstMoveResult, jumpPostResponse: raw.jumpPostResponse,
    serverPlayer: finalState ? { position: finalState.position, velocityY: finalState.velocityY } : null,
  });
  console.log('TUS_JUMP_TRACE ' + JSON.stringify({
    summary,
    window: { result: gateResult, durationMs, fullWindow, qualifyingRevision,
      hudRevisionStatus, hudGateStatus: gateResult === 'airborne' ? (hudGateStateLinked ? 'linked' : 'UNKNOWN') : 'not_observed',
      hudGate: raw.hudGate && Number.isSafeInteger(raw.hudGate.at) ? { atMs: raw.hudGate.at - startAt, x: raw.hudGate.x, y: raw.hudGate.y, z: raw.hudGate.z, uiRevision: raw.hudGate.uiRevision } : null,
      sameRevisionSamples, linkedHudSamples, sampleCount: observations.length, samplesComplete, movementResponsesComplete, movementStateResponsesComplete, jumpResponsesComplete, serverCoverageComplete,
      stateErrors: trace.stateErrors, droppedEvents: raw.droppedEvents ?? null,
      droppedBeforeGate: raw.droppedBeforeGate ?? null, droppedAfterGate: raw.droppedAfterGate ?? null,
      droppedObservations: trace.droppedObservations,
      rafFramesComplete: Number.isSafeInteger(raw.droppedRafFrames) && raw.droppedRafFrames === 0 && Array.isArray(raw.rafFrames) && raw.rafFrames.length > 0,
      droppedRafFrames: raw.droppedRafFrames ?? null,
      rafFrames: (raw.rafFrames ?? []).filter(frame => Number.isSafeInteger(frame.at) && frame.at <= gateBoundaryAt)
        .map(frame => { const safe = safeMovementFrame(frame); return safe && { ...safe, atMs: safe.at - rafStartAt, at: undefined }; }),
      timeline: events.map(event => ({ ...event, atMs: event.at - startAt, at: undefined })),
      postGate: { status: postGateStatus, landingResult, eventCount: postGateEvents.length,
        timeline: postGateEvents.map(event => ({ ...event, afterGateMs: event.at - gateBoundaryAt, at: undefined })) },
      observations: observations.map(item => ({
        atMs: item.at - startAt, serverAtMs: item.state.at - startAt, hudAtMs: item.hud.at - startAt,
        serverRevision: item.state.revision, serverPosition: item.state.position, serverVelocityY: item.state.velocityY,
        hud: { x: item.hud.x, y: item.hud.y, z: item.hud.z, uiRevision: item.hud.uiRevision, revisionMatch: item.state.revision === item.hud.uiRevision },
      })),
      finalState: finalState ? { atMs: finalState.at - startAt, afterWindow: true, revision: finalState.revision, position: finalState.position, velocityY: finalState.velocityY } : null },
  }));
  return { ...summary, qualifyingRevision };
}

const atSolidWallFace = x => Number.isFinite(x) && Number(x.toFixed(2)) >= 14.68 && x <= 14.68 + 1e-7;
assert.equal(atSolidWallFace(14.6765), true, 'the keyed approach reaches the wall face');
assert.equal(atSolidWallFace(14.69), false, 'a position beyond the wall face is rejected');

async function waitForState(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    last = snapshot.players.map(({ id, position, velocityY }) => ({ id, position, velocityY }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description + '; players=' + JSON.stringify(last));
}
async function connect(client) {
  const page = client.page;
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent !== 'Connecting');
  await page.locator('#settings-open').click();
  await page.waitForFunction(() => document.querySelector('#settings').open);
  await page.locator('#server-url').fill(url);
  await page.locator('#token').fill(tokens[client.id]);
  await page.locator('#save-world').click();
  await page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('saved'));
  await page.locator('#settings-close').click();
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('World connected'));
  await page.evaluate(() => document.activeElement?.blur());
  assert.equal(await page.locator('#role').textContent(), 'Role: builder');
}
async function launch(id) {
  const executable = process.env.TUS_SMOKE_EXECUTABLE;
  const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable) } : {}), args: [...(executable ? [] : ['.']), '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--tus-smoke-confirm-quit'], env: { ...process.env, TUS_DATA_DIR: path.join(dir, id) }, timeout: 30000 });
  const client = { id, app }; clients.push(client);
  client.page = await app.firstWindow();
  client.graphics = await observeGraphics(client.page, { label: id });
  await connect(client);
  return client;
}
async function focus(client) {
  await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await client.page.evaluate(() => document.activeElement?.blur());
  await client.page.waitForFunction(() => document.hasFocus() && !document.querySelector('#settings').open);
}
async function select(client, object) { await selectObject(client.page, object); }
async function projectPoint(page, position) {
  return page.evaluate(async value => {
    const THREE = await import('three');
    const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 220);
    camera.position.set(33, 28, 38); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const p = new THREE.Vector3(value.x, value.y, value.z).project(camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  }, position);
}
async function groundPoint(page, position) { return projectPoint(page, { ...position, y: 0 }); }
async function dragObjectTo(page, object, destination, exactPoint = false) {
  const start = await projectPoint(page, object.position), end = exactPoint ? await projectPoint(page, destination) : await groundPoint(page, destination);
  const geometry = await page.evaluate(({ start, end }) => {
    const canvas = document.querySelector('#viewport canvas');
    window.__tusDragTrace = { counts: {}, events: [], last: null };
    if (!canvas.dataset.tusDragTrace) {
      canvas.dataset.tusDragTrace = 'true';
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(type, event => {
        const trace = window.__tusDragTrace, count = trace.counts[type] = (trace.counts[type] || 0) + 1;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const sample = { type, x: Math.round(event.clientX), y: Math.round(event.clientY), target: target?.id || target?.tagName, canvasTarget: target === canvas, selected: document.querySelector('#selection-label')?.textContent, preview: document.querySelector('#move-preview-status')?.textContent, previewHidden: document.querySelector('#move-preview-status')?.hidden };
        trace.last = sample;
        if (type !== 'pointermove' || count <= 2 || count === 100) trace.events.push(sample);
      });
    }
    const at = point => { const target = document.elementFromPoint(point.x, point.y); return { x: Math.round(point.x), y: Math.round(point.y), target: target?.id || target?.tagName, canvasTarget: target === canvas }; };
    const rect = canvas.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, startTarget: at(start), endTarget: at(end) };
  }, { start, end });
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (let i = 1; i <= 100; i++) await page.mouse.move(start.x + (end.x - start.x) * i / 100, start.y + (end.y - start.y) * i / 100);
  await page.mouse.up();
  return { start, end, ...geometry };
}
async function waitForMovePreview(page, drag) {
  try { await page.waitForFunction(() => document.querySelector('#move-preview-status')?.textContent.toLowerCase().includes('preview'), undefined, { timeout: 5000 }); }
  catch {
    const state = await page.evaluate(() => ({
      selected: document.querySelector('#selection-label')?.textContent,
      role: document.querySelector('#role')?.textContent,
      editHidden: document.querySelector('#edit-form')?.hidden,
      editDisabled: document.querySelector('#edit-fields')?.disabled,
      editMessage: document.querySelector('#edit-message')?.textContent,
      preview: document.querySelector('#move-preview-status')?.textContent,
      previewHidden: document.querySelector('#move-preview-status')?.hidden,
      position: ['x', 'y', 'z'].map(axis => document.querySelector('#edit-position-' + axis)?.value),
      trace: window.__tusDragTrace,
    }));
    throw new Error('No local drag preview was created: ' + JSON.stringify({ drag, state }));
  }
}
async function close(client) {
  if (!client.app) return;
  const app = client.app; client.app = null;
  await closeSmokeApp(app, client.graphics, 'shared scenario complete');
}
await withSmokeCleanup(async () => {
  await startServer();
  const alice = await launch('alice'), bob = await launch('bob');
  await focus(alice);
  const ready = await waitForState(snapshot => ['alice', 'bob'].every(id => snapshot.players.some(player => player.id === id)), 'both clients to publish their initial position');
  await Promise.all(clients.map(client => client.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, ready.revision)));

  alice.graphics.phase('agent movement observed by both clients');
  const agentMove = await worldCommand('alice', { type: 'move', position: { x: 12, y: 1, z: 0 } });
  assert.ok(agentMove.position.x > 0 && agentMove.position.x <= 1.25 + 1e-6, JSON.stringify(agentMove.position));
  await alice.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, agentMove.revision);
  const expectedAgentCoordinates = `X ${agentMove.position.x.toFixed(1)} · Y 0.0 · Z 0.0`;
  await alice.page.waitForFunction(text => document.querySelector('#coordinates').textContent === text, expectedAgentCoordinates);
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, agentMove.revision);
  const acceptedAgentPosition = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x === agentMove.position.x, 'the agent move to be visible in the shared state');
  const acceptedAgentX = acceptedAgentPosition.players.find(player => player.id === 'alice').position.x;

  await focus(alice);
  await alice.page.keyboard.down('d');
  let manualMove;
  try {
    manualMove = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x > acceptedAgentX, 'manual movement to continue from the agent position');
  } finally {
    await alice.page.keyboard.up('d');
  }
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, manualMove.revision);
  const observedMove = (await state('bob')).players.find(player => player.id === 'alice');
  assert.ok(observedMove.position.x > acceptedAgentPosition.players.find(player => player.id === 'alice').position.x, 'the second client sees Alice move farther under keyboard control');
  await alice.page.waitForFunction(minimum => Number(document.querySelector('#coordinates').textContent.match(/X ([\d.-]+)/)?.[1]) > minimum, acceptedAgentX);
  alice.graphics.phase('manual shared construction');
  await alice.page.locator('#build-x').fill('16');
  await alice.page.locator('#build-z').fill('0');
  await alice.page.locator('#build-preview').click();
  await alice.page.locator('#build-apply').click();
  await alice.page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('Shape added to the shared world.'));
  const builtState = await state(), built = builtState.objects[0];
  assert.equal(built.ownerId, 'alice');
  assert.deepEqual(built.position, { x: 16, y: 1, z: 0 });

   alice.graphics.phase('shared lamp preview and state');
   const beforeLampPreview=await state();
   await alice.page.locator('[data-kind="lamp"]').click();
   await alice.page.locator('#build-x').fill('2');await alice.page.locator('#build-z').fill('0');
   await alice.page.locator('#build-preview').click();
   assert.equal((await state()).revision,beforeLampPreview.revision,'lamp preview stays local');
   await alice.page.locator('#build-apply').click();
   await alice.page.waitForFunction(()=>document.querySelector('#world-message').textContent.includes('Shape added to the shared world.'));
   let lampState=await state();const lamp=lampState.objects.find(object=>object.type==='lamp');
   assert.ok(lamp);assert.equal(lamp.on,true);assert.equal(lamp.usePolicy,'owner_admin');
   await Promise.all(clients.map(client=>client.page.waitForFunction(revision=>Number(document.querySelector('#revision').textContent.split(' ')[1])>=revision,lampState.revision)));
   await select(alice,lamp);
   await alice.page.locator('#edit-lamp-off').click();
   await alice.page.waitForFunction(()=>document.querySelector('#world-message').textContent.includes('applied'));
   lampState=await waitForState(snapshot=>snapshot.objects.find(object=>object.id===lamp.id)?.on===false,'lamp off state to persist');
   await bob.page.waitForFunction(revision=>Number(document.querySelector('#revision').textContent.split(' ')[1])>=revision,lampState.revision);
   assert.equal((await state('bob')).objects.find(object=>object.id===lamp.id).on,false,'the second client sees the lamp turned off');
   await alice.page.locator('#edit-lamp-on').click();
   await alice.page.waitForFunction(()=>document.querySelector('#world-message').textContent.includes('applied'));
   lampState=await waitForState(snapshot=>snapshot.objects.find(object=>object.id===lamp.id)?.on===true,'lamp on state to persist');
   assert.equal(lampState.objects.find(object=>object.id===lamp.id).version,2);

  alice.graphics.phase('collision and jump onto a walkable top');
  await focus(alice);
  await alice.page.keyboard.down('d');
  let reachedWall;
  try {
    reachedWall = await waitForState(snapshot => atSolidWallFace(snapshot.players.find(player => player.id === 'alice')?.position.x), 'Alice to reach the solid face at normal walking speed');
  } finally {
    await alice.page.keyboard.up('d');
  }
  const blocked = await worldCommand('alice', { type: 'move', position: { x: 30, y: 999, z: 0 } });
  assert.ok(atSolidWallFace(blocked.position.x), 'the server keeps Alice on the solid side');
  assert.equal(blocked.position.y, 0, 'client coordinates cannot grant unsupported height');
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, blocked.revision);
  await alice.page.waitForFunction(() => document.querySelector('#coordinates').textContent.includes('X 14.7'));
  // Movement is time-capped; retry until the server accepts the exact jump setup position.
  let backoff;
  for (let attempt = 0; attempt < 20; attempt++) {
    backoff = await worldCommand('alice', { type: 'move', position: { x: 14.4, y: 0, z: 0 } });
    if (backoff.position.x === 14.4) break;
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(backoff.position.x, 14.4, 'the jump setup places Alice close to the platform without frame-rate-dependent keyboard overshoot');
  assert.equal(backoff.position.y, 0);
  await Promise.all(clients.map(client => client.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, backoff.revision)));
  let lastBackoffPosition = '', stableBackoffSamples = 0;
  const jumpStart = await waitForState(snapshot => {
    const player = snapshot.players.find(player => player.id === 'alice');
    if (!player || player.position.x !== 14.4 || player.position.y !== 0 || player.velocityY !== 0) {
      stableBackoffSamples = 0;
      lastBackoffPosition = '';
      return false;
    }
    const current = JSON.stringify({ position: player.position, velocityY: player.velocityY });
    stableBackoffSamples = current === lastBackoffPosition ? stableBackoffSamples + 1 : 0;
    lastBackoffPosition = current;
    return stableBackoffSamples >= 5;
  }, 'Alice server position to settle at the grounded jump start');
  await alice.page.waitForFunction(expected => {
    const [xPart, yPart] = document.querySelector('#coordinates')?.textContent.split(' · ') ?? [];
    return Number(xPart?.slice(2)) === Number(expected.x.toFixed(1)) && Number(yPart?.slice(2)) === 0;
  }, jumpStart.players.find(player => player.id === 'alice').position, { polling: 'raf', timeout: 10000 });
  await focus(alice);
  const jumpTrace = await installJumpTrace(alice);
  await alice.page.keyboard.up('d');
  await alice.page.keyboard.down('d');
  await alice.page.keyboard.down('Space');
  await startJumpTraceWindow(alice, jumpTrace);
  let gateAt, gateResult = 'timeout';
  try {
    await alice.page.waitForFunction(() => {
      const parts = document.querySelector('#coordinates')?.textContent.split(' · ');
      const x = Number(parts?.[0]?.slice(2)), y = Number(parts?.[1]?.slice(2)), z = Number(parts?.[2]?.slice(2));
      const qualifies = Number.isFinite(x) && Number.isFinite(y) && x >= 15 && x < 17 && y > 0;
      const trace = window.__TUS_SMOKE_JUMP_TRACE_STATE;
      if (qualifies && trace && trace.hudGate === null) {
        const at = Date.now(), revision = /^REV (\d+)$/.exec(document.querySelector('#revision')?.textContent || '');
        trace.gateAt = at;
        trace.hudGate = { at, x, y, z, uiRevision: revision && Number.isSafeInteger(Number(revision[1])) ? Number(revision[1]) : null };
      }
      return qualifies;
    }, undefined, { polling: 'raf', timeout: 5000 });
    gateResult = 'airborne';
  } catch {
    gateResult = 'timeout';
  } finally {
    gateAt = Date.now();
    await stopJumpTraceWindow(alice, jumpTrace, gateAt);
    await alice.page.keyboard.up('Space');
    await alice.page.keyboard.up('d');
  }
  if (gateResult === 'timeout') {
    const trace = await reportJumpTrace(alice, jumpTrace, gateResult, gateAt, jumpStart, 'not-reached');
    await alice.page.evaluate(() => { delete window.__TUS_SMOKE_JUMP_TRACE; delete window.__TUS_SMOKE_JUMP_TRACE_STATE; }).catch(() => {});
    assert.equal(trace.spaceKeydown, true, 'Space keydown trace is missing');
    assert.equal(trace.jumpRequested, true, 'local jumpRequested trace is missing');
    assert.equal(typeof trace.firstMoveJump, 'boolean', 'first move.jump trace is missing');
    throw new Error('Shared-world jump did not reach airborne acceptance within the existing 5000ms timeout.');
  }
  let landed, landingResult = 'failed';
  try {
    await alice.page.waitForFunction(() => {
      const yPart = document.querySelector('#coordinates')?.textContent.split(' · ')[1];
      return Number(yPart?.slice(2)) > 0;
    }, undefined, { polling: 'raf', timeout: 5000 });
    landed = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.y === 2, 'Alice to land on the supported object top');
    landingResult = 'landed';
  } finally {
    await reportJumpTrace(alice, jumpTrace, gateResult, gateAt, jumpStart, landingResult);
    await alice.page.evaluate(() => {
      delete window.__TUS_SMOKE_JUMP_TRACE;
      delete window.__TUS_SMOKE_JUMP_TRACE_STATE;
    }).catch(() => {});
  }
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, landed.revision);
  assert.equal((await state('bob')).players.find(player => player.id === 'alice').position.y, 2, 'the second client observes the accepted height');
  await alice.page.waitForFunction(() => document.querySelector('#coordinates').textContent.includes('Y 2.0'), undefined, { timeout: 5000 });
  // Drag stays local until Apply; the second client must never see the preview.
  await focus(alice);
  await alice.page.keyboard.down('a');
  await waitForState(snapshot => {
    const player = snapshot.players.find(item => item.id === 'alice');
    return player?.position.y === 0 && player.position.x < 14;
  }, 'Alice to leave the platform before moving it');
  await alice.page.keyboard.up('a');
  // Renderer movement sync runs every 250 ms; wait across two ticks after keyup.
  let lastStoppedSnapshot = '', stableSamples = 0;
  const beforePreview = await waitForState(snapshot => {
    const current = `${snapshot.revision}:${JSON.stringify(snapshot.players)}`;
    stableSamples = current === lastStoppedSnapshot ? stableSamples + 1 : 0;
    lastStoppedSnapshot = current;
    return stableSamples >= 5;
  }, 'Alice movement to settle before the local preview');
  await select(alice, built);
  await alice.page.locator('#move-grid-step').fill('0.5');
  await alice.page.locator('#move-plane').selectOption('x');
  const firstDrag = await dragObjectTo(alice.page, built, { x: 20.2, y: 1, z: 0 }, true);
  assert.equal(firstDrag.startTarget.canvasTarget, true, 'drag begins on a world object in the canvas');
  assert.equal(firstDrag.endTarget.canvasTarget, false, 'drag continues to a target covered by the UI');
  await waitForMovePreview(alice.page, firstDrag);
  assert.deepEqual(await alice.page.locator('#edit-position-x').inputValue().then(async x => ({ x: Number(x), y: Number(await alice.page.locator('#edit-position-y').inputValue()), z: Number(await alice.page.locator('#edit-position-z').inputValue()) })), { x: 20, y: 1, z: 0 }, 'the visible 0.5 grid snaps an X-axis drag without changing other coordinates');
  const previewState = await state();
  assert.equal(previewState.revision, beforePreview.revision,
    `pointer movement and preview do not mutate the server: ${JSON.stringify({
      before: { revision: beforePreview.revision, players: beforePreview.players.map(({ id, position, velocityY }) => ({ id, position, velocityY })) },
      after: { revision: previewState.revision, players: previewState.players.map(({ id, position, velocityY }) => ({ id, position, velocityY })) },
    })}`);
  assert.deepEqual(previewState.objects, beforePreview.objects);
  assert.equal(await bob.page.locator('#move-preview-status').isHidden(), true, 'the peer does not receive the local preview');
  await alice.page.evaluate(() => {
    window.__tusEscapeEvent = null;
    window.addEventListener('keydown', event => { if (event.code === 'Escape') window.__tusEscapeEvent = event; }, { capture: true, once: true });
  });
  await focus(alice);
  await alice.page.keyboard.press('Escape');
  try { await alice.page.waitForFunction(() => document.querySelector('#move-preview-status')?.hidden, undefined, { timeout: 5000 }); }
  catch {
    const escapeState = await alice.page.evaluate(() => ({
      event: window.__tusEscapeEvent && { code: window.__tusEscapeEvent.code, defaultPrevented: window.__tusEscapeEvent.defaultPrevented },
      hasFocus: document.hasFocus(),
      activeElement: document.activeElement?.id || document.activeElement?.tagName,
      preview: document.querySelector('#move-preview-status')?.textContent,
      previewHidden: document.querySelector('#move-preview-status')?.hidden,
    }));
    throw new Error('Escape did not cancel local preview: ' + JSON.stringify(escapeState));
  }
  assert.equal((await state()).revision, beforePreview.revision, 'Cancel discards only the local proposal');

  await alice.page.locator('#move-snap-enabled').uncheck();
  const unsnappedDrag = await dragObjectTo(alice.page, built, { x: 20.2, y: 1, z: 0 }, true);
  await waitForMovePreview(alice.page, unsnappedDrag);
  const unsnappedX = Number(await alice.page.locator('#edit-position-x').inputValue());
  assert.ok(Math.abs(unsnappedX - 20.2) < 1e-6, 'disabling snap preserves exact pointer position');
  await alice.page.locator('#move-cancel').click();
  await alice.page.waitForFunction(() => document.querySelector('#move-preview-status')?.hidden);
  assert.equal((await state()).revision, beforePreview.revision, 'Cancel button discards only the local proposal');
  await alice.page.locator('#move-snap-enabled').check();

  await alice.page.locator('#move-plane').selectOption('xz');
  const secondDrag = await dragObjectTo(alice.page, built, { x: 20, z: 10 });
  await waitForMovePreview(alice.page, secondDrag);
  assert.equal((await state()).revision, beforePreview.revision);
  await alice.page.locator('#edit-apply').click();
  await alice.page.waitForFunction(() => document.querySelector('#edit-message').textContent.includes('saved'));
  const movedState = await state();
  const movedObject = movedState.objects.find(item => item.id === built.id);
  assert.deepEqual(movedObject.position, { x: 20, y: 1, z: 10 });
  assert.equal(movedState.revision, beforePreview.revision + 1, 'Apply commits exactly one update');
  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, movedState.revision);
  built.position = movedObject.position;

  await bob.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, builtState.revision);
  await select(alice, built); await select(bob, built);
  assert.equal(await bob.page.locator('#edit-apply').isDisabled(), true, 'foreign object is read-only');
  assert.equal(await bob.page.locator('#remove').isDisabled(), true, 'foreign removal is disabled');
  await alice.page.locator('#edit-size-x').fill('5');
  await alice.page.locator('#edit-apply').click();
  await alice.page.waitForFunction(() => document.querySelector('#edit-message').textContent.includes('saved'));
  await bob.page.waitForFunction(() => document.querySelector('#edit-size-x').value === '5');
  assert.equal((await state('bob')).objects[0].size.x, 5);
  const denied = await fetch(url + '/command', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.bob, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'remove', id: built.id }) });
  assert.equal(denied.status, 403, 'server rejects bypassing the disabled UI');
  const beforeRestart = await state();
  assert.equal(beforeRestart.objects[0].id, built.id);
  assert.equal(beforeRestart.objects.find(object=>object.id===lamp.id).on,true,'the live lamp state remains shared before server restart');

  for (const client of clients) { client.graphics.phase('server restart'); await client.graphics.assertHealthy(); }
  await stopServer();
  for (const client of clients) await client.page.waitForFunction(() => document.querySelector('#connection').textContent.includes('offline'));
  await startServer();
  for (const client of clients) await client.page.waitForFunction(() => document.querySelector('#connection').textContent.includes('World connected'));
  const restored = await state('bob');
  assert.equal(restored.objects[0].id, built.id); assert.equal(restored.objects[0].size.x, 5);
  assert.equal(restored.objects.find(object=>object.id===lamp.id).on,true,'lamp state persists across server restart');
  assert.deepEqual(restored.players.find(player => player.id === 'alice').position, beforeRestart.players.find(player => player.id === 'alice').position, 'server restart preserves the last accepted player position');
  assert.deepEqual(restored.players.map(p => p.id).sort(), ['alice', 'bob']);
  await close(bob);
  const returning = await launch('bob');
  await returning.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, restored.revision);
  await select(returning, restored.objects[0]);
  assert.equal(await returning.page.locator('#edit-size-x').inputValue(), '5');

  alice.graphics.phase('manual removal');
  await alice.page.locator('#remove').click();
  await alice.page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('removed'));
  await returning.page.waitForFunction(() => document.querySelector('#selection-label').textContent === 'No shape selected');
  assert.equal((await state('bob')).objects.length, 1);
  await select(alice,lamp);await alice.page.locator('#remove').click();
  const removedLamp=await waitForState(snapshot=>snapshot.objects.length===0,'the lamp removal to reach shared state');
  await Promise.all([alice,returning].map(client=>client.page.waitForFunction(revision=>Number(document.querySelector('#revision').textContent.split(' ')[1])>=revision,removedLamp.revision)));
  assert.equal((await state('bob')).objects.length,0,'the removed lamp is absent from the shared world');
  for (const id of ['alice', 'bob']) {
    const settings = JSON.parse(await readFile(path.join(dir, id, 'settings.json'), 'utf8'));
    assert.equal(Object.hasOwn(settings, 'token'), false);
  }
  alice.graphics.phase('shared island boundary');
  await focus(alice);
  await alice.page.keyboard.down('d');
  let atEdge;
  try {
    atEdge = await waitForState(snapshot => snapshot.players.find(player => player.id === 'alice')?.position.x >= 23.68 - 1e-6, 'Alice to reach the island edge at normal walking speed');
  } finally {
    await alice.page.keyboard.up('d');
  }
  const edgePosition = atEdge.players.find(player => player.id === 'alice').position;
  assert.ok(edgePosition.x >= 23.68 - 1e-6 && edgePosition.x <= 23.68 + 1e-6, JSON.stringify(edgePosition));
  await returning.page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, atEdge.revision);
  const outwardMove = await worldCommand('alice', { type: 'move', position: { x: 1000, y: 999, z: 0 } });
  assert.deepEqual(outwardMove.position, edgePosition, 'an agent target beyond the island cannot move Alice past its edge');
  await Promise.all([alice.page, returning.page].map(page => page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, outwardMove.revision)));
  const [aliceEdge, bobEdge] = await Promise.all([state('alice'), state('bob')]);
  assert.deepEqual(aliceEdge.players.find(player => player.id === 'alice').position, outwardMove.position);
  assert.deepEqual(bobEdge.players.find(player => player.id === 'alice').position, outwardMove.position);

  const beforeDisconnect = await state('alice');
  const savedBobPosition = structuredClone(beforeDisconnect.players.find(player => player.id === 'bob').position);
  assert.ok(beforeDisconnect.onlinePlayerIds.includes('bob'), 'Bob is present before disconnect');
  const closedClientIndex = clients.indexOf(returning);
  await close(returning);
  clients.splice(closedClientIndex, 1);
  const offlineBob = await waitForState(snapshot => Array.isArray(snapshot.onlinePlayerIds) && !snapshot.onlinePlayerIds.includes('bob'), 'Bob to disappear after disconnect', 15000);
  assert.ok(offlineBob.players.some(player => player.id === 'bob'), 'offline player data remains saved');
  assert.deepEqual(offlineBob.players.find(player => player.id === 'bob').position, savedBobPosition, 'disconnect preserves Bob’s last position');
  const reconnectedBob = await launch('bob');
  await waitForState(snapshot => snapshot.onlinePlayerIds.includes('bob'), 'Bob to reconnect');
  assert.deepEqual((await state('alice')).players.find(player => player.id === 'bob').position, savedBobPosition, 'reconnect restores Bob at his saved position');
  await reconnectedBob.graphics.assertHealthy();

  console.log('Shared-world acceptance passed: two real clients, UI build/select/edit/remove, owner permissions, server and client restart, shared persistence.');
}, ...[() => Promise.allSettled(clients.map(close)).then(results => {
  const failures = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (failures.length) throw new AggregateError(failures, 'Client cleanup failed');
}), () => stopServer(), () => rm(dir, { recursive: true, force: true })]);
