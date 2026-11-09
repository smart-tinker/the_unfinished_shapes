# Changes and release candidates

1. Open one GitHub issue per feature or bug, with acceptance criteria and scope.
2. Implement each issue in its own branch. Every commit references that issue; do not mix unrelated changes.
3. Open a separate PR against the current RC branch, for example `release/0.1.0-rc3`, rather than merging candidate features directly into `main`.
4. Review and merge issue PRs sequentially after their checks pass. A green unit test is not a substitute for platform or real-model acceptance.
5. Run candidate acceptance in GitHub Actions on standard Linux, Windows and macOS runners, plus real CPU-model acceptance. Record actual results and limitations; automated checks do not establish interactive desktop or hardware-GPU compatibility.
6. Only publish GitHub Releases from the exact accepted RC commit. Publication is an explicit action, not a side effect of each feature merge. Never overwrite an already published tag or its assets.
7. Stable releases need the owner's separate approval. An RC is an intermediate version and must disclose remaining limitations.

Keep secrets and user data out of code, issues, logs and release assets. Do not copy private project material into this public repository. Use standard free GitHub-hosted runners for this public project; do not enable paid runners, signing services, expanded access or unsafe runtime options silently.

## Build once, test, stage, then publish

Ordinary `Validate` CI is read-only. Pushes and PRs do not create a release or publish anything. There is no publication-branch shortcut.

1. Review the candidate code and version on its matching `release/<version>` branch, for example package version `0.1.0-rc.4` on `release/0.1.0-rc4`. An authorized owner must explicitly create the corresponding immutable tag (for example `v0.1.0-rc4`) at that exact commit. The workflows never create or move tags.
2. Manually dispatch **Stage release candidate** on that branch. Preflight requires the branch head, checked-out commit and existing tag to match, and refuses any existing release for the tag. A 403 or other uncertain lookup is an error, never permission to create or retry through another route.
3. The same staging workflow runs real CPU-model acceptance for this exact candidate using the existing read-only reusable model job. It does not inherit a PASS from an earlier run. Only after that succeeds is a new empty draft created.
4. Native Windows x64, macOS arm64 and Linux x64 jobs each build their definitive files once. They archive first, record SHA-256 and sizes, extract those final archives into clean directories, and test the extracted apps. Windows also tests the exact final Setup executable: clean installation, current-candidate synthetic settings/world, restart, portable data access, reinstall, uninstall retention and reinstall after uninstall. There are no old-version binaries or migration fixtures in acceptance.
5. Each job rechecks the original file hashes after testing and uploads those same files plus `candidate-<platform>.json` to the new draft. A manifest binds filenames, sizes and SHA-256 to source SHA, staging run ID and attempt. Uploads never overwrite files. No Actions artifacts or paid runners are used.
6. Review the successful staging run and disclose the automated test scope for those candidate files. Only then explicitly dispatch **Publish staged candidate** on the unchanged candidate branch, supplying that staging run ID. It downloads this candidate, checks the complete expected file set, manifests, hashes, exact tag/source and successful staging attempt, then publishes the same draft as a prerelease. It performs no build, model run or file upload.

The staging build/test/upload jobs have `contents: write` for the **whole job**, not only the upload step. The create-draft and publish jobs are also privileged; publish additionally reads the selected staging run. These workflows are for trusted, reviewed release-branch code only. They do not expand ordinary CI or retained-asset-test permissions. GitHub workflow dispatch requires repository write access; dispatch is the explicit request to stage or publish. Interactive desktop acceptance is separate evidence and must not be claimed from CI.

Both workflows share one non-cancelling concurrency group. Hash checks compare this candidate's own bytes before/after testing and after download, not older releases or historical results. Graphics failures remain failing gates throughout each launch, including immediately before close; Linux and Windows runner smoke explicitly select SwiftShader; normal application startup is unchanged. No unsafe software-rendering opt-in is enabled.

### Operational prerequisites and partial failures

New manually dispatched workflows must first be registered on the repository's default branch before GitHub exposes their dispatch route. Registration and candidate/tag preparation are explicit release operations. When registering the workflows, also migrate the default branch to this read-only CI; do not leave an older automatic publication job active.

For the authorized RC3 recovery, preserve the unpublished old draft and all its assets under an archive tag pointing to its original commit before preparing `v0.1.0-rc3` at the accepted source. Then stage a new empty RC3 draft. This exception applies only to the unpublished candidate; never move a published tag or replace published assets.

A failed staging run may leave an empty or partial draft. A full rerun refuses that existing release; rerunning failed jobs rejects cached draft outputs from a previous attempt before building or uploading. This intentionally has no resume/reset mechanism. Choose a fresh candidate, or stop for a separate owner decision about cleanup. Never delete assets, change a tag, reuse old manifests or overwrite files to turn a failed candidate green.

Unit/protocol tests, packaged runtime/graphics tests, Windows installer lifecycle, real CPU-model acceptance and interactive testing are distinct evidence. A local test pass is not a claim that native packages or a model run passed. Unsigned Windows and non-notarized Apple Silicon-only macOS limitations remain. Graphics failure on a runner must be investigated, not hidden by weakened security settings.
