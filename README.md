# The Unfinished Shapes

A shared 3D construction world, with your own Codex as your companion.

**The game is an early playable vertical slice, not a production MMO.** Rendering runs on the player's machine. An ordinary Codex turn starts when the player sends a request; a native Goal, when supported, can continue making progress in that conversation. Pausing or clearing a Goal does not necessarily stop a turn already running; stop that turn separately. Players use their own installed and authenticated Codex. This project does not implement an agent harness or store model-provider credentials.

## Install or update

Windows: use the per-user Setup installer from Releases, or keep using the portable ZIP. Both editions share the same data folder: `%APPDATA%\the-unfinished-shapes`. Installing the next version does not replace your repository path, Codex path, conversation ID or local world. Uninstalling the app also leaves this data for a later reinstall. Back it up separately when needed.

In Settings, click **Find installed Codex** to see known executable locations, select a candidate, or use **Choose file…**. Search checks PATH and common npm, Codex desktop and editor locations, without running candidates or reading login/session files. Finding a binary does not certify its version; Connect checks the app-server handshake. Use **Choose folder…** for the game repository.

World access tokens remain session-only. Codex keeps its own login; the game does not copy, migrate or save its credentials. An unavailable path is not silently replaced by another installation.

macOS: the candidate package targets Apple Silicon arm64 only. It uses an ad-hoc integrity signature and is not notarized. Intel Macs are not covered by this release. Linux CPU-rendering evidence and its limits are documented in [graphics validation](docs/GRAPHICS.md).

## Run from source

Requires Node.js 24 and npm, a desktop with WebGL, and optionally an installed, signed-in Codex CLI with app-server support.

```sh
npm ci
npm start
```

The desktop client starts a private loopback world, persists it under Electron's application user-data directory, and creates a fresh in-memory local session token. No model is required to build manually. In Settings, choose the **absolute paths** to this repository and the Codex executable, then connect. On Windows choose the actual `codex.exe`, not a shell `.cmd` wrapper.

- Build blocks, bridges and ports using the palette.
- Select an existing object to edit position, size, color, solid-side collision and whether its top supports players. Stale edits are rejected by the server rather than silently overwriting another change.
- Inspect agent activity for requested actions, confirmed results and stop reasons, without private model reasoning.
- Move with WASD at up to 5 world units per second, jump with Space, and navigate the camera with the mouse. The server stops player movement at the 48×48 island edge and resolves solid sides and walkable tops. Agent movement uses the same server physics.
- Use **Full screen** or **F11** to toggle the game window. **Escape** closes an open dialog or cancels a local drag before it exits fullscreen.
- Ask Codex for an existing construction using app-server game tools.
- Ask for an unknown mechanic to develop it in the local repository. It does **not** become server code automatically.

The first game conversation is created within the exact workspace path and its ID is retained for reconnects. If older non-game conversations exist, explicitly choose “Create a new game conversation”. App-server cannot add dynamic game tools to an arbitrary existing conversation, so the game does not silently replace or hijack it. After reconnecting, the game warns that a resumed conversation retains its creation-time tools. Choose a new game conversation explicitly to use updated tools; the previous conversation and history are preserved. Stop cancels the current turn. Approvals are not autoaccepted. This preview supports declining requests in the game; operations needing elevated approval must be handled in the user’s normal Codex workflow. The user must understand and approve any operation in their own Codex environment.

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
# On native macOS arm64 only:
node scripts/package-macos.mjs
```

Packaged folders appear under `dist/`. Windows binaries are unsigned; macOS arm64 uses an ad-hoc signature without notarization. Windows packaging does not prove Windows runtime behavior; verify on Windows before wider release. GitHub CI validates source and tests with read-only repository access. Manual staging builds each candidate once, tests its final installer and extracted archives, and preserves those same files and SHA-256 hashes in a new draft. A separate manual publish verifies that candidate and promotes the draft without rebuilding. Ordinary CI does not publish releases or deploy the world server.

Release candidates use [issue-scoped PRs and an RC branch](CONTRIBUTING.md). Publication is explicit, after native platform checks, [real CPU-model acceptance](docs/LOCAL-MODEL-E2E.md) within the same staging workflow and interactive testing of the exact candidate files. Acceptance uses current-candidate fixtures, not previous releases or historical passing runs. See [rc8 notes](docs/RELEASE-0.1-rc8.md).

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

CPU-model acceptance validates every construction request and its persisted object: exact requested parameters, ownership, unique IDs and matching counts. Multiple valid construction calls execute independently; no duplicate-suppression guard is installed. At least one genuine construction is required.
