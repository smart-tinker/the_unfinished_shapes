import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import fs, { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGpuDiagnostics, gpuLogEvidence } from '../scripts/gpu-smoke.mjs';
import { withSmokeCleanup } from '../scripts/graphics-smoke.mjs';

function fakeApp(getGPUInfo = async () => ({ gpuDevice: [{ vendorId: 10, deviceId: 20, secret: 'private' }], auxAttributes: { glRenderer: 'driver', private: 'token' } })) {
  const app = new EventEmitter(), instance = new EventEmitter();
  app.getGPUInfo = getGPUInfo;
  app.getGPUFeatureStatus = () => ({ webgl: 'enabled' });
  instance.evaluate = async fn => vm.runInNewContext(`(${fn})({app})`, { app, setTimeout, clearTimeout, console: { log: text => instance.emit('console', { text: () => text }) } });
  return { instance, app };
}
const filename = gpu => gpu.args.find(arg => arg.startsWith('--log-file=')).slice(11);

test('native diagnostics capture GPU info and process exit without personal data', async () => {
  const logs = [], gpu = await createGpuDiagnostics('reinstall', text => logs.push(text));
  const { instance, app } = fakeApp();
  try {
    await gpu.attach(instance);
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 42, serviceName: 'secret' });
    app.emit('render-process-gone', {}, { id: 7 }, { reason: 'oom', exitCode: 9 });
    app.emit('gpu-info-update');
    const text = logs.join('\n');
    for (const expected of ['reinstall', 'gpu-info', 'driver', 'child-process-gone', 'crashed', 'render-process-gone', 'oom', '"updateObserved":true']) assert.ok(text.includes(expected), expected);
    assert.doesNotMatch(text, /secret|private|token/);
  } finally { await gpu.finish(); }
  await assert.rejects(access(path.dirname(filename(gpu))));
});

test('native log evidence strips arbitrary messages and caps records', () => {
  const line = '[1:ERROR:gpu_process_host.cc(123)] GPU process exited exit_code=34 https://host/?token=secret /home/person/data 0x887a0005';
  const evidence = gpuLogEvidence(`${line}\n`.repeat(100) + '[ERROR:network.cc(4)] private');
  assert.equal(evidence.length, 60);
  assert.deepEqual(evidence[0], { source: 'gpu_process_host.cc', line: 123, signals: ['GPU process exited', 'exit_code=34', '0x887a0005'] });
  assert.doesNotMatch(JSON.stringify(evidence), /secret|host\/|home|private/);
});

test('recognized Chromium timestamp and process IDs survive without raw prefix or message', () => {
  const evidence = gpuLogEvidence([
    '[123:456:1108/211234.123456:ERROR:gpu_process_host.cc(9)] GPU process exited exit_code=7 token=private',
    '[321:1108/211235.789:ERROR:gl_context.cc(12)] context lost https://private',
    '[unknown-prefix:ERROR:d3d11_texture_helper.cc(18)] device reset private'
  ].join('\n'));
  assert.deepEqual(evidence[0], { pid: 123, tid: 456, nativeTimestamp: '1108/211234.123456', source: 'gpu_process_host.cc', line: 9, signals: ['GPU process exited', 'exit_code=7'] });
  assert.deepEqual(evidence[1], { pid: 321, nativeTimestamp: '1108/211235.789', source: 'gl_context.cc', line: 12, signals: ['context lost'] });
  assert.equal('nativeTimestamp' in evidence[2], false);
  assert.equal('pid' in evidence[2], false);
  assert.doesNotMatch(JSON.stringify(evidence), /private|token|https|unknown-prefix/);
});

test('native log recognizes graphics namespaces without exposing unrelated messages', () => {
  const evidence = gpuLogEvidence([
    '[ERROR:d3d11_texture_helper.cc(18)] Failed to create texture DXGI_ERROR_DEVICE_REMOVED 0x887a0005 token=private-d3d https://host/private',
    '[ERROR:shared_image_factory.cc(27)] Failed to initialize backing: out of memory token=private-image /home/private',
    '[ERROR:gl_display.cc(31)] context reset',
    '[ERROR:egl_util.cc(32)] EGL_BAD_ALLOC',
    '[ERROR:gles2_cmd_decoder.cc(33)] GL_OUT_OF_MEMORY',
    '[ERROR:vulkan_device_queue.cc(34)] device lost error_code=-4',
    '[ERROR:network_service.cc(35)] Failed to initialize token=private-network 0x1234',
    '[ERROR:ipc_channel.cc(36)] context lost token=private-ipc 0x5678'
  ].join('\n'));
  assert.deepEqual(evidence.slice(0, 2), [
    { source: 'd3d11_texture_helper.cc', line: 18, signals: ['Failed to create', 'DXGI_ERROR_DEVICE_REMOVED', '0x887a0005'] },
    { source: 'shared_image_factory.cc', line: 27, signals: ['Failed to initialize', 'out of memory'] }
  ]);
  assert.equal(evidence.length, 6);
  assert.doesNotMatch(JSON.stringify(evidence), /private|token|https|home|network|ipc|0x1234|0x5678/);
});

test('native output and file read are bounded; temp file is removed after close', async () => {
  const logs = [], gpu = await createGpuDiagnostics('first', text => logs.push(text));
  const { instance, app } = fakeApp();
  await gpu.attach(instance);
  for (let i = 0; i < 100; i++) app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: i });
  await withSmokeCleanup(() => {}, async () => {
    await writeFile(filename(gpu), 'x'.repeat(200000) + '\n[ERROR:gpu_process_host.cc(1)] GPU process exited exit_code=7');
  }, () => gpu.finish());
  assert.ok(logs.length <= 64);
  assert.ok(logs.some(text => text.includes('"truncated":true') && text.includes('exit_code=7')));
  await assert.rejects(access(filename(gpu)));
});

test('failed APIs and logger never replace the original failure or prevent cleanup', async () => {
  for (const failure of ['evaluate', 'info', 'logger']) {
    const gpu = await createGpuDiagnostics('failed', () => { if (failure === 'logger') throw Error('logger'); });
    const { instance } = fakeApp(async () => { throw Error('info'); });
    if (failure === 'evaluate') instance.evaluate = async () => { throw Error('evaluate'); };
    const original = Error('original');
    let closed = false;
    await assert.rejects(withSmokeCleanup(async () => { await gpu.attach(instance); throw original; },
      () => { closed = true; }, () => gpu.finish()), error => error === original);
    assert.equal(closed, true);
    await assert.rejects(access(path.dirname(filename(gpu))));
  }
});

test('hung native evaluate is bounded and does not delay cleanup indefinitely', async () => {
  const logs = [], gpu = await createGpuDiagnostics('hung', text => logs.push(text));
  const { instance } = fakeApp();
  instance.evaluate = () => new Promise(() => {});
  await gpu.attach(instance);
  await gpu.finish();
  assert.ok(logs.some(text => text.includes('electron-observer-timeout')));
  await assert.rejects(access(path.dirname(filename(gpu))));
});

test('already-fired GPU update and rejected info do not require waiting for another event', async () => {
  const logs = [], gpu = await createGpuDiagnostics('ready', text => logs.push(text));
  const { instance } = fakeApp(async () => { throw Error('GPU unavailable'); });
  await gpu.attach(instance);
  await new Promise(resolve => setImmediate(resolve));
  await gpu.finish();
  assert.ok(logs.some(text => text.includes('gpu-info-unavailable')));
});


test('native log retains the latest 60 useful records including late GPU startup failures', () => {
  const evidence = gpuLogEvidence([
    ...Array.from({ length: 65 }, (_, index) => `[ERROR:gpu_process_host.cc(${index})] context lost`),
    ...Array.from({ length: 100 }, () => '[INFO:shared_image_factory.cc(2)] ordinary private message'),
    '[ERROR:viz_main_impl.cc(201)] Exiting GPU process due to errors during initialization token=private https://private'
  ].join('\n'));
  assert.equal(evidence.length, 60);
  assert.equal(evidence[0].line, 6);
  assert.deepEqual(evidence.at(-1), { source: 'viz_main_impl.cc', line: 201, signals: ['Exiting GPU process'] });
  assert.ok(evidence.every(record => record.signals.length));
  assert.doesNotMatch(JSON.stringify(evidence), /ordinary|private|token|https/);
});

test('final temp removal failure fails smoke and preserves an existing primary error', async t => {
  for (const primary of [null, new Error('original smoke failure')]) {
    const gpu = await createGpuDiagnostics('cleanup failure', () => { throw Error('logger'); });
    const directory = path.dirname(filename(gpu)), removal = new Error('temp removal failed'), calls = [];
    await writeFile(filename(gpu), 'private diagnostic fixture');
    const mocked = t.mock.method(fs, 'rm', async target => {
      assert.equal(target, directory);
      throw removal;
    });
    try {
      await assert.rejects(withSmokeCleanup(() => { if (primary) throw primary; },
        () => calls.push('close'), () => gpu.finish(), () => calls.push('other cleanup')), error => {
        if (!primary) return error === removal;
        assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, removal]);
        return true;
      });
      assert.deepEqual(calls, ['close', 'other cleanup']);
      await access(filename(gpu));
    } finally {
      mocked.mock.restore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});


test('modern Chromium source:line and legacy source(line) yield equivalent private-safe evidence', () => {
  const modern = '[123:456:1108/211234.123456:ERROR:gpu_process_host.cc:123] GPU process exited exit_code=7 token=private https://private';
  const legacy = modern.replace('gpu_process_host.cc:123]', 'gpu_process_host.cc(123)]');
  assert.deepEqual(gpuLogEvidence(modern), gpuLogEvidence(legacy));
  assert.deepEqual(gpuLogEvidence(modern)[0], { pid: 123, tid: 456, nativeTimestamp: '1108/211234.123456', source: 'gpu_process_host.cc', line: 123, signals: ['GPU process exited', 'exit_code=7'] });
  const evidence = gpuLogEvidence([
    modern,
    '[ERROR:viz_main_impl.cc:201] Exiting GPU process token=private',
    '[ERROR:network_service.cc:7] GPU process exited exit_code=8 token=private',
    '[ERROR:ipc_channel.cc:8] context lost https://private',
    '[ERROR:gpu_process_host.cc:invalid] GPU process exited token=private',
    '[ERROR:gpu_process_host.cc:9invalid] GPU process exited token=private'
  ].join('\n'));
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence[1], { source: 'viz_main_impl.cc', line: 201, signals: ['Exiting GPU process'] });
  assert.doesNotMatch(JSON.stringify(evidence), /private|token|https|network|ipc|invalid/);
});

test('unrecognized graphics warnings retain only source location', () => {
  const evidence = gpuLogEvidence([
    '[1:ERROR:gpu_channel_manager.cc:42] unfamiliar message token=private /home/private',
    '[WARNING:gl_context.cc(9)] unfamiliar warning https://private',
    '[INFO:gl_context.cc(10)] ordinary message',
    '[ERROR:network_service.cc:11] private'
  ].join('\n'));
  assert.deepEqual(evidence, [
    { source: 'gpu_channel_manager.cc', line: 42, signals: [] },
    { source: 'gl_context.cc', line: 9, signals: [] }
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /private|token|https|home|unfamiliar/);
});
