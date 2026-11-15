const version = process.env.TUS_SMOKE_UPDATE_BASELINE_VERSION;
if (process.versions.electron && process.type === 'browser' && version) {
  if (!/^0\.1\.0-rc\.1$/.test(version)) throw new Error('Invalid updater smoke baseline version.');
  const { app } = require('electron');
  app.getVersion = () => version;
  if (app.getVersion() !== version) throw new Error('Updater smoke baseline version hook did not apply.');
}
