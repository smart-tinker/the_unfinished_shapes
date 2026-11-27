import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { listPublishedReleases, safeReleaseCheckErrorCode, startupUpdateOptions } from '../src/update-release.mjs';
import { safeMainDiagnostics } from '../scripts/updater-smoke-diagnostics.mjs';

function startupHandlerSource(main) {
  const observerStart = main.indexOf("async function listPublishedReleasesForSmoke(phase) {");
  const observerEnd = main.indexOf("\nfunction currentControlBridge(", observerStart);
  const handlerStart = main.indexOf("  handle('updates:startup-check', async () => {");
  const handlerEnd = main.indexOf("\n  handle('updates:check'", handlerStart);
  assert.ok(observerStart >= 0 && observerEnd > observerStart, 'the real smoke fetch observer is present');
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'the registered startup IPC handler is present');
  return main.slice(observerStart, observerEnd) + '\n' + main.slice(handlerStart, handlerEnd);
}

test('registered startup IPC checks one published release and returns its proposed version', async () => {
  const main = (await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  const importMatch = main.match(/^import \{([^}]+)\} from '\.\/update-release\.mjs';$/m);
  assert.ok(importMatch, 'main imports its update release functions');
  const imported = new Set(importMatch[1].split(',').map(name => name.trim()));
  const handlerSource = startupHandlerSource(main);

  let releaseListCalls = 0;
  const registered = new Map();
  const context = {
    app: { getVersion: () => '0.9.0' },
    updaterSmokeBoundary: null,
    URL,
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

  runInNewContext(handlerSource, context);
  assert.equal(registered.size, 1);
  const handler = registered.get('updates:startup-check');
  assert.equal(typeof handler, 'function', 'the actual startup channel registers a callback');
  const result = await handler();

  assert.equal(releaseListCalls, 1, 'the handler lists published releases exactly once');
  assert.equal(result.status, 'checked');
  assert.equal(result.options.prerelease.release.tag_name, 'v1.0.0-rc.2');
  assert.equal(result.options.prerelease.relation, 'update');
});

test('smoke startup fetch producer is sanitized with the release classifier semantics', async () => {
  const main = (await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  const handlerSource = startupHandlerSource(main);
  const boundary = { releaseFetches: [] };
  let fetchCalls = 0;
  const context = {
    app: { getVersion: () => '0.9.0' },
    updaterSmokeBoundary: boundary,
    URL,
    handle: (_name, callback) => { context.handler = callback; },
    fetch: async () => {
      fetchCalls++;
      return {
        status: 403,
        ok: false,
        headers: { get: name => name === 'x-ratelimit-remaining' ? '000' : 'PRIVATE_HEADER' },
        authorization: 'PRIVATE_HEADER',
        body: 'PRIVATE_RESPONSE_BODY',
      };
    },
    listPublishedReleases,
    startupUpdateOptions,
    safeReleaseCheckErrorCode,
  };
  runInNewContext(handlerSource, context);
  const result = await context.handler();
  const produced = boundary.releaseFetches.map(({ stage, phase, page, count, status, remainingZero, safeFailure }) =>
    ({ stage, phase, page, count, status, remainingZero, safeFailure }));
  const sanitized = safeMainDiagnostics(boundary.releaseFetches, { sha256: 'a'.repeat(64) }, '', '').map(
    ({ stage, phase, page, count, status, remainingZero, safeFailure }) =>
      ({ stage, phase, page, count, status, remainingZero, safeFailure }),
  );
  const safeResult = JSON.parse(JSON.stringify(result));
  const serialized = JSON.stringify({ produced, sanitized, result: safeResult });
  assert.equal(fetchCalls, 1);
  assert.doesNotMatch(serialized, /api\.github\.com|PRIVATE_HEADER|PRIVATE_RESPONSE_BODY/);
  assert.deepEqual(
    { produced, sanitized, result: safeResult },
    {
      produced: [{
        stage: 'release-fetch', phase: 'startup', page: 1, count: 1,
        status: 403, remainingZero: false, safeFailure: 'http_error',
      }],
      sanitized: [{
        stage: 'release-fetch', phase: 'startup', page: 1, count: 1,
        status: 403, remainingZero: false, safeFailure: 'http_error',
      }],
      result: { status: 'unavailable', errorCode: 'http_error' },
    },
  );
});
