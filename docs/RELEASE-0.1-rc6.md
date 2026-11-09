# The Unfinished Shapes 0.1-rc6

This candidate includes server-authoritative movement: solid object sides block movement, players can jump and fall, and an object's explicit support property controls whether its top can be used as a landing surface. Contact does not open, pick up, push, or activate objects.

The shared-world acceptance harness now focuses the active Electron window before controlled input and holds movement until the server accepts it. The gameplay assertions remain enabled: collision, jump, landing, second-client visibility, persistence and ownership.

## Candidate verification

The GitHub **Stage release candidate** workflow builds each package once, tests the exact installer/archive bytes, and records their SHA-256 digests in this draft.

Automated Linux and Windows graphics smoke uses SwiftShader. This does not establish default-renderer behavior or real-GPU performance. The Linux automatic-renderer/Mesa context issue and Windows D3D11-WARP context-loss case remain documented limitations. The exact staged Windows installer and macOS app still need interactive acceptance on their target machines.

## Known limits

- Windows binaries are unsigned.
- The macOS arm64 app is ad-hoc signed and not notarized; Intel Macs are not covered.
- This is an early playable slice, not a production MMO.
- This candidate is intended to remain a draft until the exact staged files are accepted.
