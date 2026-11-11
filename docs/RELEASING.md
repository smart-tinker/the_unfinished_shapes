# Release policy

This is the canonical TUS release lifecycle. README, AGENTS.md and CONTRIBUTING.md link here instead of maintaining separate release checklists. This policy describes current GitHub workflows and the additional acceptance evidence they do not provide; changing the policy does not itself authorize a release.

## Release states and GitHub flags

`draft`, `prerelease` and `Latest` describe different things. A draft is not public; a pre-release is published but marked as unstable; Latest identifies GitHub's recommended release.

| State | `draft` | `prerelease` | Latest |
| --- | --- | --- | --- |
| Candidate being prepared | true | set for the RC candidate | no |
| Published release candidate | false | true | no |
| Recommended stable release | false | false | yes |

A release may be both a draft and a pre-release while it is being prepared. Do not publish a draft merely to make it visible. A published RC is an intermediate release and must disclose its remaining limitations.

## Versions and immutable tags

- New package versions use numeric SemVer RC suffixes such as `0.1.0-rc.12`, so `rc.10` sorts after `rc.9`.
- Current staging tooling maps package version `0.1.0-rc.12` to Git tag `v0.1.0-rc12` and branch `release/0.1.0-rc12`. It does not currently accept the dotted Git tag `v0.1.0-rc.12`; change that only in a separately tested tooling update.
- Historical tags, including `v0.1.0-rc11`, are immutable. Never rename or move a published tag, or replace its assets.
- The release owner creates the exact tag at the accepted commit. Stage preflight verifies the tag, branch head and checked-out source agree; workflows do not create or move tags.
- Each corrected candidate gets a new version/tag. Do not turn an RC into stable by clearing its prerelease flag.

## Current RC workflow

1. Merge issue-scoped PRs sequentially to the current release line (for example, `release/0.1.0-rc11`). Require the normal PR validation and security checks. Details of the PR and release runner layout are in [CI acceptance](CI.md).
2. Choose the next RC version and, from the accepted commit on that release line, create the matching candidate branch and immutable tag. For package version `0.1.0-rc.12`, current tooling expects branch `release/0.1.0-rc12` and tag `v0.1.0-rc12`. The branch and tag must resolve to the same accepted commit.
3. Manually dispatch [Stage release candidate](../.github/workflows/stage-release.yml) from that release branch. Preflight requires a public repository, the matching branch, tag and source SHA, and no existing release for the tag. An uncertain GitHub lookup or permission error is a failure; do not retry through a different route.
4. After preflight and fast checks, staging creates a new empty draft. Linux x64, Windows x64 and macOS arm64 each build their final package once, test the final extracted package, and upload those same bytes with a manifest. Windows also tests the exact Setup installer. A separate Linux CPU job runs the real-model acceptance scenario. The complete staging run must succeed.
5. Review the successful run and each platform result. Perform any required interactive desktop or hardware acceptance against the exact staged files; CI does not prove those results. Record the source/tag SHA, run and attempt, package names and SHA-256 hashes, environment, and PASS/FAIL/UNRUN/BLOCKED for each gate.
6. Only after every required gate passes, explicitly dispatch [Publish staged candidate](../.github/workflows/publish-release.yml) on the unchanged candidate branch with the successful staging run ID. It verifies the exact draft, manifests, files, hashes, source/tag and completed attempt, then publishes those files as a pre-release. It does not rebuild or upload.

The PR workflows use read-only permissions. Draft creation and trusted platform build/test/upload jobs have `contents: write` for the whole job; the publication job also has write permission and reads the selected run. Run these privileged workflows only from reviewed release-branch code. The repository is public and uses standard free GitHub-hosted runners; Actions artifacts and cache are not part of this process. See [runner allocations and checks](CI.md).

## What the current tooling does not do

The staging and publication scripts accept RC versions and publish with the pre-release flag. They do not implement a stable-release path or stable-specific acceptance. A stable release therefore requires a separate reviewed tooling/workflow change and the owner's explicit stable-release approval. Use a new final version and tag, run its own required checks, and mark it Latest only after stable acceptance. Do not simply uncheck `prerelease` on an RC.

The update UI also distinguishes stable and prerelease versions. Its selected channel is a saved user preference; it never installs or downgrades automatically. See the in-app release check and exact package acceptance criteria in issue #81.

## Failure and evidence rules

- A failed or interrupted stage may leave an empty or partial draft. Stop and preserve it. Do not overwrite assets, reuse a prior manifest or attempt, delete the draft, move a tag, or publish it to recover a green result. Use a fresh candidate after the owner resolves the failed draft's disposition.
- If a draft is superseded, record why and link its replacement. Do not delete or publish it automatically.
- Compare each artifact with the current candidate's own source, run, attempt and hashes. Do not combine a passing test from another commit or release with this candidate.
- Keep evidence classes separate: source tests, packaged CI tests, real-model acceptance, and interactive desktop/hardware acceptance. A green source CI is not packaged or native acceptance.
- Record unrun and blocked gates plainly. Do not describe an untested platform or device as supported.

## References

- [CI acceptance contract](CI.md)
- [Contribution workflow](../CONTRIBUTING.md)
- [Real CPU-model acceptance](LOCAL-MODEL-E2E.md)
- [Graphics validation and limits](GRAPHICS.md)
- [RC11 candidate notes](RELEASE-0.1-rc11.md)
- [GitHub release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Semantic Versioning](https://semver.org/)
