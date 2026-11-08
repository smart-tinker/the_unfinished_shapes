import fs, { mkdtemp, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Do not print arbitrary Chromium messages: they can contain URLs, paths or tokens.
export function gpuLogEvidence(text) {
  const result = [];
  for (const line of text.split('\n')) {
    const source = line.match(/\b([a-z0-9_]*(?:gpu|gl_|egl|gles2|angle|command_buffer|shared_image|vulkan|d3d|viz_main_impl)[a-z0-9_]*\.cc)(?:\((\d+)\)|:(\d+)\])/i);
    if (!source) continue;
    const signals = line.slice(source.index + source[0].length).match(/context lost|context reset|GPU process exited|Exiting GPU process|GPU process launch failed|GPU process isn't usable|Failed to create|Failed to initialize|out of memory|device removed|device hung|device reset|DXGI_ERROR_[A-Z_]+|EGL_[A-Z_]+|GL_[A-Z_]+|error_code[=: ]+-?\d+|exit_code[=: ]+-?\d+|0x[0-9a-f]{4,16}/gi) || [];
    if (!signals.length) continue;
    const prefix = line.match(/^\[(\d+):(?:(\d+):)?(\d{4}\/\d{6}\.\d{3,6}):/);
    result.push({ ...(prefix ? { pid: Number(prefix[1]), ...(prefix[2] ? { tid: Number(prefix[2]) } : {}), nativeTimestamp: prefix[3] } : {}), source: source[1], line: Number(source[2] ?? source[3]), signals: signals.slice(0, 12) });
    if (result.length > 60) result.shift();
  }
  return result;
}

export async function createGpuDiagnostics(label, log = console.log) {
  const started = Date.now();
  let directory, reports = 0;
  const report = (event, details = {}) => {
    if (reports++ >= 64) return;
    try { log(`GPU smoke ${JSON.stringify({ launch: label, observedAfterMs: Date.now() - started, event, ...details })}`); } catch {}
  };
  try { directory = await mkdtemp(path.join(os.tmpdir(), 'tus-gpu-')); }
  catch { report('log-file-unavailable'); }
  const filename = directory && path.join(directory, 'chromium.log');
  return {
    // File logging also captures Chromium child processes on Windows; no backend changes.
    args: filename ? ['--enable-logging=file', `--log-file=${filename}`] : [],
    async attach(instance) {
      let timeout;
      try {
        instance.on('console', message => {
          const text = message.text();
          if (text.startsWith('TUS_GPU_SMOKE ')) {
            try { report('electron', { evidence: JSON.parse(text.slice(14, 16398)) }); } catch {}
          }
        });
        await Promise.race([instance.evaluate(({ app }) => {
          let count = 0, ready = false;
          const emit = evidence => { if (count++ < 60) console.log(`TUS_GPU_SMOKE ${JSON.stringify(evidence)}`); };
          app.on('child-process-gone', (_event, details) => emit({ event: 'child-process-gone', type: details.type, reason: details.reason, exitCode: details.exitCode }));
          app.on('render-process-gone', (_event, contents, details) => emit({ event: 'render-process-gone', webContentsId: contents.id, reason: details.reason, exitCode: details.exitCode }));
          const features = () => {
            try { emit({ event: 'gpu-features', updateObserved: ready, status: app.getGPUFeatureStatus() }); } catch { emit({ event: 'gpu-features-unavailable' }); }
          };
          app.on('gpu-info-update', () => { ready = true; features(); });
          emit({ event: 'observer-attached', note: 'Events before attachment may be absent; Chromium file logging starts at launch.' });
          // Request current info too: gpu-info-update may already have fired before attachment.
          const timer = setTimeout(() => emit({ event: 'gpu-info-pending' }), 1500);
          timer.unref();
          try {
            app.getGPUInfo('complete').then(info => {
              clearTimeout(timer);
              const keys = ['vendorId', 'deviceId', 'active', 'driverVendor', 'driverVersion', 'vendorString', 'deviceString'];
              const gpuDevice = (info.gpuDevice || []).slice(0, 8).map(device => Object.fromEntries(keys.filter(key => key in device).map(key => [key, typeof device[key] === 'string' ? device[key].slice(0, 256) : device[key]])));
              const auxAttributes = Object.fromEntries(['glVendor', 'glRenderer', 'glVersion', 'glImplementationParts', 'inProcessGpu', 'passthroughCmdDecoder', 'sandboxed'].filter(key => key in (info.auxAttributes || {})).map(key => [key, typeof info.auxAttributes[key] === 'string' ? info.auxAttributes[key].slice(0, 256) : info.auxAttributes[key]]));
              emit({ event: 'gpu-info', gpuDevice, auxAttributes });
              // Resolved current GPU information is usable even if its update event was missed.
              if (!ready) features();
            }).catch(() => { clearTimeout(timer); emit({ event: 'gpu-info-unavailable' }); });
          } catch { clearTimeout(timer); emit({ event: 'gpu-info-unavailable' }); }
        }), new Promise(resolve => { timeout = setTimeout(() => { report('electron-observer-timeout'); resolve(); }, 1500); })]);
      } catch { report('electron-observer-unavailable'); }
      finally { clearTimeout(timeout); }
    },
    async finish() {
      if (!directory) return;
      let file;
      try {
        file = await open(filename, 'r');
        const { size } = await file.stat();
        const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        report('chromium-log', { bytes: size, truncated: size > buffer.length, evidence: gpuLogEvidence(buffer.subarray(0, bytesRead).toString('utf8')) });
      } catch { report('chromium-log-unavailable'); }
      finally {
        try { await file?.close(); } catch {}
        try { await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
        catch (error) { report('log-cleanup-failed'); throw error; }
      }
    }
  };
}
