# Free GitHub safeguards

This configuration is for this **public** repository and standard hosted runners. It does not enable Copilot, paid runners, paid security products, auto-merge or automatic release publication.

## Repository files versus settings

`Security` runs CodeQL JavaScript and a high/critical dependency-review gate. Code scanning findings still need triage: a successful analysis does not mean there are no vulnerabilities. No PR comment write permission, PR-target workflow or credential-persisting checkout is used. Weekly Dependabot groups compatible npm and Actions updates; major npm updates remain separate. Security-update/alert settings and dependency graph must be enabled separately in repository settings. Do not claim these enabled merely because this file exists.

Issue forms and the PR template capture the existing process in CONTRIBUTING.md. Forms, scheduled jobs and Dependabot require the configuration on the default branch; an RC-only merge does not finish their activation. Do not bypass the RC acceptance process to activate them.

## Required administrative follow-up

Before enabling required checks, observe their real check names and successful results on the affected branch. Protect main and active release branches with PR-only changes, required current CI, no force pushes/deletion and resolved review conversations. Do not require multiple GitHub approvals when all agents share an identity. Do not add bypass actors or paid merge queues. Do not require a check that is absent from older release branches. CodeQL analysis alone is not an alert-severity gate.

Enable free public secret scanning/push protection, dependency graph and Dependabot alerts/security updates after verifying current settings. Rulesets and these settings cannot be inferred from a committed workflow. Record the settings readback separately. Immutable releases should apply to future publications only after confirming the staging/publishing workflow is compatible; do not change existing tags/assets.

## Release provenance

The existing trusted, manually dispatched staging workflow attests the exact tested/staged candidate files (including manifests) after hash rechecks and upload. The three native jobs receive narrowly scoped `id-token: write` and `attestations: write` for GitHub provenance. Ordinary validation and publication permissions are unchanged. No new secret or external credential is needed; no Actions artifact upload is added. Failed attestation fails staging, so the existing successful-staging requirement prevents publication.

For a downloaded candidate file, verify with `gh attestation verify FILE --repo smart-tinker/the_unfinished_shapes`. Compare the verified source SHA/workflow with the candidate manifest and acceptance evidence. A valid attestation proves provenance, not absence of bugs, Windows Authenticode signing, notarization or interactive/native acceptance. This addition is not verified end-to-end until a separately authorized future staging run succeeds; do not rebuild or republish a current release just to test it.
