import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForUninstall } from '../scripts/windows-uninstall.mjs';

const fsError = code => Object.assign(new Error(code), { code });

test('waits through transient Windows access denial until uninstall removes the executable', async () => {
  let checks = 0;
  await waitForUninstall(async () => {
    checks++;
    if (checks < 3) throw fsError('EPERM');
    throw fsError('ENOENT');
  }, { attempts: 4, sleep: async () => {} });
  assert.equal(checks, 3);
});

test('bounds retries and preserves the last Windows access error', async () => {
  let checks = 0;
  await assert.rejects(waitForUninstall(async () => {
    checks++;
    throw fsError('EPERM');
  }, { attempts: 3, sleep: async () => {}}), error => error.code === 'EPERM');
  assert.equal(checks, 3);
});

test('does not retry unexpected filesystem errors', async () => {
  let checks = 0;
  const denied = fsError('EACCES');
  await assert.rejects(waitForUninstall(async () => {
    checks++;
    throw denied;
  }, { attempts: 3, sleep: async () => {}}), error => error === denied);
  assert.equal(checks, 1);
});
