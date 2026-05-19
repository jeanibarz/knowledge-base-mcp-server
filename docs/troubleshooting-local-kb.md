# Troubleshooting Local `kb` Installs

Use this runbook when `kb search` or the MCP `retrieve_knowledge` tool returns no useful results, reports stale index state, or appears to use a different checkout or embedding model than expected.

Start with the read-only health check:

```bash
kb doctor
kb doctor --format=json
```

`kb doctor` reports active-model resolution, index path and version, stale file counts, embedding backend health, local LLM endpoint readiness for `kb ask`, CLI package and symlink state, git drift for linked checkouts, and the latest index-update summary. Use it before deleting index files, changing client configuration, or debugging local LLM answers.

## Quick Symptom Table

| Symptom | Likely cause | First command | Next action |
| --- | --- | --- | --- |
| `kb search` returns zero results for content you know exists | Querying the wrong KB, stale index, or no index yet | `kb doctor` | Confirm `KNOWLEDGE_BASES_ROOT_DIR`, then run `kb search "known phrase" --kb=<name> --refresh`. |
| Search output footer says the selected KB or global index is stale | Source files changed after the last refresh | `kb stats --kb=<name>` | Run `kb search "known phrase" --kb=<name> --refresh`; omit `--kb` only when you intend to refresh every KB. |
| MCP client returns old results but shell `kb` is fresh | Client process still has an older package/env, or uses `npx` cache | `kb doctor` in the same shell/env as the client when possible | Restart the client, prefer `@latest` in `npx` args, or point the client at the intended linked checkout. |
| `ACTIVE_MODEL_UNRESOLVED` or doctor shows no active model | `${FAISS_INDEX_PATH}/active.txt` points at a missing model, `KB_ACTIVE_MODEL` is wrong, or no model is registered | `kb models list` | Add or select a model with `kb models add ...` or `kb models set-active <id>`. |
| `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, or backend check is unhealthy | Ollama is down, remote provider is unreachable, or API credentials are missing/invalid | `kb doctor` | Start the backend, fix API keys/env, then retry the search. |
| `REFRESH_LOCK_BUSY` | Another refresh or model add is already writing the same model index | `kb doctor` | Wait for the writer to finish; retry read-only search without `--refresh` if stale results are acceptable. |
| `kb` command uses the wrong code after `git pull` | Global bin points at an old npm install or a different `npm link` checkout | `which -a kb` | Inspect the symlinked checkout, rebuild it with `npm run build`, or reinstall the published package. |
| `kb search --daemon` feels no faster than a plain search | No `kb serve` daemon is running, so each call silently falls back to direct execution | `kb serve status` | Start a daemon with `kb serve`; the fallback notice on stderr names the URL that was tried. |

## Empty Result Flow

1. Check basic availability and paths:

   ```bash
   kb doctor
   kb list
   kb stats
   ```

   Confirm that the reported `KNOWLEDGE_BASES_ROOT_DIR` contains the KB subdirectory you expect, and that `kb stats` shows non-zero files and chunks for that KB.

2. Search for an exact phrase from a known file:

   ```bash
   kb search "exact phrase from a note" --kb=<name> --k=5
   ```

   If this is empty and the freshness footer reports stale files, refresh the selected KB:

   ```bash
   kb search "exact phrase from a note" --kb=<name> --refresh --k=5
   ```

3. If the phrase is path-like, flag-like, code-like, or an error code, use the lexical or hybrid surfaces:

   ```bash
   kb search "INDEX_NOT_INITIALIZED" --mode=hybrid --k=5
   kb search "src/cli-search.ts" --mode=auto --k=5
   ```

4. If `--refresh` still produces no hits, verify that the file type is indexed. The default ingest allowlist covers `.md`, `.markdown`, `.txt`, and `.rst`; extensionless files and excluded paths are ignored unless you configure ingest overrides.

## Stale Index Footers

`kb search` is read-only by default. It loads the existing FAISS index and reports whether source files are newer than the index.

Use the footer this way:

| Footer state | Meaning | Command |
| --- | --- | --- |
| Selected scope stale, global fresh or unknown | The KB you queried has changed | `kb search "query" --kb=<name> --refresh` |
| Selected scope fresh, global stale | Your query scope is current, but another KB has changed | Refresh the other KB later, or run an unscoped refresh when you want all KBs current. |
| Global stale with many new files | A broad refresh may be expensive | Run `kb doctor`, then scope the refresh: `kb search "query" --kb=<name> --refresh`. |
| Fresh but result quality is poor | Index freshness is not the problem | Try `--mode=hybrid`, a narrower `--kb`, or a query phrase closer to the document wording. |

Refresh writes index state. Avoid running broad refreshes from multiple shells at the same time.

## Linked Checkout and Global Bin Drift

Use this flow when local development docs say the global `kb` should follow a checkout, but the command behaves like an older release.

```bash
which -a kb
kb doctor
npm prefix -g
npm ls -g --depth=0 @jeanibarz/knowledge-base-mcp-server
```

In `kb doctor`, inspect the CLI fields:

- `invoked_path`: the executable your shell resolved.
- `package_root`: the package that executable loaded.
- `symlinked_checkout_path`: the linked checkout when `npm link` is active.
- `git.relation`: whether the linked checkout is ahead, behind, diverged, or current against `origin/main`.

If `symlinked_checkout_path` is the checkout you expect:

```bash
cd /path/from/symlinked_checkout_path
git status --short --branch
git pull
npm install
npm run build
kb doctor
```

If `kb` points at a published npm install but you want a live checkout:

```bash
cd /path/to/knowledge-base-mcp-server
npm run dev:setup
kb doctor
```

If you want to return to the published package:

```bash
npm unlink -g @jeanibarz/knowledge-base-mcp-server
npm install -g @jeanibarz/knowledge-base-mcp-server@latest
kb doctor
```

For MCP clients that use `npx`, prefer `@jeanibarz/knowledge-base-mcp-server@latest` in the client args. The unversioned package spec can stay pinned in the local `npx` cache until that cache entry is removed.

## Missing or Wrong Active Model

The active model is resolved from an explicit request, then `KB_ACTIVE_MODEL`, then `${FAISS_INDEX_PATH}/active.txt`, then legacy provider env vars.

Diagnose:

```bash
kb doctor
kb models list
```

Fix common cases:

| Doctor/search signal | What it usually means | Command |
| --- | --- | --- |
| `ACTIVE_MODEL_UNRESOLVED` | The selected model id is not registered under this `FAISS_INDEX_PATH` | `kb models list` then `kb models set-active <id>` |
| `kb models list` has no entries | No model index has been registered yet | `kb models add ollama nomic-embed-text` or the provider/model you use |
| Shell works, MCP client fails | Client env has a different `KB_ACTIVE_MODEL` or `FAISS_INDEX_PATH` | Update the client env block and restart the client. |
| Results changed after provider env edits | The model id changed and a new model index is needed | `kb models add <provider> <model>` then `kb models set-active <id>`. |

To test a model without changing the default:

```bash
kb search "known phrase" --model=<model_id> --k=5
```

## Backend or Provider Unavailable

`kb search` needs the embedding backend to embed the query, even when the index already exists. `kb doctor` checks the configured backend and prints the provider-specific detail.

| Provider | Check | Common fix |
| --- | --- | --- |
| Ollama | `kb doctor` and `curl http://localhost:11434/api/tags` | Start Ollama and pull the configured embedding model. |
| OpenAI | `kb doctor` | Export `OPENAI_API_KEY` in the shell or MCP client env; verify the model name. |
| HuggingFace | `kb doctor` | Export `HUGGINGFACE_API_KEY`; verify endpoint/provider settings if using a custom router provider. |

After fixing env for an MCP client, restart that client so the child process receives the new variables.

## Refresh Lock Contention

`kb search --refresh`, `kb models add`, and MCP refresh paths serialize writes with per-model locks under `${FAISS_INDEX_PATH}/models/<id>/.kb-write.lock`. Read-only `kb search` does not take that write lock.

When you see `REFRESH_LOCK_BUSY`:

```bash
kb doctor
kb search "known phrase" --k=5
```

If read-only results are acceptable, keep working from the existing index and retry `--refresh` later. If the writer appears stuck, identify the shell, MCP client, or service that started a refresh before removing any lock file manually.

## Warm Daemon (`kb serve`)

`kb serve` starts a localhost-only HTTP daemon that keeps the index warm so
repeated `kb search --daemon` calls skip cold-start cost. The daemon is
read-only (search/list/stats), binds loopback only, and exits after its idle
timeout. `kb serve` itself adds no start/stop supervision — run it under your
own shell, `tmux`, or a user service.

Use `kb serve status` to inspect lifecycle without starting anything:

```bash
kb serve status          # human-readable: URL, PID, uptime, idle timeout, commands
kb serve status --json   # { "reachable": true|false, "url": ..., "daemon": {...} }
```

Exit codes make it scriptable: `0` a daemon answered, `3` nothing is listening
at the configured URL, `2` a bad argument or `KB_DAEMON_URL` value.

`kb search --daemon` never fails just because the daemon is down — it prints a
one-line notice to stderr (`kb search: daemon unavailable at <url>; ran search
directly ...`) and runs the search in-process. If you expected the warm path,
that notice and `kb serve status` together tell you whether to start a daemon.

`KB_DAEMON_URL` (default `http://127.0.0.1:17799`) selects the daemon that
both `kb serve status` and `kb search --daemon` talk to. A `/health` probe
counts as activity, so polling `kb serve status` also defers the idle timeout.

## Command Choice

| Need | Command |
| --- | --- |
| Health snapshot before changing anything | `kb doctor` |
| Machine-readable health for an agent/script | `kb doctor --format=json` |
| Confirm KB names | `kb list` |
| Confirm file/chunk counts and index metadata | `kb stats` or `kb stats --kb=<name>` |
| Search without changing index state | `kb search "query"` |
| Check whether a warm `kb serve` daemon is running | `kb serve status` |
| Warm repeated searches through the daemon | `kb serve` then `kb search "query" --daemon` |
| Refresh a specific KB and then search | `kb search "query" --kb=<name> --refresh` |
| Refresh all KBs and then search | `kb search "query" --refresh` |
| Debug code/path/error-code queries | `kb search "query" --mode=hybrid` or `--mode=auto` |
| Inspect registered models | `kb models list` |
| Switch default model | `kb models set-active <id>` |
| Verify linked checkout/global bin state | `which -a kb` and `kb doctor` |
