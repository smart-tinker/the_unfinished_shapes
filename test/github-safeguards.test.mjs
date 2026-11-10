import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('public CI security checks use least-permission pinned actions', () => {
  const workflow = read('.github/workflows/security.yml');
  assert.match(workflow, /github\.event\.repository\.private == false/);
  assert.ok(workflow.includes("if: github.event.repository.private == false && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"));
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /fail-on-severity: high/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets: inherit|pull-requests: write|contents: write|upload-artifact/);
  for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) assert.match(line, /@[a-f0-9]{40}(?:\s|$)/);
});

test('staged platform packages receive provenance only after tests and hash checks', () => {
  const stage = read('.github/workflows/stage-release.yml');
  assert.match(stage, /workflow_dispatch:/);
  assert.doesNotMatch(stage, /upload-artifact/);
  for (const [index, job] of ['windows', 'macos', 'linux'].entries()) {
    const next = ['macos', 'linux'][index];
    const start = stage.indexOf('\n  ' + job + ':\n');
    const end = next ? stage.indexOf('\n  ' + next + ':\n', start + 1) : stage.length;
    const section = stage.slice(start, end);
    assert.match(section, /id-token: write\n      attestations: write/);
    const staged = section.indexOf('stage ' + job + ' dist/candidate');
    const attested = section.indexOf('actions/attest-build-provenance@');
    assert.ok(staged >= 0 && attested > staged);
    assert.match(section, /subject-path: dist\/candidate\/\*/);
  }
});

test('default-branch issue and pull request templates require scope and verifiable acceptance', () => {
  const bug = read('.github/ISSUE_TEMPLATE/bug.yml');
  const change = read('.github/ISSUE_TEMPLATE/change.yml');
  const pr = read('.github/pull_request_template.md');
  assert.match(bug, /Definition of Done/);
  assert.match(bug, /Version and environment/);
  assert.match(change, /Scope and non-goals/);
  assert.match(change, /Definition of Done and tests/);
  for (const required of ['Issue and scope', 'Definition of Done', 'Exact tested head SHA', 'Unverified native']) assert.ok(pr.includes(required));
});

test('blank issues are disabled for public contributors', () => {
  assert.ok(read('.github/ISSUE_TEMPLATE/config.yml').split(String.fromCharCode(10)).includes('blank_issues_enabled: false'));
});

test('PR template visibly directs default-branch safeguards to main', () => {
  const visible = read('.github/pull_request_template.md').split('<!--')[0].toLowerCase();
  assert.ok(visible.includes('target main for repository configuration'));
  assert.ok(visible.includes('target the current rc branch for application changes'));
});

test('Dependabot checks npm and GitHub Actions weekly in bounded groups', () => {
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*?interval: weekly/);
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*?interval: weekly/);
  assert.match(dependabot, /groups:/);
  assert.match(dependabot, /open-pull-requests-limit:/);
  assert.doesNotMatch(dependabot, /auto-merge/);
});
