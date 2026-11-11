# The Unfinished Shapes 0.1-rc11

RC11 is prepared from the final RC10 release branch. Its package version is `0.1.0-rc.11`; source commit, file hashes and staging attempt are recorded in the candidate manifests.

## Changes since RC10

- Rendering recalculates the capped pixel ratio on window resize and rearms a resolution watcher after a display-DPI change ([#75](https://github.com/smart-tinker/the_unfinished_shapes/pull/75)).
- A lamp permission regression directly verifies nearby nonowner denial and admin access for the default `owner_admin` policy ([#76](https://github.com/smart-tinker/the_unfinished_shapes/pull/76)).
- [Graphics validation](GRAPHICS.md#rc10-windows-hardware-acceptance-2026-11-11) records source-bound RC10 NVIDIA measurements, visual lamp checks and bounded resource reuse. Those measurements are not RC11 package acceptance.

## Candidate verification

A preparation PR must pass GitHub Validate and Security before its final commit receives a new immutable `v0.1.0-rc11` tag. Manual Stage release candidate builds each platform package once, tests the final installer and extracted archives, runs real CPU-model acceptance, and stores those same bytes with SHA-256 manifests in a draft. It uses standard public GitHub runners without Actions cache or artifacts.

Publication is a separate explicit step that verifies the successful staging run, unchanged source/tag and all seven assets, then promotes the draft without rebuilding. Native hardware acceptance must identify these new files; a previous candidate's passing result cannot substitute for it.

## Known limits

- Physical mixed-DPI monitor switching, fullscreen restoration and selection/drag across that transition remain open in [#44](https://github.com/smart-tinker/the_unfinished_shapes/issues/44).
- Linux and Windows CI use explicit SwiftShader; native macOS uses Apple Silicon arm64. The [graphics notes](GRAPHICS.md) distinguish these checks from normal desktop graphics.
- Windows binaries are unsigned. macOS uses an ad-hoc signature without notarization; Intel Macs are not covered.
- This is an early shared 3D sandbox with bounded state and HTTP polling, not proof of MMO-scale load.
