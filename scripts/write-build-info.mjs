import { readFile, writeFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sourceSha = /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null;
const info = { version: packageJson.version, sourceSha };
await writeFile(new URL('../build-info.json', import.meta.url), `${JSON.stringify(info)}\n`);
