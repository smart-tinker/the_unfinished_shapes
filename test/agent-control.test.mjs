import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { realpath } from 'node:fs/promises';
import { CodexBridge } from '../src/codex.mjs';

const cwd = await realpath(process.cwd());
function fixture(handler = () => undefined) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const requests = [];
  const reply = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line); requests.push(message);
      if (!message.method || !('id' in message)) continue;
      const override = handler(message, reply);
      if (override === false) continue;
      const defaults = {
        initialize: { serverInfo: { name: 'codex', version: '0.167.0' } },
        'thread/list': { data: [], nextCursor: null },
        'thread/start': { thread: { id: 'game-thread', cwd, status: { type: 'idle' } } },
        'thread/read': { thread: { id: message.params.threadId, cwd, status: { type: 'idle' }, model: 'qwen3-local-cpu', reasoningEffort: 'medium' } },
        'model/list': { data: [{ id: 'qwen3-local-cpu', model: 'qwen3', displayName: 'Local Qwen', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }] },
        'thread/goal/get': { goal: null },
        'thread/goal/set': { goal: { threadId: message.params.threadId, objective: message.params.objective ?? 'Build a world', status: message.params.status ?? 'active' } },
        'thread/goal/clear': {},
        'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } },
        'turn/interrupt': {},
      };
      const result = override ?? defaults[message.method] ?? {};
      queueMicrotask(() => reply({ id: message.id, result }));
    }
  });
  const bridge = new CodexBridge({ timeoutMs: 800, spawnProcess: (executable, args) => {
    assert.equal(executable, process.execPath); assert.deepEqual(args, ['app-server']); return child;
  }});
  return { bridge, requests, child, reply, start: extra => bridge.start({ codexPath: process.execPath, workspacePath: cwd, ...extra }) };
}

test('agent status is read-only and reports native runtime, model catalog, and Goal capability', async () => {
  const f = fixture(); await f.start({ newGameThread: true });
  const state = await f.bridge.readControlState();
  assert.equal(state.threadId, 'game-thread');
  assert.equal(state.runtime.version, '0.167.0');
  assert.equal(state.goalSupported, true);
  assert.equal(state.models[0].id, 'qwen3-local-cpu');
  assert.equal(state.goal, null);
  assert.equal(f.requests.some(request => request.method === 'experimentalFeature/list'), false);
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  assert.equal(f.requests.some(request => request.method === 'thread/goal/set'), false);
  f.bridge.stop();
});

test('creates one real native Goal with the user objective and completion criterion', async () => {
  const f = fixture(); await f.start({ newGameThread: true });
  await f.bridge.createGoal({ objective: 'Build a bridge', completionCriteria: 'Two players can cross it.' });
  const call = f.requests.find(request => request.method === 'thread/goal/set');
  assert.equal(call.params.threadId, 'game-thread');
  assert.equal(call.params.origin, 'user');
  assert.equal(call.params.status, 'active');
  assert.match(call.params.objective, /Build a bridge/);
  assert.match(call.params.objective, /Two players can cross it\./);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 0);
  f.bridge.stop();
});

test('does not replace an existing native Goal', async () => {
  const f = fixture(message => message.method === 'thread/goal/get' ? { goal: { threadId: 'game-thread', objective: 'Existing', status: 'active' } } : undefined);
  await f.start({ newGameThread: true });
  await assert.rejects(f.bridge.createGoal({ objective: 'New', completionCriteria: 'Done' }), /already exists/i);
  assert.equal(f.requests.some(request => request.method === 'thread/goal/set'), false);
  f.bridge.stop();
});

test('pause, resume, clear Goal use native methods and stay distinct from interrupting a turn', async () => {
  const f = fixture(message => {
    if (message.method === 'thread/goal/get') return { goal: { threadId: 'game-thread', objective: 'Build', status: 'active' } };
    if (message.method === 'thread/goal/set') return { goal: { threadId: 'game-thread', objective: 'Build', status: message.params.status } };
  });
  await f.start({ newGameThread: true });
  await f.bridge.pauseGoal();
  await f.bridge.resumeGoal();
  await f.bridge.clearGoal();
  assert.deepEqual(f.requests.filter(request => request.method === 'thread/goal/set').map(request => request.params.status), ['paused', 'active']);
  assert.equal(f.requests.filter(request => request.method === 'thread/goal/clear').length, 1);
  assert.equal(f.requests.some(request => request.method === 'turn/interrupt'), false);
  f.bridge.stop();
});

test('model and reasoning overrides apply to the next turn only', async () => {
  const f = fixture(); await f.start({ newGameThread: true });
  await f.bridge.send('Build a bridge', { model: 'qwen3-local-cpu', effort: 'medium' });
  const call = f.requests.find(request => request.method === 'turn/start');
  assert.equal(call.params.model, 'qwen3-local-cpu');
  assert.equal(call.params.effort, 'medium');
  assert.equal(call.params.threadId, 'game-thread');
  f.bridge.stop();
});

test('unsupported native Goals are detected by the native method, not experimentalFeature/list', async () => {
  const f = fixture((message, reply) => {
    if (message.method !== 'thread/goal/get') return undefined;
    reply({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    return false;
  });
  await f.start({ newGameThread: true });
  const state = await f.bridge.readControlState();
  assert.equal(state.goalSupported, false);
  assert.equal(state.goalReason, 'Native Goals are not supported by this Codex runtime.');
  assert.equal(f.requests.some(request => request.method === 'experimentalFeature/list'), false);
  await assert.rejects(f.bridge.createGoal({ objective: 'Build', completionCriteria: 'Done' }), /not supported/i);
  assert.equal(f.requests.some(request => request.method === 'thread/goal/set'), false);
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  f.bridge.stop();
});

test('ephemeral conversations report Goals unavailable, while unrelated API errors stay unknown', async () => {
  const ephemeral = fixture((message, reply) => {
    if (message.method !== 'thread/goal/get') return undefined;
    reply({ id: message.id, error: { code: -32600, message: 'ephemeral thread does not support goals: game-thread' } });
    return false;
  });
  await ephemeral.start({ newGameThread: true });
  const ephemeralState = await ephemeral.bridge.readControlState();
  assert.equal(ephemeralState.goalSupported, false);
  assert.equal(ephemeralState.goalReason, 'This conversation cannot store native Goals.');
  await assert.rejects(ephemeral.bridge.createGoal({ objective: 'Build', completionCriteria: 'Done' }), /cannot store/i);
  assert.equal(ephemeral.requests.some(request => request.method === 'thread/goal/set'), false);
  ephemeral.bridge.stop();

  const unavailable = fixture((message, reply) => {
    if (message.method !== 'thread/goal/get') return undefined;
    reply({ id: message.id, error: { code: -32000, message: 'Temporary server error' } });
    return false;
  });
  await unavailable.start({ newGameThread: true });
  const unavailableState = await unavailable.bridge.readControlState();
  assert.equal(unavailableState.goalSupported, null);
  assert.equal(unavailableState.goalReason, 'Could not verify native Goal support.');
  await assert.rejects(unavailable.bridge.createGoal({ objective: 'Build', completionCriteria: 'Done' }), /could not verify/i);
  assert.equal(unavailable.requests.some(request => request.method === 'thread/goal/set'), false);
  unavailable.bridge.stop();
});

test('does not send with a different conversation if the model catalog resolves after context changes', async () => {
  let catalogRequest;
  const f = fixture(message => {
    if (message.method === 'model/list') { catalogRequest = message; return false; }
  });
  await f.start({ newGameThread: true });
  const sending = f.bridge.send('Build a bridge', { model: 'qwen3-local-cpu', effort: 'medium' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(catalogRequest);
  f.bridge.threadId = 'replacement-thread';
  f.reply({ id: catalogRequest.id, result: { data: [{ id: 'qwen3-local-cpu', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] } });
  await assert.rejects(sending, /conversation changed/i);
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  f.bridge.stop();
});

test('clearing a native Goal records an explicit user mutation', async () => {
  const f = fixture(message => {
    if (message.method === 'thread/goal/get') return { goal: { threadId: 'game-thread', objective: 'Build', status: 'paused' } };
  });
  await f.start({ newGameThread: true });
  await f.bridge.clearGoal();
  const clear = f.requests.find(request => request.method === 'thread/goal/clear');
  assert.equal(clear.params.origin, 'user');
  f.bridge.stop();
});
