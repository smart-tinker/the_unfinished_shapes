import assert from 'node:assert/strict';

export async function selectObject(page, object) {
  // Wait for scene transforms to reach a rendered frame before raycasting the fixture.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // A real pointer click at the fixture's projection in the initial camera.
  const point = await page.evaluate(async position => {
    const THREE = await import('three');
    const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 220);
    camera.position.set(33, 28, 38); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const p = new THREE.Vector3(position.x, position.y, position.z).project(camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  }, object.position);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(id => document.querySelector('#selection-label').textContent.includes(id.slice(0, 12)), object.id);
}
export async function manualEditing(page) {
  const state = () => page.evaluate(async () => {
    const settings = await window.tus.loadSettings();
    return window.tus.request({ ...settings, path: '/state' });
  });
  const before = await state();
  await page.locator('[data-kind="block"]').click();
  await page.locator('#build-x').fill('3');
  await page.locator('#build-z').fill('4');
  await page.locator('#build-form button').click();
  await page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('Block placed'));
  const built = await state();
  assert.equal(built.objects.length, before.objects.length + 1);
  const object = built.objects.find(o => !before.objects.some(old => old.id === o.id));
  assert.ok(object); assert.equal(object.ownerId, built.me.id);
  await page.waitForFunction(revision => Number(document.querySelector('#revision').textContent.split(' ')[1]) >= revision, built.revision);
  await selectObject(page, object);
  await page.locator('#edit-size-x').fill('5');
  await page.locator('#edit-apply').click();
  await page.waitForFunction(() => document.querySelector('#edit-message').textContent.includes('saved'));
  assert.equal((await state()).objects.find(o => o.id === object.id).size.x, 5);
  await page.locator('#remove').click();
  await page.waitForFunction(() => document.querySelector('#world-message').textContent.includes('removed'));
  assert.deepEqual((await state()).objects, before.objects, 'manual removal preserves all pre-existing objects');
  assert.equal(await page.locator('#selection-label').textContent(), 'No shape selected');
}
