# The Unfinished Shapes 0.1-rc3

This candidate integrates issue-scoped changes into `release/0.1.0-rc3`. The release pipeline now separates manual staging from manual publication; merging a feature does not publish it. The existing RC3 draft is not reused by this pipeline. A fresh candidate version and tag require an owner decision. See [release procedure](../CONTRIBUTING.md).

## Scope

- #1: edit object position, size and color, with server-side owner/admin checks and atomic stale-value conflict detection. Conflicts preserve the draft; no blind write retry.
- #2: agent activity shows requested actions, explicit plans, confirmed results and stop reasons, correlated to their connection/thread/turn/call. Private reasoning is not displayed.
- #3: native Apple Silicon macOS tests and packaging, alongside Linux and Windows checks.
- #4/#15: real CPU-model construction with dedicated `world_build`, requiring explicit type, position, size and color. The verified result covers one bounded supplied design, not general model competence.
- #5: explicit CPU-rendering validation; ordinary rendering remains the default. See [graphics evidence](GRAPHICS.md).
- #12: wire observation confirmed that all original union variants reached the provider. The command schema was flattened for compatibility; #15 then separated construction to enforce every design field. This is not a claim about the model's internal root cause.
- #14: warn that resumed conversations retain their original tools. Updated tools require an explicit new-game-conversation choice; old history is preserved. PR #17 passed native platform CI and was merged as `3725e87b495c5e2f2c09c5148abe823fdd30c7ac`.

## Pre-assembly evidence and release gates

[CPU run 42403913082](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42403913082) passed on `198063e5f085622fbe81aa165ce1bb6a0d015a4d`: **236,495 ms**, exactly one `world_build`, non-default color **#3366cc**, one matching persisted block, and positive CPU-only allocation evidence. Reported Ubuntu billable time was **0 ms**; wall time was **277,000 ms**. See [full test scope](LOCAL-MODEL-E2E.md).

PR #16 (#15) and PR #10 (#4) were merged into RC commit `eb6d03a`, whose source tree matches the tested candidate (`ec83803efa5012b39282bbd5ee2a5e9c41c6410e`). This source equivalence does not replace an exact-commit release gate.

Interactive VM startup, object editing and removal passed on candidate `198063e5`, built from the verified source tree. This is candidate evidence, not final-release GUI acceptance.

Current CPU acceptance requires at least one genuine valid `world_build`. Every call must match the requested design and succeed; every resulting object must have matching parameters and owner, a unique ID, and the total persisted count must equal the successful valid calls. Repeated valid construction requests execute independently. This checks game execution, not whether the model obeyed the requested call count. Historical single-build results above are preserved; revised acceptance still requires its own final-commit run.

Publication requires source tests, native Linux/Windows/macOS package checks, real CPU-model acceptance within the candidate staging workflow, and interactive GUI acceptance of the exact candidate files. The publish operation verifies that candidate’s successful staging attempt, source SHA, immutable tag and file hashes without rebuilding. Historical runs above are context only and are not consulted for acceptance; interactive acceptance remains an operator prerequisite.

Resolve the final commit from this release's tag and inspect its [Actions runs](https://github.com/smart-tinker/the_unfinished_shapes/actions). The evidence above predates final assembly and is not a claim that those final checks have already passed. Final results must be recorded against the accepted SHA before publishing that same unchanged commit.

## Limits

This is a small construction-world prototype, not a production MMO. Block, bridge and port are geometric constructions, without a shipping economy or autonomous NPC inference. New mechanics require code review, tests and a separate authorized deployment; source edits do not alter a running world automatically.

Codex uses the user's installed app-server and authentication. CI uses a real local CPU model, not a paid model API. The hosted acceptance passed, but this VM's local Codex startup remains blocked by its sandbox-helper error; no sandbox bypass was used.

macOS targets **Apple Silicon arm64 only**, with an ad-hoc integrity signature and **no notarization**; Intel support is untested. Windows binaries are **unsigned**. Settings, local world and saved game thread ID are retained; world tokens stay session-only.

Linux Mesa/llvmpipe context creation remains unresolved on the test VM. Explicit SwiftShader rendered the earlier tested build, with Chromium's software-WebGL warning. No unsafe opt-in or sandbox disabling was used for that interactive check. It remains a temporary diagnostic mode, not a default or a guarantee for the final candidate.
