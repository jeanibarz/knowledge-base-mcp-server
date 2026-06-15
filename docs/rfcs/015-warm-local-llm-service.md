# RFC 015 - Warm Local LLM Service for the `kb` CLI

- **Status:** Implemented (systemd user-unit management + `kb serve` daemon — src/llm-service.ts, src/cli-serve.ts)
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 012 (CLI distribution), RFC 013 (multi-model embedding support), RFC 014 (atomic FAISS save), local-research-agent RFC 002 daemonization

## 1. Summary

Yes: the `kb` CLI can use the same deployment shape as `local-research-agent` for generative LLM work, but it should not turn the knowledge-base server itself into a heavyweight daemon.

The recommended design is an optional **warm local LLM service**:

1. Keep `kb search`, `kb compare`, `kb stats`, and the MCP server as fresh-process / stdio tools.
2. Add a new retrieval-augmented command family (`kb ask`, later `kb search --llm-rerank`) that calls a local OpenAI-compatible chat endpoint after retrieving context from the existing FAISS indexes.
3. Prefer reusing an already-running endpoint, especially the `local-research-agent` `llama-server` on `127.0.0.1:8080`, when `KB_LLM_ENDPOINT` is set or auto-detected.
4. Add optional `kb llm *` lifecycle commands that install, start, stop, restart, inspect, and uninstall a per-user `systemd --user` service for operators who want `kb` to manage the model runtime itself.
5. Make model changes and CLI uninstall safe: every managed unit is profile-owned, model-fingerprinted, lease-tracked, and removable by `kb llm uninstall`; a reaper stops stale managed services if the CLI disappears or the profile stops receiving leases.

This gives the useful part of the local-research-agent model, namely "the expensive model is already loaded when a query arrives", while avoiding an immortal background process that survives model changes or package removal.

## 2. Existing Evidence

### 2.1 local-research-agent deployment pattern

`local-research-agent` keeps its LLM hot through a `systemd --user` unit:

- `configs/systemd/llama-server.service` starts a llama.cpp-compatible `llama-server` bound to `127.0.0.1:8080`.
- `scripts/start.sh` auto-detects installed user units and otherwise falls back to `nohup`.
- `scripts/install-systemd-units.sh` installs, enables, starts, reports status, and uninstalls units idempotently.
- `docs/daemonization.md` documents the two-mode lifecycle, health checks, logs, reboot recovery, and uninstall path.
- `scripts/local_llm.py` treats the server as an OpenAI-compatible `/v1/chat/completions` endpoint.

On Jean's current machine, operating-environment notes say the local-research-agent `llama-server` consumes roughly 22 GB VRAM on a 24 GB GPU, while Ollama embeddings use about 1 GB. Starting a second large generative model by default is therefore the wrong default.

### 2.2 knowledge-base CLI shape

The KB project already ships a `kb` bin alongside the MCP server. The CLI is deliberately fresh-process per invocation (RFC 012), and it already supports side-by-side embedding models (RFC 013). That is correct for retrieval: CLI startup is small compared with LLM model load, and the retrieval engine does not need a resident daemon.

The missing piece is not "make all of `kb` a daemon"; it is "when a command needs generation, call a warm model that is already resident".

## 3. Goals

- **G1.** Add a supported path for `kb` commands to use a warm local generative LLM.
- **G2.** Reuse existing local-research-agent `llama-server` when available, rather than competing for VRAM.
- **G3.** Keep existing retrieval commands and MCP stdio behavior unchanged.
- **G4.** Make the LLM runtime optional. Users without a local model can keep using `kb search` and remote embedding providers exactly as today.
- **G5.** Make model changes explicit and safe: switching the managed LLM model stops the old managed unit before starting the new one.
- **G6.** Make uninstall safe: managed services must not keep a large model loaded indefinitely after the CLI is removed or the profile is abandoned.
- **G7.** Keep the local endpoint bound to loopback by default and never expose the KB corpus or generated prompts on a LAN port without an explicit flag.

## 4. Non-goals

- **N1.** Do not replace `kb search` with LLM generation. Retrieval remains deterministic and useful without a generative model.
- **N2.** Do not make the MCP server depend on the warm LLM service.
- **N3.** Do not manage local-research-agent's units directly. `kb` may reuse its endpoint, but should not stop, restart, or rewrite `local-research-agent` services.
- **N4.** Do not start a second large model automatically on Jean's machine. The default is reuse or explicit opt-in.
- **N5.** Do not rely on npm uninstall hooks as the only cleanup mechanism. They are not reliable enough to be the only guard against persistent VRAM use.

## 5. Design

### 5.1 Surface

New commands:

```text
kb ask <question> [--kb=<name>] [--model=<embedding_model_id>] [--llm-profile=<profile>] [--format=md|json]

kb llm status [--profile=<profile>]
kb llm probe [--endpoint=<url>]
kb llm use-endpoint <url> [--profile=<profile>]
kb llm install --profile=<name> --runner=llama-server --bin=<path> --model=<gguf-path> [--port=8091] [--ctx=32768] [--ngl=99]
kb llm start [--profile=<profile>]
kb llm stop [--profile=<profile>]
kb llm restart [--profile=<profile>]
kb llm set-model --profile=<profile> --model=<gguf-path> [runner flags...]
kb llm uninstall [--profile=<profile>|--all]
kb llm reap
```

`kb ask` flow:

1. Resolve the embedding model exactly like `kb search`.
2. Run retrieval using the existing index and formatter-safe context extraction.
3. Resolve the LLM endpoint from:
   - `KB_LLM_ENDPOINT`, if set.
   - The active `kb llm` profile.
   - A detected healthy `http://127.0.0.1:8080/v1/chat/completions`, treated as external/reuse-only.
4. Send an OpenAI-compatible chat completion request with the retrieved snippets and citations.
5. Return an answer that preserves source paths and line metadata from retrieval results.

`kb search --llm-rerank` can be a later milestone using the same endpoint resolver. It should not be part of the first PR because `kb ask` proves the lifecycle design without changing existing search ranking.

### 5.2 Managed vs external profiles

There are two profile types:

```json
{
  "schema_version": "kb-llm-profile.v1",
  "name": "local-qwen",
  "mode": "managed",
  "endpoint": "http://127.0.0.1:8091/v1/chat/completions",
  "health_url": "http://127.0.0.1:8091/health",
  "unit_name": "kb-llm@local-qwen.service",
  "runner": "llama-server",
  "runner_bin": "/path/to/llama-server",
  "model_path": "/path/to/model.gguf",
  "model_fingerprint": {
    "path": "/path/to/model.gguf",
    "size": 123456789,
    "mtime_ms": 1770000000000,
    "sha256_prefix": "optional-first-16-hex"
  },
  "keepalive": "lease",
  "owner": {
    "package": "@jeanibarz/knowledge-base-mcp-server",
    "install_root": "/path/to/global/node_modules/@jeanibarz/knowledge-base-mcp-server",
    "bin_path": "/path/to/bin/kb"
  }
}
```

External profile:

```json
{
  "schema_version": "kb-llm-profile.v1",
  "name": "local-research-agent",
  "mode": "external",
  "endpoint": "http://127.0.0.1:8080/v1/chat/completions",
  "health_url": "http://127.0.0.1:8080/health",
  "managed_by": "local-research-agent"
}
```

External profiles are never stopped by `kb llm stop`, `kb llm uninstall`, or `kb llm reap` unless the operator passes an explicit `--include-external` escape hatch. The default is to respect service ownership.

### 5.3 systemd unit generation

For managed profiles, `kb llm install` writes generated units under:

```text
~/.config/systemd/user/kb-llm@<profile>.service
~/.config/systemd/user/kb-llm-reaper.service
~/.config/systemd/user/kb-llm-reaper.timer
```

The generated model unit should mirror the local-research-agent unit shape:

```ini
[Unit]
Description=knowledge-base CLI local LLM (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/path/to/llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8091 ...
Restart=on-failure
RestartSec=10
TimeoutStartSec=180
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Differences from local-research-agent:

- Unit names are namespaced under `kb-llm@...` so uninstall can find only KB-owned services.
- The endpoint port is profile-scoped and defaults to `8091` to avoid `local-research-agent` port `8080`.
- `loginctl enable-linger` is not run automatically. If the operator wants boot persistence, `kb llm install --enable-on-boot` may enable linger after a confirmation prompt.
- A reaper timer is installed for managed profiles by default.

### 5.4 Lease and reaper behavior

Every `kb ask` call that uses a managed profile writes a lease:

```text
~/.local/state/kb/llm/leases/<profile>.json
```

The lease includes `last_used_at`, CLI version, `bin_path`, active profile hash, unit name, endpoint, and keepalive policy.

`kb llm reap` runs from a user timer every 15 minutes and:

1. Reads managed profiles only.
2. Skips profiles with `"keepalive": "always"`.
3. Stops a managed unit when the profile has not been used for the configured TTL, default 6 hours.
4. Stops and disables a managed unit when the recorded `bin_path` and `install_root` no longer exist.
5. Stops a managed unit when its generated unit hash no longer matches the active profile hash, which catches interrupted model changes.
6. Never touches external profiles by default.

This is the fail-safe that prevents a model from remaining loaded forever after the CLI is removed or a profile is abandoned.

### 5.5 Model-change behavior

`kb llm set-model --profile=<p> --model=<new.gguf>` is the only supported way to change the model for a managed profile.

Required behavior:

1. Compute the new model fingerprint.
2. If the existing managed unit is active, stop it first.
3. Rewrite the profile and systemd unit atomically.
4. `systemctl --user daemon-reload`.
5. Start the unit only if it was active before or the user passed `--start`.
6. Probe `/health` and report the model-load wait time.

If the operator edits the profile file manually, `kb llm status` must show `profile/unit drift` and recommend `kb llm restart --profile=<p>` or `kb llm install --profile=<p> --repair`.

If `KB_LLM_ENDPOINT` points at a different server, `kb ask` uses that endpoint for the current process only and does not mutate the active profile.

### 5.6 Uninstall behavior

There are three cleanup paths:

1. **Explicit:** `kb llm uninstall --all`
   - Stop and disable all `kb-llm@*.service` units.
   - Remove generated `kb-llm@*.service`, `kb-llm-reaper.service`, and `kb-llm-reaper.timer`.
   - Run `systemctl --user daemon-reload`.
   - Remove KB-owned profile and lease files.
   - Leave external profiles untouched unless `--include-external` is passed.

2. **Package lifecycle best-effort:** npm `preuninstall` or `postuninstall`, if supported in the packaging path, may invoke the same cleanup. This is only a convenience, not the correctness mechanism.

3. **Reaper fail-open cleanup:** if the CLI binary or install root disappears, the reaper stops and disables KB-owned units on its next run. This covers manual deletion, broken global npm uninstalls, and interrupted upgrades.

`kb llm status` must also print an uninstall warning when managed units exist but no active profile file points at them.

### 5.7 Local-research-agent reuse

On Jean's machine, the recommended default profile is external:

```bash
kb llm use-endpoint http://127.0.0.1:8080/v1/chat/completions --profile=local-research-agent
kb ask "What notes discuss stale answer evaluation?"
```

Rationale:

- The local-research-agent model is already loaded for paper ingestion.
- It already uses an OpenAI-compatible endpoint.
- It consumes most available VRAM, so a second managed LLM is likely to fail or starve Ollama embeddings.

`kb llm probe` should report:

- health endpoint status,
- chat-completions compatibility,
- approximate model identity if the server exposes it,
- whether the endpoint is external or KB-managed,
- and whether the endpoint appears to share a port with local-research-agent.

### 5.8 Prompt and answer contract

`kb ask` should be deliberately boring:

- System prompt: answer only from retrieved context; cite each claim with path metadata; say when context is insufficient.
- User prompt: original question plus top-k snippets from `kb search`.
- No automatic note writes.
- No memory promotion.
- No hidden background indexing. Use `--refresh` explicitly if the user wants current file contents before asking.

JSON output should include:

```json
{
  "answer": "...",
  "citations": [
    { "knowledge_base": "operating-environment", "path": "local-research-agent.md", "score": 0.54 }
  ],
  "llm": {
    "endpoint": "http://127.0.0.1:8080/v1/chat/completions",
    "profile": "local-research-agent",
    "mode": "external"
  },
  "retrieval": {
    "embedding_model": "ollama__nomic-embed-text-latest",
    "k": 10,
    "refreshed": false
  }
}
```

## 6. Milestones

- **M0 - Endpoint client only.** Add `src/llm-client.ts`, `kb llm probe`, `KB_LLM_ENDPOINT`, and tests against a fake OpenAI-compatible server.
- **M1 - `kb ask`.** Retrieval plus local chat completion, with markdown and JSON output. No managed service yet.
- **M2 - External profiles.** Add `kb llm use-endpoint`, `status`, profile storage, and local-research-agent reuse docs.
- **M3 - Managed systemd profiles.** Add `install/start/stop/restart/set-model/uninstall`, generated units, health waits, and unit-hash drift detection.
- **M4 - Reaper.** Add lease files, `kb llm reap`, timer install/uninstall, and stale binary cleanup.
- **M5 - Optional rerank.** Add `kb search --llm-rerank` after `kb ask` has proven endpoint reliability and prompt contracts.

## 7. Tests

- Fake OpenAI-compatible server: `kb llm probe` detects health and chat completion.
- `kb ask` includes retrieved context and preserves citations in JSON output.
- `KB_LLM_ENDPOINT` overrides active profiles without writing profile state.
- External profiles are never stopped by `kb llm stop` or `kb llm uninstall`.
- Managed `set-model` stops an active old unit before writing the new unit.
- `uninstall --all` removes only `kb-llm@*` and reaper units, not local-research-agent units.
- Reaper stops a managed unit when the CLI install root is missing.
- Reaper does not stop a managed profile with `keepalive=always`.
- Unit generation binds to `127.0.0.1` unless the operator passes an explicit non-loopback flag.

## 8. Risks

- **VRAM contention.** On Jean's machine, a managed second LLM is probably not viable while local-research-agent is loaded. Default to external endpoint reuse and make managed install explicit.
- **systemd portability.** Windows/macOS users will need a non-systemd backend later. M3 can land as Linux-only with a clear error from `kb llm install` when `systemctl --user` is unavailable.
- **Uninstall hooks are unreliable.** The reaper is required; lifecycle hooks are only best-effort.
- **Prompt injection.** Retrieved markdown can contain hostile instructions. `kb ask` must frame snippets as untrusted context and keep citations visible.
- **Endpoint ownership confusion.** The profile mode distinction is mandatory. KB-managed commands must not stop or mutate local-research-agent units by accident.

## 9. Recommendation

Implement M0-M2 first and dogfood against the existing local-research-agent endpoint. That likely solves Jean's immediate use case without any additional resident model.

Only implement managed systemd profiles after `kb ask` proves useful. When M3 lands, make the safe defaults conservative: loopback-only, no automatic linger, namespaced units, explicit `set-model`, explicit `uninstall`, and lease-based reaping.
