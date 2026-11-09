export async function stopServerProcess(process) {
  if (!process) return;
  if (process.exitCode !== null || process.signalCode !== null) {
    throw new Error('Unexpected server exit: ' + (process.signalCode ?? process.exitCode));
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Shared server did not stop')); }, 10000);
    process.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Server exit ' + code)); });
    process.kill('SIGTERM');
  });
}
