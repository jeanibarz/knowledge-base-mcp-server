# Local Service Operations

Use this runbook when `kb` is part of a local research stack with Ollama,
llama-server, n8n, systemd user units, MCP clients, or the optional `kb serve`
daemon. It covers day-two operations: checking health, updating a linked
checkout, restarting services in a safe order, and keeping ownership boundaries
clear.

For search-result quality and stale-index symptoms, start with
[`docs/troubleshooting-local-kb.md`](../troubleshooting-local-kb.md). For MCP
client config snippets, see [`docs/clients.md`](../clients.md). For env-var
defaults, see [`docs/feature-flags.md`](../feature-flags.md).

## Service Map

| Surface | Default endpoint or path | Owner | Health check |
| --- | --- | --- | --- |
| `kb` CLI | shell command | this package | `kb doctor` |
| MCP stdio server | client child process | MCP client | restart the MCP client |
| MCP HTTP/SSE server | `127.0.0.1:8765` when enabled | this package process supervisor | `curl http://127.0.0.1:8765/health` |
| Warm CLI daemon | `http://127.0.0.1:17799` | foreground/systemd `kb serve`, or opt-in `KB_DAEMON_AUTOSTART=on` | `kb serve status` |
| Ollama embeddings | `http://localhost:11434` | Ollama | `curl http://localhost:11434/api/tags` |
| n8n workflows | `http://127.0.0.1:5678` by n8n default | n8n or local-research-agent | n8n/systemd status |
| External local LLM | `http://127.0.0.1:8080/v1/chat/completions` by convention | usually local-research-agent | `kb llm probe --endpoint=http://127.0.0.1:8080/v1/chat/completions` |
| Managed `kb` LLM profile | `http://127.0.0.1:8091/v1/chat/completions` by default | `kb llm` | `kb llm status` and `kb llm probe --endpoint=<url>` |
| Reindex trigger file | `$KNOWLEDGE_BASES_ROOT_DIR/.reindex-trigger` | external producer touches, `kb` watches | `kb doctor` |

Remote MCP transports are off by default. When `MCP_TRANSPORT=http` or
`MCP_TRANSPORT=sse`, set `MCP_AUTH_TOKEN_FILE` to a mounted secret file or set
`MCP_AUTH_TOKEN` directly; the resolved token must be at least 32 characters.
Keep `MCP_BIND_ADDR=127.0.0.1` unless you are deliberately exposing the service
to another host.

## Daily Health Check

Run these from the same shell or service environment that launches `kb`:

```bash
kb doctor
kb stats
kb serve status
kb llm status
```

Interpret the checks in order:

| Signal | Meaning | First action |
| --- | --- | --- |
| `kb doctor` reports provider unavailable | Query embeddings cannot run | Start Ollama or fix provider credentials/env, then retry `kb doctor`. |
| `kb doctor` reports a stale index | Source files changed after the active index | Run a scoped refresh: `kb search "known phrase" --kb=<name> --refresh`. |
| `kb serve status` exits `3` | No warm CLI daemon answered | Start one with `kb serve`, or set `KB_DAEMON_AUTOSTART=on` for opportunistic daemon-capable reads. |
| `kb llm status` shows no profiles | `kb ask` may still use `KB_LLM_ENDPOINT`, but no profile is stored | Add an external profile with `kb llm use-endpoint <url>` or install a managed one. |
| MCP client works differently than the shell | The client inherited different env or package version | Restart the client after updating its env block or package spec. |

Use JSON when another script or agent needs a stable payload:

```bash
kb doctor --format=json
kb stats --format=json
kb serve status --json
kb llm status --format=json
```

## Startup Order

When bringing the full stack up after reboot or a model change:

1. Start the embedding backend first.

   ```bash
   ollama list
   curl http://localhost:11434/api/tags
   ```

2. Start the external research-stack services that produce or use KB content,
   such as local-research-agent, llama-server, and n8n. Use their own
   repository docs or systemd units as the source of truth for names and ports.

3. Verify `kb` sees the same environment those services expect.

   ```bash
   kb doctor
   kb list
   kb stats
   ```

4. Start optional `kb`-owned services only when needed. `kb serve` runs in the
   foreground, so start it in its own terminal, `tmux` pane, or supervisor
   unit.

   ```bash
   kb llm start --profile=<managed-profile>
   kb serve
   ```

   If you do not want a long-lived foreground or systemd daemon, leave the
   daemon stopped and set `KB_DAEMON_AUTOSTART=on` only in shells where
   daemon-capable reads should start an opportunistic `kb serve`.

5. Restart MCP clients last. Stdio MCP servers inherit env once, at client
   launch, so client restart is what picks up a new package, model, token, or
   `KNOWLEDGE_BASES_ROOT_DIR`.

## Safe Restart Order

Prefer the narrowest restart that matches the symptom:

| Symptom | Restart |
| --- | --- |
| Shell `kb` is fixed but MCP client still fails | Restart the MCP client. |
| `kb search --daemon` is stale or slow | Check `kb serve status` ownership. Stop/restart the manual daemon or let the autostarted daemon idle out, then retry. |
| `kb ask` uses the wrong external LLM | Update `KB_LLM_ENDPOINT` or `kb llm use-endpoint <url>`, then retry. |
| Managed `kb` LLM changed model | `kb llm set-model --profile=<name> --model=<file.gguf> --start`. |
| Ollama model or endpoint changed | Restart Ollama, then run `kb doctor`. |
| local-research-agent or n8n changed content | Let that service touch the reindex trigger, or run a scoped `kb search --refresh`. |

Do not use `kb llm stop`, `restart`, `uninstall`, or `reap` to control an
external local-research-agent llama-server. External profiles are reuse-only;
manage those units from the local-research-agent side.

## Updating a Linked Checkout

If `kb` is installed from a development checkout with `npm link`, update the
checkout and rebuild before debugging runtime behavior:

```bash
which -a kb
kb doctor
cd /path/to/knowledge-base-mcp-server
git status --short --branch
git pull
npm install
npm run build
kb doctor
```

`kb doctor` reports the invoked binary, package root, symlinked checkout path,
and git relation when it can detect them. If the shell uses a published global
package but you intended a linked checkout, run:

```bash
cd /path/to/knowledge-base-mcp-server
npm run dev:setup
kb doctor
```

For MCP clients launched with `npx`, use the `@latest` package spec when you
want each client restart to re-resolve the newest published package.

## Refresh and Reindex Discipline

Normal `kb search` is read-only. Refreshes and model additions write FAISS
state and serialize with a per-model lock.

Use a scoped refresh when the changed content is confined to one KB:

```bash
kb search "known phrase" --kb=<name> --refresh
```

Use an unscoped refresh only when many KBs changed or you deliberately want all
indexes current:

```bash
kb search "known phrase" --refresh
```

External producers such as n8n flows should signal changes by touching the
configured trigger file. The default is:

```bash
touch "$KNOWLEDGE_BASES_ROOT_DIR/.reindex-trigger"
```

If `REFRESH_LOCK_BUSY` appears, another writer is already updating the same
model index. Keep using read-only search if existing results are acceptable,
or wait for the writer to finish before retrying `--refresh`.

## Logs and Evidence

Use command output before changing files or deleting index state:

```bash
kb doctor
kb logs recent
kb logs recent --format=json
kb logs show --request-id=<id>
kb serve status
kb llm status
```

Set `LOG_FILE=/path/to/kb.log` for processes where journald or MCP-client logs
are hard to inspect. For systemd user units, inspect service logs with
`journalctl --user -u <unit-name>`.

## Port and Ownership Rules

Keep these defaults distinct:

| Port | Typical service |
| --- | --- |
| `11434` | Ollama embedding API |
| `5678` | n8n default web/API port, if the research stack runs n8n locally |
| `8080` | External local-research-agent llama-server convention |
| `8091` | Managed `kb llm` profile default |
| `8765` | Optional MCP HTTP/SSE transport |
| `17799` | Optional `kb serve` warm CLI daemon |

One process should own each port. If a port is already in use, either point
`kb` at that existing owner with an endpoint/profile setting or choose a
different port for the new managed service.

`kb serve status` reports daemon ownership. `manual` means a foreground or
supervised `kb serve` process owns the URL; `autostart` means a CLI read
started it because `KB_DAEMON_AUTOSTART=on` was set. Do not enable autostart
inside a systemd unit that already manages `kb serve`; keep one ownership mode
per daemon URL.

## Shutdown Checklist

1. Stop or restart MCP clients first when changing their env or package.
2. Stop optional `kb`-owned services:

   ```bash
   kb llm stop --profile=<managed-profile>
   # Stop the foreground kb serve process with SIGINT/SIGTERM.
   ```

3. Leave external services alone unless their own runbook says to stop them.
4. After restart, run `kb doctor` and one representative query before deleting
   index state or changing provider configuration.
