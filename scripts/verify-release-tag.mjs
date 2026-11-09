import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/i;

async function ghResponse(args, run) {
  let output;
  try {
    output = (await run('gh', args, { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout;
  } catch (error) {
    // gh returns nonzero for HTTP errors. Only a parsed HTTP response can establish 404.
    output = error.stdout;
  }
  if (typeof output !== 'string') throw new Error('GitHub tag request failed without an HTTP response.');
  const separator = /\r?\n\r?\n/.exec(output);
  const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/.exec(output);
  if (!separator || !status) throw new Error('GitHub tag request returned an invalid HTTP response.');
  let data;
  try { data = JSON.parse(output.slice(separator.index + separator[0].length)); }
  catch { throw new Error('GitHub tag request returned invalid JSON.'); }
  return { status: Number(status[1]), data };
}

export function ghRequest(run = execute) {
  return async endpoint => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ghResponse(['api', '--method', 'GET', '--include', endpoint], run);
      } catch (error) {
        if (attempt >= 2 || !/GitHub tag request (?:failed without an HTTP response|returned an invalid HTTP response)\\.$/.test(error.message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  };
}

export function ghCreateTag(run = execute) {
  return (repository, tag, sha) => ghResponse(['api', '--method', 'POST', '--include', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`], run);
}

export async function verifyReleaseTag({ repository, tag, expectedSha, allowMissing = false, request = ghRequest(), maxTagDepth = 8 }) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => ['.', '..'].includes(part))) throw new Error('Invalid repository name.');
  if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag) || tag.includes('..') || tag.includes('//') || tag.endsWith('/') || tag.endsWith('.lock')) throw new Error('Invalid release tag name.');
  if (typeof expectedSha !== 'string' || !SHA.test(expectedSha)) throw new Error('An exact 40-character GITHUB_SHA is required.');
  if (!Number.isInteger(maxTagDepth) || maxTagDepth < 1 || maxTagDepth > 16) throw new Error('Invalid annotated-tag depth limit.');
  const expected = expectedSha.toLowerCase();
  const base = `repos/${repository}/git`;
  const response = await request(`${base}/ref/tags/${encodeURIComponent(tag)}`);
  if (response.status === 404 && allowMissing) return { missing: true };
  if (response.status !== 200) throw new Error(`Release tag lookup failed (HTTP ${response.status}); tag verification is required.`);
  if (response.data?.ref !== `refs/tags/${tag}`) throw new Error('GitHub returned a different tag ref.');
  let object = response.data.object;
  const seen = new Set();
  for (let depth = 0; ; depth++) {
    if (!object || typeof object.sha !== 'string' || !SHA.test(object.sha)) throw new Error('Tag object has an invalid SHA.');
    const sha = object.sha.toLowerCase();
    if (object.type === 'commit') {
      if (sha !== expected) throw new Error(`Release tag points to ${sha}, not tested commit ${expected}; refusing to retag or publish.`);
      return { missing: false, sha, annotatedTags: depth };
    }
    if (object.type !== 'tag') throw new Error('Release tag does not resolve to a commit.');
    if (depth >= maxTagDepth || seen.has(sha)) throw new Error('Annotated-tag chain is cyclic or exceeds the depth limit.');
    seen.add(sha);
    const annotated = await request(`${base}/tags/${sha}`);
    if (annotated.status !== 200) throw new Error(`Annotated-tag lookup failed (HTTP ${annotated.status}).`);
    if (annotated.data?.sha?.toLowerCase() !== sha) throw new Error('GitHub returned a different annotated tag object.');
    object = annotated.data.object;
  }
}

export async function ensureReleaseTag(options, create = ghCreateTag()) {
  const existing = await verifyReleaseTag({ ...options, allowMissing: true });
  if (!existing.missing) return { ...existing, created: false };
  // Creation is allowed only after an exact ref lookup returned 404. Never PATCH or retag.
  const response = await create(options.repository, options.tag, options.expectedSha.toLowerCase());
  if (![201, 409, 422].includes(response.status)) throw new Error(`Release tag creation failed (HTTP ${response.status}).`);
  // A racing creator may have won. Accept only a read proving the exact tested commit.
  const verified = await verifyReleaseTag({ ...options, allowMissing: false });
  return { ...verified, created: response.status === 201 };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [tag, option, ...extra] = process.argv.slice(2);
    if (extra.length || (option !== undefined && !['--allow-missing', '--create-missing'].includes(option))) throw new Error('Usage: node scripts/verify-release-tag.mjs TAG [--allow-missing|--create-missing]');
    const options = { repository: process.env.GITHUB_REPOSITORY, expectedSha: process.env.GITHUB_SHA, tag, allowMissing: option === '--allow-missing' };
    const result = option === '--create-missing' ? await ensureReleaseTag(options) : await verifyReleaseTag(options);
    console.log(result.missing ? `Tag ${tag} is absent before release creation.` : `Tag ${tag} resolves to tested commit ${result.sha}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
