# The Unfinished Shapes

Read README.md and docs/server.md before changing mechanics. This is a desktop Electron/Three.js client with a Node authoritative world server and a thin Codex app-server adapter. Do not replace Codex's agent loop with a custom harness.

- `npm ci`; `npm run check` runs syntax checks and tests.
- `npm start` launches the desktop. `npm run server` runs the separately configured shared server.
- Add permission/input-validation tests for every new world command.
- Update the renderer, world validator and persistence validation together when adding a mechanic.
- Never execute submitted player code in the running world server. Source changes become game mechanics only after independent review, passing CI and an authorized deployment.
- World access tokens are operator-managed and must not be committed or printed.
- Existing game actions should use the `world_state` and `world_command` tools supplied by the game, when available. Do not invent successful tool results or claim a source edit is deployed.
- Do not edit user Codex session files. Conversation lifecycle goes through app-server.
- Do not change CI permissions or bypass tests to make a feature appear successful.
- Before release, distinguish unit/protocol tests, Electron smoke, Windows runtime and real model integration. Do not claim unrun checks passed.
