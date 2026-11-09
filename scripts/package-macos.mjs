import { packager } from '@electron/packager';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build this target natively on macOS arm64. A cross-build is not native validation.');
}
const outputs = await packager({
  dir: '.', name: 'TheUnfinishedShapes', platform: 'darwin', arch: 'arm64',
  appBundleId: 'com.smarttinker.theunfinishedshapes', out: 'dist', overwrite: true,
  ignore: [/^\/test(?:\/|$)/, /^\/dist(?:\/|$)/],
  // Local ad-hoc integrity signature only: no Developer ID, certificate or notarization service.
  osxSign: {
    identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' })
  }
});
console.log(`Native macOS arm64 package: ${outputs.join(', ')}`);
