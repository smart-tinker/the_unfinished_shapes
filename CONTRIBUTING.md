# Changes and release candidates

1. Open one GitHub issue per feature or bug, with acceptance criteria and scope.
2. Implement each issue in its own branch. Every commit references that issue; do not mix unrelated changes.
3. Open a separate PR against the current RC branch, for example `release/0.1.0-rc3`, rather than merging candidate features directly into `main`.
4. Review and merge issue PRs sequentially after their checks pass. A green unit test is not a substitute for platform or real-model acceptance.
5. Test the assembled RC commit interactively on the authorized VM. Run native Ubuntu, Windows and macOS checks and real CPU-model acceptance. Record actual results, limitations and billing evidence.
6. Only publish GitHub Releases from the exact accepted RC commit. Publication is an explicit action, not a side effect of each feature merge. Never overwrite an already published tag or its assets.
7. Stable releases need the owner's separate approval. An RC is an intermediate version and must disclose remaining limitations.

Keep secrets and user data out of code, issues, logs and release assets. Do not copy private project material into this public repository. Use standard free GitHub-hosted runners for this public project; do not enable paid runners, signing services, expanded access or unsafe runtime options silently.

## Two explicit publication routes

After interactive VM acceptance and a successful real CPU-model run for the **exact RC SHA**, choose one route:

- Manually dispatch `Validate` on `release/0.1.0-rc3` with `publish_rc: true`.
- When dispatch is unavailable, explicitly create `publish/0.1.0-rc3` pointing to that same accepted SHA. This branch is a publication request, not a development branch. Do not create or push it before acceptance, and do not add commits to it.

Both routes rerun source and native platform checks. Before staging any release, the workflow verifies that `release/0.1.0-rc3` still points to `GITHUB_SHA` and that a completed successful CPU-model workflow exists for a push of that SHA on the RC branch. PR workflow metadata is not accepted as exact-checkout evidence because PR jobs may check out a synthetic merge commit. Both publication routes share one workflow concurrency group and never cancel an in-progress publication, serializing the entire Windows → macOS → Linux chain. Ordinary `release/**` pushes, feature merges and pull requests never publish. Interactive acceptance is an operator prerequisite; the workflow does not pretend to prove it automatically.

Existing release tags must resolve to the exact tested commit, including annotated tags. A missing tag may be created once at that SHA; a conflicting tag is rejected, never moved. Already published files are not overwritten. Draft staging is permitted only for the matching commit, and publication waits for the tested Windows, macOS and Linux packages.
