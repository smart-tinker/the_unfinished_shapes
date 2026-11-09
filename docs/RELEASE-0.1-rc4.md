# The Unfinished Shapes 0.1-rc4

This draft candidate follows the published RC3. The RC3 tag and assets remain unchanged.

## Included changes

- **#31 — Agent movement synchronization:** accepted movement from the agent is reflected by the client without a stale local position overwriting the server's newer state.
- **#32 — 3D movement:** the server resolves solid-side collisions, jumping, falling and landing on tops whose object property marks them as supporting surfaces. Physical properties are explicit, validated object data. Object contact does not open, pick up, push or activate it.

## Candidate acceptance

The exact RC4 packages must be built and checked by the GitHub **Stage release candidate** workflow at the RC4 tag. Earlier PR checks do not certify the staged installer or archives. The workflow records the hashes of the same files it tests and attaches them to this draft.

## Known limits

- Hosted graphics checks do not establish behavior on a player's physical GPU; interactive acceptance of these exact files remains separate.
- Windows x64 binaries are unsigned. macOS supports Apple Silicon arm64 only, with an ad-hoc signature and no notarization.
- This remains an early 3D construction-world slice, not a production-scale MMO.
