# Retained RC3 Windows validation (proposal)

This workflow tests already-retained RC3 installer and portable bytes. It does not build, package, upload, publish, merge, modify release metadata or change permissions. All GitHub calls are reads. The fixed installer is reused for all eight fresh Node processes: five strict default-graphics lifecycle trials followed by three explicitly labeled SwiftShader diagnostics. Any strict failure remains a failure. Missing trials are not passes. Diagnostic failures also fail the job, but diagnostic success never grants strict acceptance.

## Fixed provenance

- Repository: smart-tinker/the_unfinished_shapes.
- Candidate: 867b5fa4dfa3d36bfad2abfc13bbfbb35b3fc488; tree e78ce3b60655514fccd8426c0c7b32de710b72be.
- Reviewed external harness: dcb8420326eed026a5397ca20690fb0f30886362. Three helper git blobs are independently SHA-256 checked, avoiding Windows checkout newline conversion.
- Draft release: 437834226; tag v0.1.0-rc3, exact candidate target.
- Installer asset: 721891674, 126814645 bytes, SHA-256 5a39476abcd28e80df5c4af2f226e95bdcca034b7f085be337a5152c92950164.
- Portable asset: 721891678, 170230698 bytes, SHA-256 092ebd6e0b69c429c0fd35831582352f149b46577879c51c7df62a5287e558ca.

The read-only token is sent only to api.github.com. Asset redirects are followed once to the specific HTTPS release-assets.githubusercontent.com host in a new unauthenticated request. Neither signed URLs nor token values are logged. A 403/404 is a blocker, not an instruction to broaden token permissions or use another identity. Draft access is checked before npm ci. No artifact storage or write token is needed.

Candidate dependencies use npm ci --ignore-scripts. No Electron rebuild/download lifecycle script or package command runs. The candidate's Windows-checkout src bytes and source file set must match portable app.asar exactly. Packager-retained package fields and all files of the production dependency `three` are compared; package-lock hash is recorded separately because packaging omits it. Installed app.asar and executable must equal retained portable bytes before every RC3 launch and before/after close. The earlier checksum-verified RC1 remains only a migration fixture. Its graphics do not satisfy RC3 acceptance.

The original CI/Windows, absent-profile/installation, ownership and cleanup guards remain. Each trial has a 12-minute deadline, and the job is capped at 120 minutes. A timed-out child tree is terminated and remaining trials stay not-run. Cleanup uncertainty stops the series; the orchestrator never removes residual installation/profile directories. Expected owned directories must be absent before and after each trial. The original lifecycle removes its own temporary migration fixture. A failure before its finally block can leave temporary files only on the disposable runner.

## Evidence

The job emits every child stdout/stderr stream, each result, installed hashes, and compact JSON summary/provenance to ordinary job logs. Per-trial log files and summary.json are ephemeral in retained-evidence on the runner. GitHub job logs can be retrieved and saved later; binary bytes are never printed. Summary identifies exact run attempt, workflow SHA/ref, tested checkout SHA and PR head/base. Installer, ZIP, portable ASAR/executable hashes are checked before/after trials and at series end. Release/tag/all asset identity metadata are reread after the series, excluding download counters that legitimately change from reading. Remote originals remain in the draft.

## Run and limitations

Local unit/static checks: node --test test/retained-windows.test.mjs. Linux checks do not prove Windows acceptance. Observer hooks attach after Playwright launch resolves, so earlier GPU events may be unavailable. These eight fixed trials measure this runner and these retained originals, not universal GPU reliability or human GUI acceptance. If the overall job is forcibly canceled or killed, final verification/log flush cannot be guaranteed and the run is incomplete.

Next permitted action is review of this local proposal. Repository application, PR creation and CI execution are separate actions, not performed by this deliverable. Intended scoped same-repository branch: recovery/rc3-retained-windows into release/0.1.0-rc3. PR trigger is restricted to listed validation paths; manual dispatch has no inputs and works only once the workflow is registered by GitHub. No publisher is included.

Local proposal validation: six focused unit tests and syntax/YAML checks passed. Portable verifier was also executed successfully against the existing exact-source Linux app.asar: 11 source files and 1,117 three files matched byte-for-byte. Both transformed lifecycle outputs parsed successfully. This is verifier coverage, not execution of the Windows release assets.
