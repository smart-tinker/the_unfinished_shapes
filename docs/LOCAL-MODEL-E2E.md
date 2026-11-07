# Real local CPU model end-to-end check

This is a live model acceptance test, not a mock and not part of `npm test`. It runs separately through the scoped workflow below or an explicit local command. It exercises the production `CodexBridge`, a real local Responses API model server, the production game-tool dispatcher, and persisted authoritative world state. Passing ordinary unit tests does not imply this check passed.

## Requirements

- An installed Codex CLI with working app-server sandbox support.
- Official CPU `llama-server` with `/v1/responses` and tool-call support.
- A downloaded tool-capable GGUF model. A small model may fail to use the tools correctly; this is a failed test, not permission to replace its output with a scripted tool call.
- About 2 GiB free RAM for a 0.6B model and 16K context, plus Codex/runtime memory.
- Loopback networking permitted. This test never changes permissions or disables a sandbox to overcome a denial.

The test starts llama-server on `127.0.0.1:11445` with GPU layers set to zero, two CPU threads and one inference slot. Stop any existing service using that port before running. It creates temporary world/workspace/config directories, uses a fresh isolated Codex config pointing only to the loopback provider, and removes the temporary directories on completion. It does not read or copy the user's Codex credentials or existing conversations. The model server and Codex child are stopped in cleanup.

## Run

Set these environment variables, then run `node tools/local-model-e2e.mjs`:

- `TUS_TEST_CODEX`: absolute path to the installed Codex executable.
- `TUS_TEST_LLAMA`: absolute path to official `llama-server`.
- `TUS_TEST_GGUF`: absolute path to the downloaded GGUF model.
- `TUS_TEST_REPORT`: optional JSON report file path.
- `TUS_TEST_TIMEOUT_MS`: optional turn budget, defaults to 300000; maximum 600000.

The model is asked to build exactly one block through `world_command`. Success requires a genuine dynamic tool event, a successful authoritative-server result, the expected object in saved world state, and CPU allocation evidence. Text claiming success does not pass. Unexpected approval requests fail rather than being automatically accepted. The test does not exercise a real player's data, a paid API, new feature deployment or production infrastructure.

## Verified inputs and current outcome

An attempted run on 2026-11-07 used:

- Official llama.cpp **b12189**, `llama-b12189-bin-ubuntu-x64.tar.gz`, 23,058,620 bytes. SHA-256 `c446a7ba4df3c3b1cc880a734fbff586d6d34b9cebc09e151754813b94ded8c9`, matched GitHub release metadata.
- Qwen3 **0.6B** GGUF from the public Ollama model registry, 522,640,096 bytes. SHA-256 `7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa`, matched registry manifest. No Ollama account or cloud inference is needed to use this GGUF with llama.cpp.
- Codex CLI **0.166.0-alpha.1**.

**Full E2E is blocked, not passed.** llama.cpp loaded locally, but Codex `thread/start` failed before inference or game-tool execution:

> error creating thread: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: error building bubblewrap command: app-server socket directory must be a user-owned directory with mode 0700

Creating the test's new directories with restrictive mode 0700 did not resolve the runtime error. No runtime permissions were changed, no sandbox was disabled, and no paid provider was used. Tool-call count was zero. Run this same check on an executor whose supported Codex sandbox works before claiming real-model release validation.

An earlier Ollama startup attempt was abandoned because it tried to generate a local signing key in a read-only home directory. No key was generated; the credential-free llama.cpp server was used instead. Installing Ollama or generating keys is not required by this test.

Sources: [llama.cpp b12189](https://github.com/ggml-org/llama.cpp/releases/tag/b12189), [llama-server API documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [Qwen3 0.6B model](https://ollama.com/library/qwen3:0.6b).

## Separate clean-runner acceptance (not yet executed)

`.github/workflows/local-cpu-model.yml` runs on pull requests changing the live test, Codex bridge, game-tool dispatcher, world logic/server, or this workflow. It also supports manual dispatch; documentation-only changes do not trigger it. It uses a standard public-repository `ubuntu-24.04` runner, a 15-minute job limit, pinned official Codex **0.167.0**, llama.cpp **b12189**, and the model digest above. Every downloaded archive/model is SHA-256 verified before execution. There are no Actions cache/upload-artifact steps and no paid model API. Results go to job logs and the run summary.

Codex archive SHA-256: `9d64836106d5b374e90ee4454c7ebcde7ca7106558bd7e41a34b9f26ebda251a`, verified against official release metadata. Source: [Codex 0.167.0](https://github.com/openai/codex/releases/tag/rust-v0.167.0).

This is a distinct acceptance run on a clean supported executor, not a workaround that changes this VM's sandbox settings. Its result must be inspected before closing the real-model acceptance issue. A future hosted-runner pass does not erase the local VM startup blocker. The workflow has only been prepared; no run was dispatched as part of preparation. Opening or updating a matching pull request will trigger acceptance before merge.

### First hosted inference result

Hosted run `42394553433` reached actual local-model inference and the dynamic game tool. It failed semantic acceptance: the model issued `world_command` with a `move` command at the requested coordinates, not a `build`. The server correctly accepted the movement, but zero objects were saved. This is **not** a passing build test.

The next check gives the model the exact build-design JSON, with temperature zero and fixed seed, while retaining and strengthening object, size, color, ownership and exact-command assertions. This tests applying a supplied design, not unrestricted natural-language planning. It also preserves CPU initialization evidence separately from rolling runtime logs and waits for child shutdown before temporary-directory cleanup. These changes require a new hosted result; a 0.6B model may still prove inadequate.
