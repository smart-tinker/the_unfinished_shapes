import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Windows updater workflow runs after native smoke failure only when both packages built', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const lf = workflow.replace(/\r\n?/g, '\n');

  function inspect(source) {
    const normalized = source.replace(/\r\n?/g, '\n');
    const start = normalized.indexOf('  windows-installer:\n');
    assert.ok(start >= 0, 'the Windows workflow job is found');
    const job = normalized.slice(start);
    const updaterStart = job.indexOf('      - name: Published update download and exact installer/portable acceptance');
    assert.ok(updaterStart >= 0, 'the packaged updater acceptance step exists');
    const native = job.slice(job.indexOf('      - name: Verify clean install, current-candidate lifecycle and retained data'), updaterStart);
    const updater = job.slice(updaterStart);
    const packageStart = job.indexOf('      - id: package\n');
    assert.ok(packageStart >= 0, 'the Windows package step exists');
    const installerStart = job.indexOf('      - id: installer\n', packageStart);
    assert.ok(installerStart > packageStart, 'the installer step follows packaging');
    const packageStep = job.slice(packageStart, installerStart);
    assert.match(packageStep, /npm run package:win/, 'the standard package command remains');
    const dependenciesStart = job.indexOf('      - id: dependencies\n');
    const checkStart = job.indexOf('      - run: npm run check\n', dependenciesStart);
    const metadataStart = job.indexOf('      - id: metadata\n', checkStart);
    assert.ok(dependenciesStart >= 0 && checkStart > dependenciesStart && metadataStart > checkStart && packageStart > metadataStart,
      'dependency install, required check, metadata and package remain ordered');

    const step = start => {
      const end = job.indexOf('\n      - ', start + 8);
      return end < 0 ? job.slice(start) : job.slice(start, end);
    };
    const parseStart = job.indexOf('      - name: Parse Windows UI automation script\n');
    assert.ok(parseStart >= 0, 'Windows UI automation scripts are parsed before the package flow');
    assert.match(step(parseStart), /ParseFile\('scripts\/windows-nsis-wizard\.ps1'/, 'the bounded installer observer is parsed before execution');
    assert.match(step(dependenciesStart), /run: npm ci/, 'Windows dependencies must install before packaging');
    assert.equal(step(checkStart).trim(), '- run: npm run check', 'the required check remains an ordinary failing step');
    assert.doesNotMatch(job, /continue-on-error\s*:\s*true/, 'check failures still fail Validate');
    const metadataStep = step(metadataStart);
    assert.match(metadataStep, /if:\s*\$\{\{[^}]*steps\.dependencies\.conclusion\s*==\s*'success'[^}]*\}\}/,
      'runner metadata only changes after dependency installation');
    assert.match(metadataStep, /npm version 0\.1\.0-rc\.1/, 'packaged checks still target the published candidate version');
    const packageCondition = packageStep.match(/^\s*if:\s*\$\{\{([^}]+)\}\}/m)?.[1] || '';
    assert.match(packageCondition, /!\s*cancelled\(\)/);
    assert.match(packageCondition, /steps\.dependencies\.conclusion\s*==\s*'success'/);
    assert.match(packageCondition, /steps\.metadata\.conclusion\s*==\s*'success'/);

    assert.match(packageStep, /\$env:DEBUG\s*=\s*'electron-packager'/, 'the standard Packager debug reports its effective ignore regex');
    assert.match(packageStep, /TUS_TAR_PACKAGE stage=before/, 'the installed tar ESM entry is recorded before packaging');
    assert.match(packageStep, /TUS_TAR_PACKAGE stage=after/, 'the bundled tar ESM entry is recorded after packaging');
    assert.match(packageStep, /resources\/app\.asar/, 'the readback targets the actual packaged ASAR');
    assert.match(packageStep, /@electron\/asar/, 'the readback uses the installed ASAR reader');
    assert.match(packageStep, /extractFile/, 'the readback inspects files inside the ASAR');
    assert.ok(packageStep.includes("path.join('node_modules', 'tar', 'package.json')"), 'the ASAR readback uses platform-native separators for the manifest');
    assert.ok(packageStep.includes("path.join('node_modules', 'tar', entry.slice(2))"), 'the ASAR readback uses platform-native separators for the ESM entry');
    assert.match(packageStep, /exports[\s\S]*import\.default/, 'the check follows tar exports[\".\"].import.default');
    assert.doesNotMatch(packageStep, /PACKAGER_ARGV|electron-packager\.tus-real\.cmd/, 'the ordinary npm package command is not wrapped');
    const nativeStart = job.indexOf('      - name: Verify clean install, current-candidate lifecycle and retained data');
    const installerStep = job.slice(installerStart, nativeStart);
    assert.match(installerStep, /if:\s*\$\{\{[^}]*!\s*cancelled\(\)[^}]*steps\.package\.conclusion\s*==\s*'success'[^}]*\}\}/,
      'installer build runs only after a successful portable package and not after cancellation');
    assert.match(installerStep, /run: npm run installer:win/, 'the standard installer command remains');
    const nativeCondition = native.match(/^\s*if:\s*\$\{\{([^}]+)\}\}/m)?.[1] || '';
    assert.match(nativeCondition, /steps\.package\.conclusion\s*==\s*'success'/);
    assert.match(nativeCondition, /steps\.installer\.conclusion\s*==\s*'success'/);
    assert.doesNotMatch(native, /continue-on-error\s*:\s*true/, 'the native smoke failure remains job-failing');
    const condition = updater.match(/^\s*if:\s*\$\{\{([^}]+)\}\}/m)?.[1] || '';
    assert.match(condition, /!\s*cancelled\(\)/, 'the updater still runs after an earlier smoke failure');
    assert.match(condition, /steps\.package\.conclusion\s*==\s*'success'/, 'a failed or skipped package build blocks the updater');
    assert.match(condition, /steps\.installer\.conclusion\s*==\s*'success'/, 'a failed or skipped installer build blocks the updater');
    assert.doesNotMatch(updater, /continue-on-error\s*:\s*true/, 'updater failures remain job failures');
    return condition.replace(/\s+/g, ' ').trim();
  }

  const lfCondition = inspect(lf);
  const crlfCondition = inspect(lf.replace(/\n/g, '\r\n'));
  assert.equal(crlfCondition, lfCondition, 'LF and CRLF forms preserve the same workflow semantics');
});

test('Windows package command preserves root ignore anchors through npm cmd', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts['package:win'].includes('--ignore="^/test"'), 'Windows keeps the root test ignore anchored after npm cmd parsing');
  assert.ok(packageJson.scripts['package:win'].includes('--ignore="^/dist"'), 'Windows keeps the root dist ignore anchored after npm cmd parsing');
});
