# The Unfinished Shapes 0.1-rc2

## Added

- Find installed Codex: bounded, read-only discovery with installation-source labels and explicit choice. No candidate is executed during discovery; use Connect to check the app-server protocol.
- Native file and repository-folder pickers.
- A per-user Windows Setup installer alongside Windows/Linux portable clients.
- Stable shared profile directory for portable and installed versions. Existing repository/Codex paths, exact game conversation ID and saved local world are retained across upgrades and reinstalls.
- Atomic allowlisted settings writes and explicit rejection of corrupt/future settings instead of resetting them.

## Data and permissions

On Windows the profile remains `%APPDATA%\the-unfinished-shapes`. Uninstalling leaves it intact. Back up this directory before manual edits or moving to another computer. The installer does not copy Codex login data or save world access tokens. External-world tokens still need entry each session.

Installing the app does not clone or relocate the player's repository. A saved workspace must still exist. Search does not prove a candidate supports the required experimental app-server dynamic tools, and will not silently replace a missing executable with another one.

## Verification gates

Publication requires Linux source/protocol/security tests and Electron smoke, plus Windows installer smoke using the previous RC1 portable build as its fixture: settings/world creation → RC2 install in another directory → exact restored workspace/Codex/thread ID → packaged WebGL startup → reinstall → uninstall preserving data. See the Actions run for this release commit for actual results.

No real model request is part of CI. Packages are unsigned and may trigger OS reputation warnings. This remains an early world-construction prototype, not a production MMO.
