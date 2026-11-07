import assert from 'node:assert/strict';
export function assertLegacySnapshot(saved, objects, built, fixture) {
 for (const key of ['workspacePath','codexPath','threadId']) assert.equal(saved[key],fixture[key],`RC1 persisted ${key}`);
 assert.equal(saved.serverUrl,'');assert.equal('token' in saved,false);
 assert.ok(built?.id);assert.equal(built.type,'bridge');assert.deepEqual(built.position,{x:7,y:1,z:0});
 assert.deepEqual(objects,[built],'RC1 persisted exact server-created object');
}
// Adapt only the external recovery harness, never the immutable candidate.
export function recoveryInstallerSmoke(source) {
 let script=source.replace(/\r\n/g,'\n');
 const replace=(old,next)=>{assert.equal(script.split(old).length,2,`Expected one exact recovery transform: ${old.slice(0,90)}`);script=script.replace(old,next);};
 replace('async function launch(executablePath) {', 'let verifiedLegacyExe; let rc3LaunchCount = 0;\nasync function launch(executablePath) {');
 replace('  const page = await instance.firstWindow();', `  const legacy = verifiedLegacyExe && executablePath === verifiedLegacyExe;
  const stage = legacy ? 'rc1-fixture' : ['clean-rc3', 'migrated-rc3', 'reinstall-rc3'][rc3LaunchCount++] || 'unexpected-rc3-launch';
  const graphicsObserver = legacy ? null : await observeInstallerLaunch(instance, stage);
  const page = await instance.firstWindow();
  await graphicsObserver?.attachPage(page);`);
 replace("  await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'), null, { timeout: 30000 });\n  assert.equal(await page.locator('#scene-error').isVisible(), false, 'WebGL scene must render');",`  if (verifiedLegacyExe && executablePath === verifiedLegacyExe) {
    // RC1 supplies real migration data, not graphics acceptance for this release.
    await page.waitForFunction(() => typeof window.tus?.loadSettings === 'function' && typeof window.tus?.request === 'function', null, { timeout: 30000 });
    await page.evaluate(async () => { const s = await window.tus.loadSettings(); const state = await window.tus.request({ ...s, path: '/state' }); if (!Array.isArray(state.objects)) throw Error('RC1 world IPC unavailable'); });
  } else {
    await graphicsObserver.verify(() => assertSmokeGraphics(page, process.platform));
  }`);
 replace("  page = await launch(path.join(extracted, 'TheUnfinishedShapes-win32-x64', 'TheUnfinishedShapes.exe'));",`  verifiedLegacyExe = path.join(extracted, 'TheUnfinishedShapes-win32-x64', 'TheUnfinishedShapes.exe');
  page = await launch(verifiedLegacyExe);`);
 replace('  await page.evaluate(async fixture => {', '  const legacyBuilt = await page.evaluate(async fixture => {');
 replace("    await window.tus.request({ ...s, path: '/command', method: 'POST', body: { type: 'build', objectType: 'bridge', position: { x: 7, y: 1, z: 0 } } });", "    return window.tus.request({ ...s, path: '/command', method: 'POST', body: { type: 'build', objectType: 'bridge', position: { x: 7, y: 1, z: 0 } } });");
 replace("  }, settingsFixture);\n  await close();",`  }, settingsFixture);
  assert.ok(legacyBuilt.object?.id, 'RC1 must return a real created object');
  assert.equal(legacyBuilt.object.type, 'bridge');
  assert.deepEqual(legacyBuilt.object.position, { x: 7, y: 1, z: 0 });
  async function verifyLegacyDisk() {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    const world = JSON.parse(await readFile(path.join(dataDir, 'world.json'), 'utf8'));
    assertLegacySnapshot(saved, world.objects, legacyBuilt.object, settingsFixture);
  }
  async function verifyLegacyIPC(page) {
    const actual = await page.evaluate(async () => { const s = await window.tus.loadSettings(); const world = await window.tus.request({ ...s, path: '/state' }); return { workspacePath: s.workspacePath, codexPath: s.codexPath, threadId: s.threadId, objects: world.objects }; });
    for (const key of ['workspacePath', 'codexPath', 'threadId']) assert.equal(actual[key], settingsFixture[key], 'RC1 reloaded ' + key);
    assert.deepEqual(actual.objects, [legacyBuilt.object]);
  }
  await verifyLegacyIPC(page); await verifyLegacyDisk();
  await close(); await verifyLegacyDisk();
  page = await launch(verifiedLegacyExe);
  await verifyLegacyIPC(page); await verifyLegacyDisk();
  await close(); await verifyLegacyDisk();
  console.log('Checksum-verified RC1 migration fixture generated and reloaded through public IPC; legacy graphics are not release acceptance.');`);
 return "import {observeInstallerLaunch} from './installer-graphics-observer.mjs';\nimport {assertLegacySnapshot} from './recovery-installer-transform.mjs';\nimport {assertSmokeGraphics} from './smoke-graphics.mjs';\n"+script;
}

// Separate full-lifecycle experiment. The default recovery harness is unchanged.
export function recoveryInstallerSwiftShader(source) {
 let script=recoveryInstallerSmoke(source);
 const replace=(old,next)=>{assert.equal(script.split(old).length,2,'Expected exact diagnostic transform target');script=script.replace(old,next);};
 replace("args: ['--no-sandbox']", "args: ['--no-sandbox', ...(verifiedLegacyExe && executablePath === verifiedLegacyExe ? [] : ['--use-gl=angle', '--use-angle=swiftshader'])]");
 replace('await graphicsObserver.verify(() => assertSmokeGraphics(page, process.platform));', `await graphicsObserver.verify(async () => {
      await assertSmokeGraphics(page, process.platform);
      const backend = await page.evaluate(() => { const gl = document.querySelector('#viewport canvas')?.getContext('webgl2'); const debug = gl?.getExtension('WEBGL_debug_renderer_info'); return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null; });
      assert.ok(backend?.includes('SwiftShader'), 'Diagnostic RC3 launch must use actual SwiftShader backend');
    });`);
 return "console.log('DIAGNOSTIC ONLY: full RC3 installer lifecycle with explicit SwiftShader; default recovery failure remains unresolved.');\n"+script;
}
