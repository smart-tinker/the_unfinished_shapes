import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
async function files(dir,prefix='') {
 const result=[];
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  const relative=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isDirectory())result.push(...await files(path.join(dir,entry.name),relative));
  else {assert.ok(entry.isFile(),'Only regular source/dependency files');result.push(relative);}
 }
 return result.sort();
}
export async function verifyPortable(asarFile,candidate) {
 const require=createRequire(path.join(candidate,'package.json'));
 const asar=require('@electron/asar');
 const archiveFiles=asar.listPackage(asarFile).map(p=>p.replaceAll('\\','/').replace(/^\//,''));
 const sourceFiles=await files(path.join(candidate,'src'));
 const archivedSource=archiveFiles.filter(p=>p.startsWith('src/')&&!asar.statFile(asarFile,p).files).map(p=>p.slice(4)).sort();
 assert.deepEqual(archivedSource,sourceFiles,'exact src file set');
 for(const name of sourceFiles)assert.deepEqual(asar.extractFile(asarFile,`src/${name}`),await readFile(path.join(candidate,'src',name)),`source bytes ${name}`);
 const expected=JSON.parse(await readFile(path.join(candidate,'package.json'),'utf8'));
 const actual=JSON.parse(asar.extractFile(asarFile,'package.json').toString());
 for(const field of ['name','version','main','type','dependencies'])assert.deepEqual(actual[field],expected[field],`packaged identity ${field}`);
 assert.deepEqual(Object.keys(expected.dependencies),['three'],'Review any new production dependency');
 const dependencyFiles=await files(path.join(candidate,'node_modules','three'));
 const archivedDependency=archiveFiles.filter(p=>p.startsWith('node_modules/three/')&&!asar.statFile(asarFile,p).files).map(p=>p.slice('node_modules/three/'.length)).sort();
 assert.deepEqual(archivedDependency,dependencyFiles,'exact production dependency file set');
 for(const name of dependencyFiles)assert.deepEqual(asar.extractFile(asarFile,`node_modules/three/${name}`),await readFile(path.join(candidate,'node_modules','three',name)),`three bytes ${name}`);
 return {sourceFiles:sourceFiles.length,threeFiles:dependencyFiles.length,threeVersion:JSON.parse(asar.extractFile(asarFile,'node_modules/three/package.json')).version,packageLockSHA256:await hash(path.join(candidate,'package-lock.json'))};
}
