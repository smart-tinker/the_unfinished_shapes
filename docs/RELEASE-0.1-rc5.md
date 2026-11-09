# The Unfinished Shapes 0.1-rc5

This is a new release candidate for the existing playable 3D sandbox. It includes server-authoritative movement: solid object sides block movement, players can jump and fall, and an object's explicit support property controls whether its top can be used as a landing surface. Contact does not open, pick up, push, or activate objects.

The shared-world acceptance scenario uses two packaged clients and one server. The controlled Alice window is brought to the foreground before keyboard input so the Linux runner does not background-throttle the client being tested. Collision, jump, landing, second-client visibility, persistence, and ownership assertions remain enabled.

## Candidate verification

The GitHub **Stage release candidate** workflow must build each package once, test those exact installer/archive bytes, and record their SHA-256 digests in this draft. The Linux graphics smoke uses SwiftShader; this does not establish behavior on a real GPU. The exact staged Windows installer and macOS app still need interactive acceptance on their target machines.

## Known limits

- Windows binaries are unsigned.
- The macOS arm64 app is ad-hoc signed and not notarized.
- This is an early playable slice, not a production MMO.
- This draft is not a published release.