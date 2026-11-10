import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings, agentModelForThread } from '../src/settings.mjs';

test('agent model selection is stored only as non-secret settings and bound to one conversation', () => {
  const saved = cleanSettings({
    threadId: 'thread-a',
    agentControlThreadId: 'thread-a',
    agentModelId: 'qwen3-local-cpu',
    agentEffort: 'medium',
    token: 'must-not-persist',
    apiKey: 'must-not-persist',
  });
  assert.equal(saved.agentModelId, 'qwen3-local-cpu');
  assert.equal(saved.agentEffort, 'medium');
  assert.equal(saved.agentControlThreadId, 'thread-a');
  assert.equal('token' in saved, false);
  assert.equal('apiKey' in saved, false);
  assert.deepEqual(agentModelForThread(saved, 'thread-a'), { model: 'qwen3-local-cpu', effort: 'medium' });
  assert.equal(agentModelForThread(saved, 'thread-b'), null);
});

test('legacy settings load without model selection and malformed bindings are rejected', () => {
  assert.equal(agentModelForThread(cleanSettings({ threadId: 'legacy-thread' }), 'legacy-thread'), null);
  assert.throws(() => cleanSettings({ agentModelId: 'qwen3-local-cpu' }), /conversation/i);
  assert.throws(() => cleanSettings({ agentEffort: 'medium', agentControlThreadId: 'thread-a' }), /model/i);
  assert.throws(() => cleanSettings({ agentModelId: 42, agentControlThreadId: 'thread-a' }), /agentModelId/i);
});
