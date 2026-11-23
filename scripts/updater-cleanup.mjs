import { rm } from 'node:fs/promises';

export function withTimeout(promise, label, timeoutMs = 30000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms.')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export async function cleanupUpdaterTemporaryData({ testRoot, canRemove, remove = rm, onOutcome = () => {} }) {
  let outcome = 'retained';
  try {
    if (await canRemove()) {
      await remove(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      outcome = 'removed';
    }
  } catch (error) {
    outcome = 'failed';
    throw error;
  } finally {
    try { onOutcome(outcome); } catch {}
  }
}
