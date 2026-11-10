import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('security checks use public standard runners without PR write or privileged PR triggers', () => {
  const workflow = read('.github/workflows/security.yml');
  assert.match(workflow, /github\.event\.repository\.private == false/g);
  assert.match(workflow, /runs-on: ubuntu-24\.04/g);
  assert.doesNotMatch(workflow, /pull_request_target|secrets: inherit|pull-requests: write|contents: write|upload-artifact/);
  assert.match(workflow, /fail-on-severity: high/);
  assert.match(workflow, /build-mode: none/);
  for (const line of workflow.split('\n').filter((s) => s.includes('uses:'))) {
    assert.match(line, /@[a-f0-9]{40}(?:\s|$)/);
  }
});

test('provenance follows testing and hash-checked staging, not an automatic publication trigger', () => {
  const stage = read('.github/workflows/stage-release.yml');
  assert.match(stage, /workflow_dispatch:/);
  assert.doesNotMatch(stage, /upload-artifact/);
  for (const [index, job] of ['windows', 'macos', 'linux'].entries()) {
    const next = ['macos', 'linux'][index];
    const section = stage.split(`\n  ${job}:\n`)[1].split(next ? `\n  ${next}:\n` : '\u0000')[0];
    assert.match(section, /id-token: write\n      attestations: write/);
    assert.ok(section.indexOf(`stage ${job} dist/candidate`) < section.indexOf('actions/attest-build-provenance@'));
    assert.match(section, /subject-path: dist\/candidate\/\*/);
  }
});
