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

The local VM's known `thread/start` sandbox startup failure is not retried or bypassed. The hosted observation below was inspected; it did not show a wire-level loss of variants.

## Possible compatibility simplification

If outgoing variants remain intact, a simpler single object with a command-type enum and optional operation fields may still improve small-model comprehension. That is a compatibility experiment, not proof of branch stripping. Authoritative server validation and the update conflict guard must remain unchanged, and the genuine model test must still build the exact requested object before acceptance.

## Observed wire result and controlled experiment

Hosted schema-observation run **42396207916** passed: the real Codex outgoing request retained all four original variants (`move`, `build`, `update`, `remove`), their field names and required fields. This rules out loss of those variants at the observed Codex/provider boundary. It does not establish the cause of the model's semantic errors or prove downstream model comprehension.

The subsequent controlled compatibility experiment replaced the nested union with one explicit command object: a `type` enum (`move`, `build`, `update`, `remove`), preserving the original operation order, plus operation-specific fields. Descriptions distinguish constructing an object from merely moving the player. Conditional requirements move out of the model-facing schema, but authoritative server validation is unchanged. In particular, `executeGameTool` now rejects agent `update` calls missing a nonempty `expected` object before any HTTP request; the server still verifies exact edited-field coverage, ownership, stale values and legal coordinates/colors. A build without its required mechanic/position remains invalid.

The diagnostic supports both union and flat shapes and still compares actual outgoing operation types, field names and requirements. Unit tests verify flat operation discovery, missing-edit-guard rejection without networking, rejected invalid builds, accepted guarded edits and rejected stale/ownership-changing edits.

## Dedicated construction tool and verified outcome

The final candidate separates construction into `world_build`, with required `objectType`, `position`, `size` and `color`. `world_command` advertises move/update/remove. Server validation and optimistic edit guards remain authoritative. Existing conversations retain their creation-time schema; the dispatcher still supports their legacy build command. Creating a conversation with updated tools requires an explicit user choice and preserves the old history.

[Run 42403913082](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42403913082), commit `198063e5f085622fbe81aa165ce1bb6a0d015a4d`, passed the real CPU-model test: one exact `world_build`, non-default color `#3366cc`, and one persisted matching block. See [acceptance evidence](LOCAL-MODEL-E2E.md).

This is a demonstrated compatibility improvement for one bounded supplied design, **not proof of the original semantic failures' root cause**. The observed Codex wire schema retained the union variants; the branch-stripping hypothesis was not confirmed. The exact final release commit still needs its own acceptance gates.

Issue tracking: #12 established the wire observation and flat-schema compatibility change; #15 addressed the remaining missing-color failure with required construction fields and the strict passing run. #14 makes the creation-time schema limitation visible when resuming an existing conversation.
