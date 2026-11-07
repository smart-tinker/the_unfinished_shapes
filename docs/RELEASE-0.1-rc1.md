# 0.1-rc1 release checklist

This release exercises the complete boundary: a rendered desktop world, authoritative build commands, persistent shared state, and a user-initiated Codex app-server conversation. It does not introduce autonomous AI loops or server-hosted model costs.

Before a public deployment: validate Windows runtime, test with two physical LAN clients, configure TLS and operator-managed credentials, review permissions and resource limits, and back up the world data. Review every new mechanic independently of its author's tests.

## Verified in the build environment

- Node.js 24 source syntax and 23 automated tests: protocol lifecycle, dynamic tools, two authenticated clients, roles/ownership, concurrent writes, persistence, corrupt data refusal.
- Dynamic game-tool handler tested against the real HTTP server; no model call was charged or run.
- App-server schema matched `codex-cli 0.166.0-alpha.1`, including experimental dynamic tools. Other Codex versions need compatibility verification.

## Not verified

- Local desktop visual smoke was blocked by execution-environment socket restrictions. The release workflow separately gates publication on Electron/Xvfb smoke: WebGL startup, build, repeated settings cancellation, persistence after restart and removal. See the successful workflow for the release commit; this is not a Windows runtime test.
- Real signed-in Codex/model turn; Windows execution; two physical machines over LAN.
- No production deployment, branch-protection changes, credentials, signing or auto-update system.
