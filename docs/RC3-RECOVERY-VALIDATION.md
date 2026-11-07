# Immutable rc3 recovery validation

This proposed workflow validates packaging with a corrected external graphics smoke harness. It does not publish, upload assets, move tags or change version. Source remains `867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488`, tree `e78ce3b60655514fccd8426c0c7b32de710b72be`, version 0.1.0-rc.3. The existing rc3 tag must resolve to that commit.

## Execution contract

Before execution, review the exact recovery PR head revision. A new workflow need not be merged into main: open a same-repository PR from exactly `recovery/rc3-graphics-validation` into `release/0.1.0-rc3`, changing one of the workflow's scoped files. Its read-only PR validation is the initial supported launch route. Forks and other head/base branches are excluded.

Manual dispatch on `recovery/rc3-graphics-validation` is an alternative only after GitHub has registered the workflow on the default branch; do not assume a new branch-only workflow is dispatchable. This review is an operator gate, not something the workflow can grant itself. No arbitrary source or workflow ref input is accepted. At runtime, recovery checkout SHA, run SHA and workflow-definition SHA must match. For a PR these identify the synthetic merge, not the reviewed PR head. The helper additionally verifies that its two parents are exactly the event base SHA followed by the PR head SHA; provenance records all three identities separately. Review includes the base revision and resulting merge contents, not only the head. The immutable application source is still checked out independently at 867b5fa.

All three standard public runners install dependencies from the immutable candidate lockfile and run its tests. The corrected harness lives outside the candidate and resolves dependencies through its node_modules. Packaging reads only the unchanged candidate; tracked-source cleanliness and packaged src bytes are checked again for provenance.

- Linux: source and packaged full smoke use explicit SwiftShader with the previously existing Linux CI sandbox exception, no new unsafe flags. Assert healthy context/backend at startup and restart.
- macOS arm64: native source and packaged full smoke, normal platform launch flags, ad-hoc signing only.
- Windows: native portable packaging and installer build, clean install, migration, reinstall and data-retention smoke. Every installer GUI launch uses the stronger graphics assertion. The installed app comes from the same prepackaged folder used for the portable ZIP. The generic discovery smoke is not run on Windows because its fake Unix Codex executable is not a valid Windows fixture.

The exact-source successful CPU workflow is verified separately, requiring RC-branch push provenance. Optional VM fields are only operator attestations and public evidence references; they are explicitly marked as not GUI verification by this workflow. Missing public VM documentation must not block diagnostics, but publication still requires reviewed exact-source GUI evidence.

## Outputs and later publication

Each platform logs source SHA/tree, recovery SHA/tree, run identity, runtime versions, app.asar hash and final archive/installer hashes. No Actions cache or artifact uploads are configured. Therefore these ephemeral output files are **not preserved** for later publication; log hashes alone cannot retrieve them.

A future separately authorized finalization must retain or rebuild and retest the exact binaries, verify all platform provenance and the immutable rc3 tag, and verify the exact complete asset set and hashes before publication. Never mix existing draft assets with newly tested outputs merely because filenames match. Rebuilding changes compressed archive hashes unless reproducibility is established. A publisher must not run npm or execute candidate code, and must serialize with the existing publication chain. This validation workflow deliberately has no publisher or release write token.

Local syntax/static tests do not prove cross-platform execution. Native execution and final GUI review remain required before any recovery release can be described as validated.
