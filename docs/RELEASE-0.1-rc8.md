# The Unfinished Shapes 0.1-rc8

This candidate includes server-authoritative movement and the Linux jump synchronization fix.

- Solid object sides block movement; players can jump and fall.
- An object's top supports landing only when `supportsPlayer` is enabled.
- Client and server use the same 250 ms maximum movement interval; physics resolves in 60 Hz substeps.
- The shared-world scenario checks collision, jumping, landing, observation from a second client, and persistence after reconnect.
- Object contact affects movement only; objects cannot be opened, picked up, pushed, or activated.

Release staging retries read-only GitHub tag lookups up to three total attempts when the CLI returns no parseable HTTP response. Valid HTTP errors are not retried. A new candidate is built and checked as one attempt; partial draft assets are never reused.

## Candidate verification

The GitHub Actions candidate workflow builds each platform package once, tests those exact files, and stores the same files with SHA-256 manifests in a draft. Publication is a separate explicit step and does not rebuild.

## Known limits

- Linux and Windows CI graphics checks use SwiftShader. Real-GPU behavior and performance are not established.
- Default Linux graphics initialization and Windows D3D11-WARP context loss remain unresolved; see [graphics validation](GRAPHICS.md).
- Windows binaries are unsigned.
- The macOS package targets Apple Silicon arm64, uses an ad-hoc signature, and is not notarized. Intel Macs are not covered.
- Interactive acceptance of the staged files on real hardware has not been performed.
- This is an early playable slice, not a production-scale MMO.
