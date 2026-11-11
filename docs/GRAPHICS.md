# Graphics validation and CPU rendering (#5)

The client requires WebGL 2. A discrete GPU is not inherently required: a software renderer may provide it. Rendering on CPU is slower and is not a substitute for measuring performance on target hardware.

## Observed rc2 Linux VM results

- Default startup: window, server and controls worked, but WebGL context creation failed.
- Explicit Mesa CPU test (`LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe MESA_LOADER_DRIVER_OVERRIDE=swrast`, Electron `--use-gl=angle --use-angle=gl`): Chromium reported ANGLE / Mesa llvmpipe, LLVM 19.1.7, OpenGL 4.5, Mesa 25.0.7. WebGL still failed with `BindToCurrentSequence failed`. Detection of a CPU renderer is not proof that a context can be created.
- Explicit Electron `--use-gl=angle --use-angle=swiftshader`: the actual released Linux application rendered the island, grid and persisted block. Selecting the block highlighted it; removing it removed it from the scene and advanced the world revision. This was an interactive desktop check, not a mock or only an HTTP test.
- Chromium also printed a software-WebGL deprecation warning mentioning lower security guarantees and an unsafe opt-in flag. That unsafe flag was **not** enabled. The experimental launch was not made the default or persisted as a user setting.

No system graphics packages, security settings or sandbox settings were changed for this check. The result applies to the tested Linux VM and Electron version, not every machine or future Chromium version. No FPS guarantee is made. The underlying Mesa context failure remains unresolved.

## Release policy

Keep ordinary rendering as the default. Do not silently add `--no-sandbox`, disable web security, ignore security warnings, or enable unsafe software-rendering flags to obtain a green test. If a test environment requires security-sensitive changes, stop and obtain the specific approval rather than treating them as an ordinary graphics fallback.

Native macOS and Windows package checks are separate acceptance gates. A successful Linux software-rendering test does not establish either platform's compatibility. Record renderer, tested architecture, visual actions and any warnings in release evidence.

## Reproducing the explicit Linux desktop check

Use the verified Linux release executable (or a candidate built from the exact accepted commit). Close any running copy first: the single-instance guard otherwise keeps its original graphics settings.

Start it from the desktop with these application arguments:

```
TheUnfinishedShapes --use-gl=angle --use-angle=swiftshader
```

This is an explicit, temporary diagnostic launch, not a change to the default renderer or system configuration. Keep the Chromium warning visible in the test record. Do not add the unsafe opt-in flag suggested by that warning. On a version where the above no longer creates a context, record failure rather than weakening security.

Acceptance steps: verify the scene and player; create and select a shape; edit its position and size and observe both the visual result and server confirmation; remove it; restart and verify persisted state/settings. Separately run the real-model test and platform CI. Record the exact commit/build used; a preview from an uncommitted worktree is not final-release acceptance.

## RC3 automated graphics acceptance

GitHub-hosted Linux and Windows smoke use explicit `--use-gl=angle --use-angle=swiftshader` for Linux source/package launches and the complete Windows installer lifecycle. The existing runner-only `--no-sandbox` flags remain. Normal application startup and native macOS graphics settings are unchanged. No unsafe SwiftShader opt-in is enabled.

The smoke requires a healthy WebGL context throughout construction, settings, restart and persisted-world checks. A successful run establishes this software-rendered headless lifecycle, not default desktop GPU behavior, interactive usability, hardware performance or sandboxed desktop startup. The underlying automatic-renderer/Mesa failures remain environment limitations.

Windows default D3D11-WARP also lost its context after same-installer reinstall in [run 42564975733](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42564975733). This remains unresolved: a passing SwiftShader lifecycle does not prove the normal Windows renderer is fixed. macOS uses its native default renderer and sandbox.

## RC10 Windows hardware acceptance (2026-11-11)

These observations apply to the installed `0.1.0-rc.10` binary from source `66d6f54a1bc375adc479289496cbd710daaf9646`. Installer: `TheUnfinishedShapes-0.1.0-rc.10-Setup-x64.exe`, SHA-256 `d2c413a3fb44b4f7274bf070dde7943254e78c6a41852ce4f6c4d6e787328d56`. The downloaded installer, its remote copy and manifest were hash-checked before installation; installer exit was zero. Installed version and packaged build-info were read back.

Environment: Windows 11 Pro `10.0.26300`, AMD Ryzen 7 7700 8-Core Processor, 8 logical processors, 31.96 GiB RAM, NVIDIA RTX 3060 driver `32.0.16.1088`. The existing WebGL context reported `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, Direct3D11 vs_5_0 ps_5_0, D3D11)`, with no context loss. No software graphics or sandbox-disabling launch flags were used.

### Frame pacing

The installed application ran in isolated temporary data profiles; no local application build was used. Each scene had one connected client, eight enabled lamps, a 1424×875 canvas and DPR 1. The user's original client remained open behind the test client in a separate world. Full selects up to eight nearby lamps and sun shadows; Reduced selects four and removes sun shadows. Lamps themselves do not cast shadows.

Each sample used two seconds of warmup, three seconds idle, eight version-guarded block-color updates spaced by 1.2 seconds, then twenty bounded moves spaced by 100 ms plus a one-second settle. Every update's revision was observed by the renderer. Each phase had focus at its start and was visible and focused at its end. The table reports requestAnimationFrame intervals in milliseconds, with idle / update / movement order. Raw intervals were independently checked. Every median was 16.7 ms.

| Objects | Quality | Samples idle / update / move | p95 idle / update / move (ms) | Update p99 / max (ms) | Update intervals >30 ms |
|---:|---|---|---|---|---|
| 25 | Full | 180 / 581 / 197 | 16.8 / 16.8 / 16.8 | 16.9 / 17.4 | 0 / 581 |
| 25 | Reduced | 181 / 581 / 194 | 16.8 / 16.9 / 16.8 | 17.0 / 18.2 | 0 / 581 |
| 100 | Full | 180 / 581 / 199 | 16.8 / 16.9 / 16.9 | 17.0 / 17.7 | 0 / 581 |
| 300 | Full | 180 / 575 / 198 | 16.8 / 16.9 / 16.8 | 33.2 / 33.5 | 8 / 575 |

The 300-object update sample contained eight intervals above 30 ms (1.39%); p95 alone hides those spikes. This is observed frame pacing under a roughly 60 Hz display cadence, not a measurement of GPU execution time, maximum GPU headroom, multiplayer capacity or every driver.

### Lamp behavior and resource reuse

- In a local ambient=0 / sun=0 preview, the lamp's bright emitter and nearby light pool disappeared when the normal inspector action turned it off. The same ground crop's mean sRGB luma changed from 28.63 to 8.44. Shared lighting stayed at ambient 2.6 / sun 3.1; preview did not change revision 0.
- Switching local quality to Reduced left the lamp off and shared revision at 1. After graceful application close, disk readback retained lamp `on=false`, version 1 and local Reduced quality.
- In the 300-object scene, local ambient=0.3 / sun=0 preview kept surfaces, grid, lamps and UI labels distinguishable. Preview and Cancel both preserved the complete shared state at revision 28.
- Twenty accepted lamp build/remove cycles each waited for its revision and rendered frames before removal. The scene returned to its original 25 objects after every cycle. Twenty additional local lamp Preview/Cancel cycles left revision 68 unchanged and no remaining preview.
- Windows GPU Process Memory counters for the benchmark's GPU child reported dedicated usage 142.43 MiB before cycles, 142.49 MiB after 5, 10, 15 and 20 build/remove cycles, and 136.86 MiB after the Preview/Cancel series. Shared usage stayed about 6.69 MiB. There was no accumulating trend in this bounded test; this does not prove unlimited-duration stability.

Server permissions, invalid inputs, stale versions, simultaneous state changes and two-client/restart persistence are separate automated contracts. The [lamp access regression](https://github.com/smart-tinker/the_unfinished_shapes/pull/76) directly denies nearby nonowner viewer/builder requests without changing state and permits a nearby admin; [Validate](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42979570828) passed all jobs and 349 tests. [Windows physics acceptance](https://github.com/smart-tinker/the_unfinished_shapes/issues/56#issuecomment-6789273639) records the physical walk/jump/collision and actual game-agent scenarios.

### Separate software-rendering evidence

The [RC10 source benchmark on GitHub](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42933778151/job/130238862992) records ANGLE SwiftShader at 1280×913, DPR 1, four vCPU and 16.76 GB RAM. Single-client 25/100/300-object scenes with eight lamps had p95 intervals around 333–433 ms; the 100-object two-client scene reached 1333.3 ms during updates. Its benchmark gate requires finite healthy samples, not a speed threshold. Those results establish a measured software path, not interactive-speed suitability or hardware rendering.

These RC10 observations do not accept a later package. In particular, PR #75's mixed-DPI handling was added after this binary. A new candidate needs its own staging results and exact-file interactive acceptance; physical mixed-DPI monitor switching remains open in [#44](https://github.com/smart-tinker/the_unfinished_shapes/issues/44).
