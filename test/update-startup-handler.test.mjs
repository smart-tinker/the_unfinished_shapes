import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { safeReleaseCheckErrorCode, startupUpdateOptions } from '../src/update-release.mjs';

test('registered startup IPC checks one published release and returns its proposed version', async () => {
  const main = (await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  const importMatch = main.match(/^import \{([^}]+)\} from '\.\/update-release\.mjs';$/m);
  assert.ok(importMatch, 'main imports its update release functions');
  const imported = new Set(importMatch[1].split(',').map(name => name.trim()));
  const start = main.indexOf("  handle('updates:startup-check', async () => {");
  const end = main.indexOf("\n  handle('updates:check'", start);
  assert.ok(start >= 0 && end > start, 'the registered startup IPC handler is present');

  let releaseListCalls = 0;
  const registered = new Map();
  const context = {
    app: { getVersion: () => '0.9.0' },
    handle: (name, callback) => registered.set(name, callback),
  };
  if (imported.has('listPublishedReleases')) {
    context.listPublishedReleases = async () => {
      releaseListCalls++;
      return { stable: null, prerelease: { tag_name: 'v1.0.0-rc.2', prerelease: true, draft: false } };
    };
  }
  if (imported.has('startupUpdateOptions')) context.startupUpdateOptions = startupUpdateOptions;
  if (imported.has('safeReleaseCheckErrorCode')) context.safeReleaseCheckErrorCode = safeReleaseCheckErrorCode;

  runInNewContext(main.slice(start, end), context);
  assert.equal(registered.size, 1);
  const handler = registered.get('updates:startup-check');
  assert.equal(typeof handler, 'function', 'the actual startup channel registers a callback');
  const result = await handler();

  assert.equal(releaseListCalls, 1, 'the handler lists published releases exactly once');
  assert.equal(result.status, 'checked');
  assert.equal(result.options.prerelease.release.tag_name, 'v1.0.0-rc.2');
  assert.equal(result.options.prerelease.relation, 'update');
});
