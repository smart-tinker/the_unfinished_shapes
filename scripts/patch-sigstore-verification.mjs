import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// shortcut: exact locked package versions only, update when package-lock changes.
async function assertVersion(packageName, expected) {
  const manifestPath = path.join(root, 'node_modules', packageName, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== expected) {
    throw new Error(`Unexpected ${packageName} version: ${manifest.version}`);
  }
}

function replaceLine(source, pattern, replacement, sentinel, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0 && source.includes(sentinel)) return source;
  if (matches.length !== 1) throw new Error(`Unexpected ${label} source`);
  return source.replace(pattern, (_, indent) => replacement(indent));
}

async function patchLine(relativePath, pattern, replacement, sentinel, label) {
  const filePath = path.join(root, 'node_modules', relativePath);
  const source = await readFile(filePath, 'utf8');
  const updated = replaceLine(source, pattern, replacement, sentinel, label);
  if (updated !== source) await writeFile(filePath, updated);
}

await assertVersion('@sigstore/core', '3.2.1');
await assertVersion('@tufjs/models', '4.1.0');

await patchLine(
  '@sigstore/core/dist/crypto.js',
  /^([ \t]*)return crypto_1\.default\.verify\(algorithm, data, key, signature\);(\r?)$/gm,
  indent => [
    `${indent}let verificationAlgorithm = algorithm;`,
    `${indent}if (verificationAlgorithm === undefined) {`,
    `${indent}  const keyType = key instanceof crypto_1.default.KeyObject`,
    `${indent}    ? key.asymmetricKeyType`,
    `${indent}    : crypto_1.default.createPublicKey(key).asymmetricKeyType;`,
    `${indent}  if (keyType === 'ec' || keyType === 'rsa') {`,
    `${indent}    verificationAlgorithm = 'sha256';`,
    `${indent}  }`,
    `${indent}}`,
    `${indent}return crypto_1.default.verify(verificationAlgorithm, data, key, signature);`,
  ].join('\n'),
  'const keyType = key instanceof crypto_1.default.KeyObject',
  'Sigstore core verifier',
);

const modelsVerifier = path.join(root, 'node_modules/@tufjs/models/dist/utils/verify.js');
let verifier = await readFile(modelsVerifier, 'utf8');
const oldSchemeParameter = 'const verifySignature = (metaDataSignedData, key, signature) => {';
const newSchemeParameter = 'const verifySignature = (metaDataSignedData, key, signature, scheme) => {';
const oldTufVerify = "return crypto_1.default.verify(undefined, canonicalData, key, Buffer.from(signature, 'hex'));";
const newTufVerify = `let hashAlgorithm;
    switch (scheme) {
        case 'ecdsa-sha2-nistp256':
        case 'rsassa-pss-sha256':
            hashAlgorithm = 'sha256';
            break;
        case 'ecdsa-sha2-nistp384':
        case 'rsassa-pss-sha384':
            hashAlgorithm = 'sha384';
            break;
        case 'rsassa-pss-sha512':
            hashAlgorithm = 'sha512';
            break;
    }
    return crypto_1.default.verify(hashAlgorithm, canonicalData, key, Buffer.from(signature, 'hex'));`;
const oldSchemeCount = verifier.split(oldSchemeParameter).length - 1;
const oldVerifyCount = verifier.split(oldTufVerify).length - 1;
const newSchemeCount = verifier.split(newSchemeParameter).length - 1;
const newVerifyCount = verifier.split(newTufVerify).length - 1;
if (oldSchemeCount === 1 && oldVerifyCount === 1 && newSchemeCount === 0 && newVerifyCount === 0) {
  verifier = verifier.replace(oldSchemeParameter, newSchemeParameter).replace(oldTufVerify, newTufVerify);
  await writeFile(modelsVerifier, verifier);
} else if (!(oldSchemeCount === 0 && oldVerifyCount === 0 && newSchemeCount === 1 && newVerifyCount === 1)) {
  throw new Error('Unexpected TUF verifier source');
}

await patchLine(
  '@tufjs/models/dist/key.js',
  /^([ \t]*)if \(!utils_1\.crypto\.verifySignature\(signedData, publicKey, signature\.sig\)\) \{(\r?)$/gm,
  indent => `${indent}if (!utils_1.crypto.verifySignature(signedData, publicKey, signature.sig, this.scheme)) {`,
  'signature.sig, this.scheme',
  'TUF key verifier',
);
