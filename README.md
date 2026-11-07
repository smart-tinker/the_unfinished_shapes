# The Unfinished Shapes

A shared 3D construction world, with your own Codex as your companion.

**0.1-rc2 is an early playable vertical slice, not a production MMO.** Rendering runs on the player's machine. Models run only when the player sends a request, using their own installed and authenticated Codex. This project does not implement an agent harness or store model-provider credentials.

## Install or update

Windows: use the per-user Setup installer from Releases, or keep using the portable ZIP. Both editions share the same data folder: `%APPDATA%\the-unfinished-shapes`. Installing the next version does not replace your repository path, Codex path, conversation ID or local world. Uninstalling the app also leaves this data for a later reinstall. Back it up separately when needed.

In Settings, click **Find installed Codex** to see known executable locations, select a candidate, or use **Choose file…**. Search checks PATH and common npm, Codex desktop and editor locations, without running candidates or reading login/session files. Finding a binary does not certify its version; Connect checks the app-server handshake. Use **Choose folder…** for the game repository.

World access tokens remain session-only. Codex keeps its own login; the game does not copy, migrate or save its credentials. An unavailable path is not silently replaced by another installation.

## Run from source

Requires Node.js 24 and npm, a desktop with WebGL, and optionally an installed, signed-in Codex CLI with app-server support.

```sh
npm ci
npm start
```

The desktop client starts a private loopback world, persists it under Electron's application user-data directory, and creates a fresh in-memory local session token. No model is required to build manually. In Settings, choose the **absolute paths** to this repository and the Codex executable, then connect. On Windows choose the actual `codex.exe`, not a shell `.cmd` wrapper.

- Build blocks, bridges and ports using the palette.
- Move with WASD and navigate the camera with the mouse.
- Ask Codex for an existing construction using app-server game tools.
- Ask for an unknown mechanic to develop it in the local repository. It does **not** become server code automatically.

The first game conversation is created within the exact workspace path and its ID is retained for reconnects. If older non-game conversations exist, explicitly choose “Create a new game conversation”. App-server cannot add dynamic game tools to an arbitrary existing conversation, so the game does not silently replace or hijack it. Stop cancels the current turn. Approvals are not autoaccepted. This preview supports declining requests in the game; operations needing elevated approval must be handled in the user’s normal Codex workflow. The user must understand and approve any operation in their own Codex environment.

## Shared LAN world

Run the separate server using explicit user tokens and a data path. Keep it behind a trusted network; HTTP is plaintext. Use a TLS reverse proxy for untrusted networks. Never expose the developer desktop's loopback world publicly. Tokens are operator-managed; this release has no account signup, payment or permission-administration service.

See [server and permission contract](docs/server.md). Every command is authenticated and validated by the server, not trusted because an agent or client sent it. Builders can modify only their own objects; viewers cannot build. New code cannot grant itself deployment rights.

## Validation and packaging

```sh
npm test
npm run check
npm run package:linux
npm run package:win
npm run installer:win
```

Packaged folders appear under `dist/`. Portable packages are unsigned. Windows packaging does not prove Windows runtime behavior; verify on Windows before wider release. GitHub CI validates source and tests with read-only repository access. No automated deployment or secrets are configured.

## A new mechanic

1. Describe and implement the behavior in a branch of your workspace.
2. Add tests, including server permission and input-validation tests.
3. Run `npm run check`; open a reviewed change and pass CI.
4. An authorized operator chooses whether to deploy the tested version.
5. Only after deployment may players use the new mechanic.

A successful build alone is not a security review. Do not run player-submitted code inside the live world server, give clients production secrets, or allow a feature change to bypass independent review.

## Known release limits

- The first world contains primitive geometric constructions, not a full economy, physics simulation or asset marketplace.
- LAN state uses HTTP polling, bounded world state and JSON persistence, not large-scale infrastructure.
- No auto-updates, automatic clone/install flow, or production deployment. Users clone/download the repository and supply paths.
- Existing Codex permissions remain meaningful. Game chat cannot silently approve shell commands or server changes.
- Local game data is separate from Git. Back it up before upgrading world schemas.
