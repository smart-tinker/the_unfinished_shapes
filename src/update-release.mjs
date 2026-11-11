const releaseTag = /^(?:v)?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-rc\\.?(0|[1-9]\\d*))?$/;

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
