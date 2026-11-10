const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForUninstall(check, { attempts = 60, sleep = delay } = {}) {
  let lastTransientError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await check(); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
      lastTransientError = error;
    }
    if (attempt + 1 < attempts) await sleep(250);
  }
  if (lastTransientError) throw lastTransientError;
  throw new Error('Uninstaller did not remove the installed executable.');
}
