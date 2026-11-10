function snap(value, step) {
  return step === 0 ? value : Number((Math.round(value / step) * step).toFixed(6));
}
export function placementPosition(point, object, surface = null, gridStep = 1) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z) || !object?.size || !Number.isFinite(object.size.y) || object.size.y < .25) {
    throw new TypeError('A finite pointer position and valid object height are required.');
  }
  if (!Number.isFinite(gridStep) || gridStep < 0) throw new RangeError('Grid step must be zero or a positive finite number.');
  const top = surface?.supportsPlayer ? surface.position?.y + surface.size?.y / 2 : 0;
  if (!Number.isFinite(top)) throw new TypeError('A supporting surface must have a finite top.');
  return { x: snap(point.x, gridStep), y: top + object.size.y / 2, z: snap(point.z, gridStep) };
}
export function positionUpdateCommand(object, position) {
  if (!object || typeof object.id !== 'string' || !object.position || !position) throw new TypeError('An object and its proposed position are required.');
  return { type: 'update', id: object.id, position: structuredClone(position), expected: { position: structuredClone(object.position) } };
}
