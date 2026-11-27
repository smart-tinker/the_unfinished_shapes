import { rm } from 'node:fs/promises';

export function withTimeout(promise, label, timeoutMs = 30000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(label + ' timed out after ' + timeoutMs + 'ms.'),
        { code: 'ETIMEDOUT' },
      )), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function cleanupUpdaterTemporaryData({ testRoot, canRemove, remove = rm, onOutcome = () => {} }) {
  let outcome = 'retained';
  const report = value => { try { onOutcome(value); } catch {} };
  try {
    if (await canRemove()) {
      await withTimeout(
        Promise.resolve().then(() => remove(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })),
        'Updater temporary data cleanup',
        10000,
      );
      outcome = 'removed';
    }
  } catch (error) {
    outcome = error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
    throw error;
  } finally {
    report(outcome);
  }
}
