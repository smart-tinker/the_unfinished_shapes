import assert from 'node:assert/strict';

// Product acceptance: every genuine valid construction is executed, including
// repeated identical requests. This does not measure model instruction fidelity.
export function assertBuildAcceptance({events, state, design, ownerId}) {
  assert.ok(Array.isArray(events), 'Missing real tool-call records.');
  const commands = events.filter(event => event.name !== 'world_state');
  assert.ok(commands.length >= 1, 'Expected at least one genuine model-issued construction.');
  for (const command of commands) {
    assert.equal(command.name, 'world_build', 'Unexpected non-construction tool call.');
    assert.equal(command.success, true, 'Real-model construction did not succeed.');
    assert.deepEqual(command.arguments, design, 'Model changed or omitted supplied build parameters.');
  }
  assert.ok(Array.isArray(state?.objects), 'Missing persisted objects.');
  assert.equal(state.objects.length, commands.length, 'Persisted object count must equal successful valid construction calls.');
  const ids = new Set();
  for (const object of state.objects) {
    assert.ok(typeof object.id === 'string' && object.id.length > 0, 'Persisted object must have an ID.');
    assert.ok(!ids.has(object.id), 'Persisted object IDs must be unique.');
    ids.add(object.id);
    assert.equal(object.type, design.objectType);
    assert.equal(object.ownerId, ownerId);
    assert.deepEqual(object.position, design.position);
    assert.deepEqual(object.size, design.size);
    assert.equal(object.color, design.color);
  }
  return { constructionCalls: commands.length, persistedObjects: state.objects.length };
}
