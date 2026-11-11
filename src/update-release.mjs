const releaseTag = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.?(0|[1-9]\d*))?$/;
const releasesUrl = 'https://api.github.com/repos/smart-tinker/the_unfinished_shapes/releases';

export function parseReleaseTag(value) {
  if (typeof value !== 'string') return null;
  const match = releaseTag.exec(value);
  if (!match) return null;
  const [, major, minor, patch, rc] = match;
  const numbers = [major, minor, patch, rc].filter(value => value !== undefined).map(Number);
  if (numbers.some(value => !Number.isSafeInteger(value)) || (rc !== undefined && Number(rc) < 1)) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch),
    prereleaseNumber: rc === undefined ? null : Number(rc) };
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseTag(left), b = parseReleaseTag(right);
  if (!a || !b) throw new Error('Unsupported TUS release version.');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prereleaseNumber === null) return b.prereleaseNumber === null ? 0 : 1;
  if (b.prereleaseNumber === null) return -1;
  return Math.sign(a.prereleaseNumber - b.prereleaseNumber);
}

export function releaseRelation(candidate, current) {
  const order = compareReleaseVersions(candidate, current);
  return order > 0 ? 'update' : order < 0 ? 'downgrade' : 'current';
}

export function selectReleaseCandidates(releases) {
  if (!Array.isArray(releases)) throw new Error('Invalid releases response.');
  const result = { stable: null, prerelease: null };
  for (const release of releases) {
    if (!release || release.draft !== false || typeof release.prerelease !== 'boolean') continue;
    const version = parseReleaseTag(release.tag_name);
    if (!version || (version.prereleaseNumber !== null) !== release.prerelease) continue;
    const channel = release.prerelease ? 'prerelease' : 'stable';
    const current = result[channel];
    const order = current ? compareReleaseVersions(release.tag_name, current.tag_name) : 1;
    if (order > 0 || (order === 0 && release.tag_name < current.tag_name)) result[channel] = release;
  }
  return result;
}

export async function listPublishedReleases(fetcher = fetch, { signal = AbortSignal.timeout(5000), maxPages = 10 } = {}) {
  if (typeof fetcher !== 'function' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('Invalid release check limits.');
  const releases = [];
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetcher(`${releasesUrl}?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json' }, signal, redirect: 'error',
    });
    if (!response || !Number.isInteger(response.status)) throw new Error('Invalid GitHub releases response.');
    if (!response.ok) {
      if (response.status === 429 || (response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0')) {
        throw new Error('GitHub release check rate limit reached.');
      }
      throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
    }
    let pageReleases;
    try { pageReleases = await response.json(); } catch { throw new Error('Invalid releases response.'); }
    if (!Array.isArray(pageReleases) || pageReleases.length > 100) throw new Error('Invalid releases response.');
    releases.push(...pageReleases);
    if (pageReleases.length < 100) return selectReleaseCandidates(releases);
  }
  throw new Error('GitHub release check page limit reached.');
}

function assetVersion(tag) {
  const version = parseReleaseTag(tag);
  if (!version) return null;
  return `${version.major}.${version.minor}.${version.patch}${version.prereleaseNumber === null ? '' : `-rc.${version.prereleaseNumber}`}`;
}

export function selectReleaseAsset(release, { platform, architecture, distribution }) {
  if (!release || release.draft !== false || typeof release.prerelease !== 'boolean') return null;
  const version = assetVersion(release.tag_name);
  if (!version) return null;
  if ((parseReleaseTag(release.tag_name).prereleaseNumber !== null) !== release.prerelease) return null;
  let suffix;
  if (platform === 'win32' && architecture === 'x64' && distribution === 'installer') suffix = 'Setup-x64.exe';
  else if (platform === 'win32' && architecture === 'x64' && distribution === 'portable') suffix = 'win32-x64.zip';
  else if (platform === 'linux' && architecture === 'x64' && distribution === 'archive') suffix = 'linux-x64.tar.gz';
  else if (platform === 'darwin' && architecture === 'arm64' && distribution === 'archive') suffix = 'darwin-arm64.zip';
  else return null;
  const name = `TheUnfinishedShapes-${version}-${suffix}`;
  const asset = release.assets?.find(item => item?.name === name);
  if (!asset) return null;
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 500_000_000 ||
      typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('Release asset is missing a valid SHA-256 digest or size.');
  }
  const expectedPath = `/smart-tinker/the_unfinished_shapes/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
  let url;
  try { url = new URL(asset.browser_download_url); } catch { throw new Error('Release asset does not use an official GitHub download URL.'); }
  if (url.origin !== 'https://github.com' || url.pathname !== expectedPath || url.search || url.hash) {
    throw new Error('Release asset does not use an official GitHub download URL.');
  }
  return asset;
}

export function startupUpdateOptions(releases, currentVersion) {
  if (!releases || typeof releases !== 'object') throw new Error('Invalid release candidates.');
  const option = release => release ? {
    release: { tag_name: release.tag_name },
    relation: releaseRelation(release.tag_name, currentVersion),
  } : null;
  const stableRelease = releases.stable || null;
  const prereleaseRelease = releases.prerelease || null;
  return {
    stable: option(stableRelease),
    prerelease: prereleaseRelease && (!stableRelease || compareReleaseVersions(prereleaseRelease.tag_name, stableRelease.tag_name) > 0)
      ? option(prereleaseRelease) : null,
  };
}
