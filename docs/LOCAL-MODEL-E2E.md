# Real local CPU-model acceptance

## Verified result

[Run 42403913082](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42403913082), commit `198063e5f085622fbe81aa165ce1bb6a0d015a4d`, **passed strict acceptance in 236,495 ms**. The real model issued exactly one `world_build` with the supplied design, including non-default color **#3366cc**; the authoritative server persisted exactly one matching block. Observed allocation evidence reported `cpuOnly: true`.

Reported Actions billable Ubuntu time: **0 ms**. Wall time: **277,000 ms**. These are measurements for this run, not a promise about every future run. The test uses a standard public-repository runner, no paid model API, Actions cache or artifact-upload storage.

This validates applying one explicit supplied design, **not general model competence or unrestricted natural-language planning**. It is a live model test, separate from `npm test`. Final RC publication still requires acceptance against the exact final commit; the previous result does not automatically apply to later changes.

## What the check proves

The production `CodexBridge` connects to real Codex app-server and a local Responses API model server. The model must emit a genuine dynamic `world_build` call with exactly the requested type, position, size and color. At least one genuine construction call is required. Every construction must be `world_build`, carry exactly the supplied parameters, and receive server success. The saved authoritative world must contain one matching object per successful valid call, with distinct IDs and the test builder as owner. Multiple valid identical constructions are accepted and executed independently; missing arguments, wrong colors, moves, failed calls, no-ops, and mismatched persisted counts fail. Prose claiming completion is insufficient. Unexpected approvals fail rather than being automatically accepted.

The server runs on loopback with GPU layers set to zero, four CPU threads, one inference slot, deterministic sampling and a 450-second inference budget. CPU evidence is independent of that requested configuration: positive model-buffer allocations must belong exactly to `CPU`, `CPU_Mapped` or `CPU_REPACK`, with no contradictory positive GPU allocation/offload. Missing evidence fails.

Temporary workspace, world and Codex configuration are isolated and removed after child shutdown. No player credentials or existing conversations are read or copied. Diagnostics retain only bounded synthetic final output, allocation/timing records, HTTP byte/status counts, SSE categories and token usage, not headers, full conversations or private reasoning. No model output is substituted or synthesized.

## Reproduce

Requirements: Node.js 24, working Codex app-server sandbox support, official CPU llama-server with `/v1/responses` tool support, loopback networking, and at least 4 GiB available RAM plus runtime overhead. Port `127.0.0.1:11445` must be free.

Set these variables and run `node tools/local-model-e2e.mjs`:

- `TUS_TEST_CODEX`: absolute Codex executable path.
- `TUS_TEST_LLAMA`: absolute llama-server path.
- `TUS_TEST_GGUF`: absolute model path.
- `TUS_TEST_REPORT`: optional JSON result path.
- `TUS_TEST_TIMEOUT_MS`: optional turn budget, default 300000, maximum 600000; hosted workflow uses 450000.

`.github/workflows/local-cpu-model.yml` uses standard `ubuntu-24.04`, a 15-minute job limit, and verified downloads. It supports manual dispatch and relevant pull-request changes; documentation-only edits do not trigger it. Inspect the actual run result before claiming acceptance.

### Pinned hosted inputs

- [Codex 0.167.0](https://github.com/openai/codex/releases/tag/rust-v0.167.0), archive SHA-256 `9d64836106d5b374e90ee4454c7ebcde7ca7106558bd7e41a34b9f26ebda251a`.
- [llama.cpp b12189](https://github.com/ggml-org/llama.cpp/releases/tag/b12189), Ubuntu x64 archive, 23,058,620 bytes; SHA-256 `c446a7ba4df3c3b1cc880a734fbff586d6d34b9cebc09e151754813b94ded8c9`.
- Qwen3 1.7B GGUF, 1,359,279,776 bytes; SHA-256 `3d0b790534fe4b79525fc3692950408dca41171676ed7e21db57af5c65ef6ab6`. Public registry URL: https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:3d0b790534fe4b79525fc3692950408dca41171676ed7e21db57af5c65ef6ab6 . No Ollama account, signing key or cloud inference is required.

## Earlier failures and compatibility changes

- `42394553433`, `42394937741`: Qwen3 0.6B moved the player or made no tool call; no successful build.
- `42395321138`: 1.7B also moved instead of building.
- `42396799994`: timed out without a tool call. Allocation logging was separately repaired: pinned llama.cpp suppresses allocation messages below verbosity 4. This logging issue was not treated as a proven inference root cause.
- `42396207916`: stub-provider wire observation retained all original union variants. #12's branch-stripping hypothesis was not confirmed; a flat command schema was introduced as a compatibility change.
- `42397837460`: a real build occurred in about 218 seconds, but omitted requested color. Strict acceptance correctly failed despite the server default matching it. Ubuntu billable time was 0 ms; wall time 256000 ms.
- #15 then introduced dedicated `world_build` with every design field required and non-default color #3366cc. Run `42403913082` passed without weakening exact-argument or persistence checks.

See [schema investigation](CODEX-SCHEMA-DIAGNOSTIC.md). Existing conversations keep their creation-time tools and legacy build support; updated tools require an explicitly chosen new game conversation, not automatic history replacement (#14).

## Separate local VM blocker

The local VM attempt stopped before inference: Codex `thread/start` reported a sandbox-helper error requiring its app-server socket directory to be user-owned with mode 0700. Creating the test's temporary directories with mode 0700 did not resolve it. No runtime permissions were changed and no sandbox was disabled. Tool-call count was zero.

The later hosted pass used a supported clean executor. It does not erase this VM startup limitation or prove live Codex integration works there. Local interactive rendering tests and hosted model acceptance remain distinct evidence.

## Owner-approved acceptance update

The owner explicitly chose to execute both requests when the model issues two valid construction requests. The harness now checks every request and its persisted effects instead of requiring exactly one invocation. The model prompt is unchanged (it still requests one call), so a pass demonstrates correct execution, not perfect compliance with the requested call count. No duplicate-suppression guard is integrated.

[Run 42406443242](https://github.com/smart-tinker/the_unfinished_shapes/actions/runs/42406443242) failed the previous single-call gate after two valid `world_build` calls created two objects. That historical failure is retained, not relabeled as a newly executed pass. The earlier successful run above used the old gate; the revised acceptance needs its own live result.
