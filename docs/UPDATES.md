# In-app updates

TUS checks the public releases for this repository. Drafts are ignored. It selects the numerically newest stable and prerelease independently; tags accept the historical `v0.1.0-rc11` and current `v0.1.0-rc.11` forms. Stable is greater than a prerelease with the same numeric version. Equal or older versions are not updates, and the app never installs a downgrade automatically.

The saved channel defaults to **Stable**. **Prerelease** is an explicit user choice and can be saved. Startup checking is bounded and does not block the world or Codex connection. The UI requires a manual check, a user-started download, and an explicit launch confirmation.

Before a package can be opened, TUS checks its published SHA-256 digest and GitHub build provenance. The provenance must identify this repository's `.github/workflows/stage-release.yml`, the release branch for the selected tag, and the same asset digest. Only supported platform/package pairs are offered:

- Windows x64: NSIS installer or portable ZIP.
- Linux x64: tar.gz archive.
- macOS arm64: ZIP application bundle.

Portable/archive packages are extracted to a user-selected directory with path and size limits. The application asks before quitting and launching the verified installer or extracted executable. It does not silently replace a running executable. Release metadata is fetched without GitHub credentials.

## Packaged CI acceptance

`scripts/updater-release-smoke.mjs` runs in the existing standard Linux, Windows, and macOS validation jobs. Before packaging, each disposable runner checkout sets its package metadata to `0.1.0-rc.1` so the current published prerelease can be exercised without publishing a test release. This changes only runner-local package files; it does not change product source or release metadata.

The smoke test drives the packaged UI, selects and persists the prerelease channel, verifies the exact platform asset against its public release manifest, downloads it through the application, and checks the explicit cancel/launch handoff. Linux and macOS launch the downloaded archive. Windows exercises both portable and installer selection; the downloaded installer and portable executable are then passed to the existing isolated installer/reinstall/data-preservation smoke test. No Codex profile, model turn, Actions artifact, cache, or release mutation is used.
