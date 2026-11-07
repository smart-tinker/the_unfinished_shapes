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
