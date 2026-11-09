import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGpuDiagnostics } from './gpu-smoke.mjs';
import { withSmokeCleanup } from './graphics-smoke.mjs';

// A standalone context isolates runner graphics from the game and its saved data.
const mode = process.argv[2] || 'default';
assert.ok(['default', 'mesa'].includes(mode));
const directory = await mkdtemp(path.join(os.tmpdir(), 'tus-webgl-probe-'));
const main = path.join(directory, 'main.cjs');
await writeFile(main, [
  "const {app,BrowserWindow}=require('electron');",
  "app.setPath('userData',__dirname);",
  "app.whenReady().then(()=>{const win=new BrowserWindow({width:640,height:480,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL('data:text/html,<canvas id=\"probe\" width=\"64\" height=\"64\"></canvas>');});",
  "app.on('window-all-closed',()=>app.quit());"
].join('\n'));
let app;
const gpu = await createGpuDiagnostics('standalone-' + mode);
await withSmokeCleanup(async () => {
  app = await electron.launch({
    args: [main, '--no-sandbox', ...gpu.args, ...(mode === 'mesa' ? ['--use-gl=angle', '--use-angle=gl'] : [])],
    env: { ...process.env, ...(mode === 'mesa' ? { LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' } : {}) },
    timeout: 30000
  });
  await gpu.attach(app);
  const page = await app.firstWindow();
  await page.waitForSelector('#probe');
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector('#probe'), errors = [];
    canvas.addEventListener('webglcontextcreationerror', event => errors.push(event.statusMessage?.slice(0, 512)));
    let lost = false;
    canvas.addEventListener('webglcontextlost', () => { lost = true; });
    const gl = canvas.getContext('webgl2');
    if (!gl) return { created: false, errors };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    let frames = 0, pixel;
    const until = performance.now() + 5000;
    while (performance.now() < until && !lost && !gl.isContextLost()) {
      gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      frames++;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { created: true, renderer, lost: lost || gl.isContextLost(), frames, pixel: Array.from(pixel || []), errors };
  });
  console.log('Standalone WebGL ' + JSON.stringify({ mode, ...result }));
  assert.equal(result.created, true, 'standalone WebGL2 creation');
  assert.equal(result.lost, false, 'standalone WebGL2 remains healthy');
  assert.ok(result.frames >= 2, 'multiple frames rendered');
  assert.deepEqual(result.pixel, [0, 255, 0, 255], 'actual GPU readback');
}, () => app?.close(), () => gpu.finish(), () => rm(directory, { recursive: true, force: true }));
