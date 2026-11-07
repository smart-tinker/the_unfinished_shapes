import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {recoveryInstallerSmoke,recoveryInstallerSwiftShader} from '../scripts/recovery-installer-transform.mjs';
const original=readFileSync(new URL('../scripts/windows-installer-smoke.mjs',import.meta.url),'utf8');
test('separate experiment affects RC3 flags only and requires real SwiftShader backend',()=>{
 const standard=recoveryInstallerSmoke(original),diagnostic=recoveryInstallerSwiftShader(original);
 assert.doesNotMatch(standard,/--use-angle=swiftshader/);
 assert.match(diagnostic,/verifiedLegacyExe && executablePath === verifiedLegacyExe \? \[\] : \['--use-gl=angle', '--use-angle=swiftshader'\]/);
 assert.match(diagnostic,/await assertSmokeGraphics\(page, process.platform\)/);
 assert.match(diagnostic,/backend\?\.includes\('SwiftShader'\)/);
 assert.match(diagnostic,/DIAGNOSTIC ONLY/);
 assert.doesNotMatch(diagnostic,/enable-unsafe|disable-web-security/);
 for(const check of ['released RC1 checksum','uninstall retains settings','uninstall retains world','verifyLegacyDisk','verifyRestored'])assert.ok(diagnostic.includes(check));
});
test('diagnostic workflow is read-only, exact-source, Windows-only and no release/storage operations',()=>{
 const s=readFileSync(new URL('../.github/workflows/windows-installer-swiftshader-diagnostic.yml',import.meta.url),'utf8');
 assert.match(s,/runs-on: windows-latest/);assert.match(s,/contents: read/);assert.match(s,/ref: 867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488/);
 assert.match(s,/prepare-swiftshader/);assert.match(s,/TUS_GRAPHICS_DIAGNOSTIC: swiftshader/);
 assert.doesNotMatch(s,/gh release|upload-artifact|actions\/cache|contents: write/);
});
