function snap(value, step) {
  return step === 0 ? value : Number((Math.round(value / step) * step).toFixed(6));
}
export function placementPosition(point, object, surface = null, gridStep = 1, plane = 'xz') {
  const axes = { xz: ['x', 'z'], xy: ['x', 'y'], yz: ['y', 'z'], x: ['x'], y: ['y'], z: ['z'] }[plane];
  if (!axes) throw new RangeError('Drag plane must be xz, xy, or yz.');
  if (!point || axes.some(axis => !Number.isFinite(point[axis])) || !object?.position || !object?.size || !Number.isFinite(object.size.y) || object.size.y < .25) {
    throw new TypeError('A finite pointer position and valid object dimensions are required.');
  }
  if (!Number.isFinite(gridStep) || gridStep < 0) throw new RangeError('Grid step must be zero or a positive finite number.');
  if (plane === 'xz') {
    const top = surface?.supportsPlayer ? surface.position?.y + surface.size?.y / 2 : 0;
    if (!Number.isFinite(top)) throw new TypeError('A supporting surface must have a finite top.');
    return { x: snap(point.x, gridStep), y: top + object.size.y / 2, z: snap(point.z, gridStep) };
  }
  const fixed = ['x', 'y', 'z'].filter(axis => !axes.includes(axis));
  if (fixed.some(axis => !Number.isFinite(object.position[axis]))) throw new TypeError('Fixed coordinates must be finite.');
  return Object.fromEntries(['x', 'y', 'z'].map(axis => [
    axis, axes.includes(axis) ? snap(point[axis], gridStep) : object.position[axis],
  ]));
}
export function positionUpdateCommand(object, position) {
  if (!object || typeof object.id !== 'string' || !object.position || !position) throw new TypeError('An object and its proposed position are required.');
  return { type: 'update', id: object.id, position: structuredClone(position), expected: { position: structuredClone(object.position) } };
}
