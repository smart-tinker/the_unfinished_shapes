# Command-schema compatibility investigation

## Observations, not a proven root cause

Real CPU-model runs issued a valid `move` instead of the requested `build`, or no tool call. The requested block was not persisted. These semantic failures remain failures; successful movement or an assistant claiming completion does not satisfy build acceptance.

A proposed explanation was that the `command.oneOf` schema loses all but its first variant before inference. Static inspection of the pinned dependencies does **not** establish that explanation:

- Codex 0.167.0 `tools/src/json_schema.rs` explicitly preserves `oneOf`/`anyOf`/`allOf`, including a composition schema without its own `type`. It lowers `const` to a one-element `enum`.
- llama.cpp b12189 `common/json-schema.cpp` reads every `oneOf`/`anyOf` alternative. Its grammar converter joins every alternative with `|`, rather than selecting index zero.

Sources:
- https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tools/src/json_schema.rs
- https://github.com/ggml-org/llama.cpp/blob/b12189/common/json-schema.cpp
- https://github.com/ggml-org/llama.cpp/blob/b12189/common/json-schema-to-grammar.cpp

## Actual wire observation

`tools/inspect-codex-wire-schema.mjs` launches the real installed Codex with a fresh isolated configuration and a local HTTP **stub** provider. The stub observes outgoing `/v1/responses` tools and deliberately rejects inference. The report includes only the original and emitted `world_command` schemas, never credentials or complete request conversation contents. It compares variant types, property names and required fields, allowing the documented `const` → singleton `enum` representation change.

This is **schema observation only**, not a real-model end-to-end test. It cannot prove that a model understands the schema or that llama.cpp renders it correctly. No model runtime or weights are downloaded.

Run with `TUS_TEST_CODEX` pointing to an official Codex executable, optionally `TUS_TEST_REPORT` for a JSON report. `.github/workflows/codex-wire-schema.yml` performs this observation on standard public-repository Ubuntu using checksum-pinned Codex 0.167.0, no secrets, caches or artifact uploads. This diagnostic is separate from the live CPU-model acceptance workflow and can run without its files.

The local VM's known `thread/start` sandbox startup failure is not retried or bypassed. The prepared hosted diagnostic must be run and inspected before claiming a wire-level schema bug.

## Possible compatibility simplification

If outgoing variants remain intact, a simpler single object with a command-type enum and optional operation fields may still improve small-model comprehension. That is a compatibility experiment, not proof of branch stripping. Authoritative server validation and the update conflict guard must remain unchanged, and the genuine model test must still build the exact requested object before acceptance.
