export async function runWindowsUpdaterScenarios({ portable, installer }) {
  const portableResult = await portable();
  const installerResult = await installer();
  return {
    portable: { status: 'fulfilled', value: portableResult },
    installer: { status: 'fulfilled', value: installerResult },
  };
}
