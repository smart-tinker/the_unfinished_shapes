# The Unfinished Shapes 0.1-rc7

This candidate includes server-authoritative movement and the Linux jump synchronization fix.

- Solid object sides block movement; players can jump and fall.
- A top is a landing surface only when that object's `supportsPlayer` property is enabled.
- The client uses the same 250 ms maximum movement interval as the server. Physics still resolves in 60 Hz substeps.
- The shared-world scenario checks collision, jump, landing, observation from a second client, and persistence after reconnect.
- Contact affects movement only; objects cannot be opened, picked up, pushed, or activated.

## Candidate verification

The full GitHub Actions run for the issue PR passed: source tests, packaged two-client Linux acceptance, Windows installer lifecycle, native macOS launch, and genuine local CPU-model acceptance. The Stage release candidate workflow must also pass for this exact candidate before these files are considered accepted. It builds each platform package once, tests those files, and records their SHA-256 hashes in this draft.

## Known limits

- Linux and Windows graphics checks use SwiftShader; real-GPU behavior and performance are not established. Default Linux graphics initialization and Windows D3D11-WARP context loss remain documented in [graphics validation](GRAPHICS.md).
- Windows binaries are unsigned.
- The macOS package targets Apple Silicon arm64, uses an ad-hoc signature, and is not notarized. Intel Macs are not covered.
- Interactive acceptance of the exact staged RC7 files on real hardware has not been performed.
- This is an early playable slice, not a production-scale MMO.
