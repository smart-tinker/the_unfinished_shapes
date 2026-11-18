import { safeUpdaterFailureCode, safeVerifierCode, safeVerifierErrorType } from '../src/update-package.mjs';

export function safeMainDiagnostics(live, manifestFile, assetName, tag) {
  const safeRootTarget = value => ({
    available: value?.available === true,
    sha256: typeof value?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : null,
  });
  return (Array.isArray(live) ? live : []).slice(0, 40).map(item => ({
    bundleIndex: Number.isInteger(item?.bundleIndex) && item.bundleIndex >= 0 && item.bundleIndex < 20 ? item.bundleIndex : null,
    bundleSha256: typeof item?.bundleSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.bundleSha256) ? item.bundleSha256 : null,
    stage: ['updater-module-import', 'download-verified-asset', 'main-catch-fallback', 'verify-start', 'verify-result', 'verifier-setup', 'verifier-verify'].includes(item?.stage) ? item.stage : 'unknown',
    status: ['starting', 'ready', 'synthetic-other', 'verified', 'rejected'].includes(item?.status)
      ? item.status : item?.stage === 'verify-start' ? 'started' : 'unknown',
    assetMatches: item?.assetName === assetName && item?.assetSha256 === manifestFile.sha256 && item?.tag === tag,
    ...(item?.status === 'rejected' ? {
      failureCode: safeUpdaterFailureCode(item.failureCode),
      verifierCode: safeVerifierCode(item.verifierCode, item.verifierErrorType),
      verifierErrorType: safeVerifierErrorType(item.verifierErrorType),
      verifierCauseCode: safeVerifierCode(item.verifierCauseCode),
      verifierCauseErrorType: safeVerifierErrorType(item.verifierCauseErrorType),
    } : {}),
    trustedRootTarget: safeRootTarget(item?.trustedRootTarget),
  }));
}
