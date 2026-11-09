import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const read = name => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
for (const ending of ['LF', 'CRLF']) {
  const normalized = name => read(name).replace(/\r\n/g, '\n').replace(/\n/g, ending === 'CRLF' ? '\r\n' : '\n').replace(/\r\n/g, '\n');
  const ci = normalized('ci'), stage = normalized('stage-release'), publish = normalized('publish-release');
  test(`${ending}: ordinary CI has no publication route or write permission`, () => {
    assert.doesNotMatch(ci, /^  push:/m, 'PR and push must not duplicate acceptance');
    assert.match(ci, /permissions:\n  contents: read/);
    assert.doesNotMatch(ci, /contents: write|publish_rc|publish\/|gh release|release-windows:/);
    for (const job of ['test', 'linux-client', 'macos-native', 'windows-installer', 'model']) assert.ok(ci.includes(`  ${job}:\n`));
  });
  test(`${ending}: stage and publish are explicit, matching-release-branch dispatches only`, () => {
    for (const workflow of [stage, publish]) {
      assert.doesNotMatch(workflow, /^  (push|pull_request|workflow_run):/m);
      const condition = workflow.match(/^    if: (.+)$/m)[1];
      const allows = (event, ref, privateRepo = false) => runInNewContext(condition, { github: { event: { repository: { private: privateRepo } }, event_name: event, ref }, startsWith: (s, prefix) => s.startsWith(prefix) });
      assert.equal(allows('workflow_dispatch', 'refs/heads/release/0.1.0-rc3'), true);
      for (const event of ['push', 'pull_request', 'workflow_run']) assert.equal(allows(event, 'refs/heads/release/0.1.0-rc3'), false);
      for (const ref of ['refs/heads/main', 'refs/heads/feature/test', 'refs/heads/publish/0.1.0-rc3', 'refs/tags/v0.1.0-rc3']) assert.equal(allows('workflow_dispatch', ref), false);
      assert.equal(allows('workflow_dispatch', 'refs/heads/release/0.1.0-rc3', true), false);
      assert.match(workflow, /group: candidate-release-\$\{\{ github.repository \}\}\n  cancel-in-progress: false/);
      assert.doesNotMatch(workflow, /--clobber|upload-artifact|download-artifact|runs-on:.*(?:large|xlarge)/);
      assert.doesNotMatch(workflow, /\n\s+ref:/, 'checkout must use exact workflow commit, never a moving ref');
    }
  });
  test(`${ending}: staging tests final archives, same installer and current CPU candidate before upload`, () => {
    assert.match(stage, /model:\n    needs: create-draft[\s\S]*?uses: \.\/\.github\/workflows\/local-cpu-model.yml/);
    assert.match(stage, /create-draft:\n    needs: preflight/);
    assert.match(normalized('local-cpu-model'), /  workflow_call:/);
    for (const platform of ['windows', 'macos', 'linux']) {
      const section = stage.split(`  ${platform}:\n`)[1].split(/^  [a-z-]+:\n/m)[0];
      assert.match(section, /contents: write/);
      assert.match(section, /CANDIDATE_RUN_ATTEMPT: \$\{\{ needs.create-draft.outputs.run_attempt \}\}/);
      assert.ok(section.indexOf('check-attempt') < section.indexOf('npm ci'));
      assert.ok(section.indexOf(`record ${platform}`) < section.indexOf('node scripts/' + (platform === 'windows' ? 'windows-installer-smoke' : 'electron-smoke') + '.mjs'));
      assert.ok(section.indexOf(`stage ${platform}`) > section.indexOf('smoke.mjs'));
      assert.match(section, /dist\/extracted/);
    }
    assert.match(stage, /TUS_SMOKE_INSTALLER: dist\/candidate\//);
    assert.match(stage, /TUS_SMOKE_PORTABLE_EXECUTABLE: dist\/extracted\//);
    assert.doesNotMatch(stage, /actions\/runs\?|head_sha|swiftshader|use-angle/);
  });
  test(`${ending}: publication downloads/verifies only and cannot rebuild or interpolate untrusted inputs`, () => {
    assert.doesNotMatch(publish, /npm ci|npm run|package-macos|installer:win|upload-artifact/);
    assert.match(publish, /CANDIDATE_RUN_ID: \$\{\{ inputs.candidate_run_id \}\}/);
    assert.match(publish, /run: node scripts\/release-candidate.mjs publish "\$CANDIDATE_RUN_ID"/);
    assert.match(publish, /contents: write\n      actions: read/);
  });
}
