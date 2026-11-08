import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
export async function verifyInstalledIdentity(executable,stage) {
 const asar=path.join(path.dirname(executable),'resources','app.asar');
 const actual={executable:await hash(executable),asar:await hash(asar)};
 assert.equal(actual.asar,process.env.TUS_RETAINED_ASAR_SHA256,'installed ASAR equals retained portable before/after launch');
 assert.equal(actual.executable,process.env.TUS_RETAINED_EXE_SHA256,'installed Electron executable equals retained portable');
 console.log(JSON.stringify({event:'retained-installed-identity',stage,...actual}));
}
