# Real local CPU model end-to-end check

This is a live model acceptance test, not a mock and not part of `npm test`. It runs separately through the scoped workflow below or an explicit local command. It exercises the production `CodexBridge`, a real local Responses API model server, the production game-tool dispatcher, and persisted authoritative world state. Passing ordinary unit tests does not imply this check passed.

## Requirements

- An installed Codex CLI with working app-server sandbox support.
- Official CPU `llama-server` with `/v1/responses` and tool-call support.
- A downloaded tool-capable GGUF model. A small model may fail to use the tools correctly; this is a failed test, not permission to replace its output with a scripted tool call.
- At least 4 GiB free RAM for the 1.7B candidate and 16K context, plus Codex/runtime memory.
- Loopback networking permitted. This test never changes permissions or disables a sandbox to overcome a denial.

The test starts llama-server on `127.0.0.1:11445` with GPU layers set to zero, four CPU threads and one inference slot. Stop any existing service using that port before running. It creates temporary world/workspace/config directories, uses a fresh isolated Codex config pointing only to the loopback provider, and removes the temporary directories on completion. It does not read or copy the user's Codex credentials or existing conversations. The model server and Codex child are stopped in cleanup.

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

### Stronger bounded candidate after the second semantic failure

Hosted run `42394937741` completed after about 110 seconds with no dynamic tool calls and no saved world file. Qwen3 0.6B has therefore failed both attempts; there is no claim that its prose constituted a successful action.

The next workflow candidate is **Qwen3 1.7B**, model-layer size **1,359,279,776 bytes**, pinned SHA-256 **`3d0b790534fe4b79525fc3692950408dca41171676ed7e21db57af5c65ef6ab6`**, verified from the public registry's `library/qwen3:1.7b` manifest. Download URL:

`https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:3d0b790534fe4b79525fc3692950408dca41171676ed7e21db57af5c65ef6ab6`

The download has a 1.6 GB size cap and 180-second limit. Inference uses four CPU threads, temperature zero, a fixed seed and a 450-second budget within the unchanged 15-minute job limit. The exact build-design and persistence assertions remain strict. The report now captures up to 4,000 characters of the synthetic assistant's final message and the turn status, never reasoning or arbitrary tool output, to explain semantic failures. A missing world file is reported as an acceptance assertion rather than an unexplained filesystem error.

This candidate has been prepared, not yet validated. No additional local run was attempted against the blocked sandbox route.

### CPU evidence acceptance

`tools/cpu-evidence.mjs` now parses the pinned runtime's exact allocation diagnostics: `load_tensors: <backend> model buffer size = <number> MiB`. At least one positive allocation must be observed, every positive model allocation must use `CPU` or `CPU_Mapped`, and no positive GPU offload count may appear. A missing GPU summary is allowed for a CPU-only binary. `--n-gpu-layers 0` is reported separately as requested configuration, not hardware evidence.

Generic text such as `loading model .../tus-cpu/...` cannot satisfy acceptance. CPU evidence is retained independently of rolling logs, with separate stdout/stderr partial-line buffers. Six pure unit tests cover the misleading path, actual allocations, contradictory GPU evidence, zero-only evidence and split chunks. These checks do not themselves establish that a live inference run passed.
