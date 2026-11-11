import assert from 'node:assert/strict';

export function assertBuildAcceptance({events, state, design, ownerId}) {
  assert.ok(Array.isArray(events), 'Missing real tool-call records.');
  const actions = events.filter(event => event.name !== 'world_state');
  assert.equal(actions.length, 2, 'Expected one preview and one approved Apply.');
  const [preview, apply] = actions;
  assert.equal(preview.name, 'world_preview');
  assert.equal(preview.success, true, 'Real-model preview did not succeed.');
  assert.deepEqual(preview.arguments, {objects:[design]}, 'Model changed or omitted supplied design fields.');
  assert.equal(typeof preview.value?.previewId, 'string');
  assert.deepEqual(preview.value.objects, [design]);
  assert.equal(apply.name, 'world_apply');
  assert.equal(apply.success, true, 'The approved construction did not succeed.');
  assert.deepEqual(apply.arguments, {previewId:preview.value.previewId});
  assert.ok(Number.isSafeInteger(apply.value?.revision), 'Missing server revision for Apply.');
  assert.ok(Array.isArray(apply.value?.objects));
  assert.equal(apply.value.objects.length, 1);
  assert.ok(Array.isArray(state?.objects), 'Missing persisted objects.');
  assert.equal(state.objects.length, 1, 'The approved set must persist exactly once.');
  assert.deepEqual(state.objects, apply.value.objects, 'Persisted state must match the server-confirmed Apply result.');
  const object = state.objects[0];
  assert.ok(typeof object.id === 'string' && object.id.length > 0, 'Persisted object must have an ID.');
  assert.equal(object.type, design.objectType);
  assert.equal(object.ownerId, ownerId);
  assert.deepEqual(object.position, design.position);
  assert.deepEqual(object.size, design.size);
  assert.equal(object.color, design.color);
  return {constructionCalls:1,persistedObjects:1};
}
