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

## Issue-sized changes and evidence

- Re-read the issue, linked PRs and current target branch before starting. Use one observable outcome per implementation PR; state scope, non-goals and unresolved product decisions. Do not duplicate work already in progress.
- Map each DoD criterion to a check and evidence. Keep the specification stable and one dated current-status section instead of accumulating contradictory final summaries.
- For a regression, demonstrate the missing behavior before the fix, then rerun on the final code. An import/setup failure is not evidence that the behavioral assertion failed. Validate changed test scripts too; never weaken assertions to obtain green.
- Record exact source/head SHA, command/scenario, environment and result. Distinguish PASS, FAIL, UNRUN, BLOCKED and INVALID evidence. Recheck PR head and checks after the last edit; old green checks do not validate a new SHA.
- Treat implemented, tested, merged, packaged, published and accepted as separate stages. A model's success text is not proof of world state; verify the server and persisted result. Mock/protocol tests do not replace native app-server, real-model or packaged GUI evidence.
- Use checks proportionate to the change; exercise applicable stale responses, repeated actions, cancellation, reconnect and restart. Report unavailable platforms explicitly. Do not dispatch paid checks, publish, merge or deploy without the corresponding authorization.

## Shared-world invariants

- A construction/edit preview is client-local until explicit Apply: no server mutation, revision change, peer-visible object or persisted draft. Cancel discards only that local draft.
- The server is authoritative for identity, roles, validation and committed state. Revalidate the target world, object IDs and expected values on Apply; stale or conflicting state must not silently overwrite another player's changes.
- Keep client rendering/input, command validation and persistence/schema compatibility aligned. For changed world behavior, verify two-client agreement and save/reload where applicable; preserve old saves without silent resets.
- Applied multiplayer changes require explicit follow-up actions (for example remove). Do not introduce a general undo/rollback of shared history.
- Do not silently decide undefined world semantics such as boundaries, walking versus teleporting, or disconnected-player physics. Record the open decision and its effect on acceptance before implementing it.
