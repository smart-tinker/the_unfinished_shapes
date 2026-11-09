import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopServerProcess } from '../scripts/server-smoke-process.mjs';

for (const code of [0, 7]) {
  test('shared smoke rejects a server that already exited with ' + code, async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(' + code + ')'], { stdio: 'ignore' });
    await once(child, 'exit');
    await assert.rejects(stopServerProcess(child), /unexpected.*exit/i);
  });
}
test('shared smoke rejects an already signalled server without waiting for another exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const start = Date.now();
  await assert.rejects(stopServerProcess(child), /unexpected.*exit/i);
  assert.ok(Date.now() - start < 1000);
});
test('shared smoke awaits graceful requested shutdown', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    await stopServerProcess(child);
    assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
