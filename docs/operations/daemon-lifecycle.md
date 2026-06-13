# `kb serve` — Local CLI Daemon Lifecycle

`kb serve` runs a loopback-only HTTP daemon that serves read-only `kb search`,
`kb list`, and `kb stats` requests from CLI clients. The point is *warm
reads*: the daemon keeps the FAISS index, model adapter, and lexical store
loaded in memory so each CLI invocation skips the cold-start cost.

CLI clients use the daemon when they pass `--daemon`. If the daemon is not
reachable, they print a one-line notice on stderr and fall back to direct
in-process execution. Autostart is default-off; set `KB_DAEMON_AUTOSTART=on`
only when daemon-capable reads should try to start `kb serve` automatically.

## When to run it

- You issue `kb search` more than once or twice an hour — cold start
  dominates wall time for the first call.
- You wire `kb search` into an editor, agent shell, or pre-commit hook and
  want predictable latency.
- You are debugging retrieval latency: daemon timings expose embed/search/format
  splits without the index-load tax.

## Start the daemon

```bash
kb serve [--host=127.0.0.1] [--port=17799] [--idle-timeout-ms=300000]
```

Defaults:

- `--host=127.0.0.1` (loopback only; non-loopback bind is rejected)
- `--port=17799`
- `--idle-timeout-ms=300000` (5 minutes; `0` disables auto-exit)

The process logs `kb serve: listening on http://127.0.0.1:17799/` to stdout
and stays in the foreground. SIGINT / SIGTERM stops it cleanly. Run it under
a terminal multiplexer, or wrap it in a systemd user unit for hands-off
operation:

```ini
# ~/.config/systemd/user/kb-serve.service
[Unit]
Description=kb serve — local CLI daemon

[Service]
ExecStart=%h/.local/share/npm/bin/kb serve --idle-timeout-ms=0
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now kb-serve.service
```

## Probe with `kb serve status`

`kb serve status` is a strict read-only probe — it queries `GET /health` at
the configured URL and reports reachability. It never starts or stops a
daemon.

```bash
kb serve status            # human-readable
kb serve status --json     # machine-readable
```

Exit codes are deliberately distinct:

| Exit | Meaning | Operator next step |
| --- | --- | --- |
| `0` | Daemon reachable | Continue. |
| `1` | Daemon answered with an unusable `/health` payload | Restart the daemon; the version may be stale. |
| `2` | Invalid argument or environment (bad `KB_DAEMON_URL`) | Fix the configuration. |
| `3` | No daemon listening at the configured URL | Start one with `kb serve`. **Not an error in itself** — this is the normal idle state when CLI clients are expected to fall back. |

`--json` output:

```jsonc
// Reachable
{
  "reachable": true,
  "url": "http://127.0.0.1:17799/",
  "daemon": {
    "url": "http://127.0.0.1:17799/",
    "pid": 41234,
    "uptime_ms": 124500,
    "idle_timeout_ms": 300000,
    "ownership": "manual",
    "commands": ["search", "list", "stats"]
  }
}

// Unreachable
{ "reachable": false, "url": "http://127.0.0.1:17799/" }
```

## Configure the daemon URL

CLI clients and `kb serve status` resolve the daemon URL in this order:

1. `KB_DAEMON_URL` (explicit, used verbatim — must include scheme)
2. `KB_DAEMON_HOST` + `KB_DAEMON_PORT` (composed)
3. Default `http://127.0.0.1:17799/`

For a non-default port:

```bash
export KB_DAEMON_PORT=18888
kb serve &
kb serve status
# kb serve: daemon running at http://127.0.0.1:18888/
```

For a per-user instance on a multi-tenant host, run on a unique port and
export `KB_DAEMON_URL` in the user's shell profile so every CLI call hits the
right daemon.

## Use the daemon from CLI clients

Any CLI subcommand that supports `--daemon` will use the daemon when set:

```bash
kb search "your query" --daemon --format=json
```

Without `--daemon` the CLI runs in-process.

## Autostart on daemon-capable reads

`KB_DAEMON_AUTOSTART=on` is an opt-in companion to daemon-capable CLI reads.
When a read path asks for the daemon and no listener is present at the
configured daemon URL, the client starts a detached `kb serve`, polls
`GET /health` with a bounded readiness deadline, then retries the command
through the daemon. If readiness does not complete in time, the CLI prints a
clear autostart notice and runs the command directly.

```bash
export KB_DAEMON_AUTOSTART=on
kb search "your query" --daemon
```

Race handling is intentionally conservative:

- If several callers start at the same time, each caller re-polls `/health`.
  A process that loses the bind race can still use the daemon started by
  another caller.
- If something answers at the configured URL but does not return the kb
  `/health` contract, the client treats that as a protocol mismatch and does
  not start another daemon blindly.
- Autostarted daemons report `"ownership": "autostart"` in `/health` and
  `kb serve status`; foreground and systemd-launched daemons report
  `"ownership": "manual"`.

For long-lived supervised daemons, prefer a systemd user unit with
`--idle-timeout-ms=0` and leave `KB_DAEMON_AUTOSTART` off in that service
environment. Autostart is for opportunistic warm reads, not for replacing a
deliberately managed daemon.

## Limits

- Read-only commands only: `search`, `list`, `stats`. Writes (`remember`,
  `capture`, `import-url`, `reindex`) always run in-process.
- One daemon per `FAISS_INDEX_PATH`. Multiple daemons against the same index
  is unsupported and would race the read-only refresh path.
- Loopback only. To expose CLI-shaped retrieval over the network, use the
  MCP HTTP transport — see [RFC 008](../rfcs/008-remote-transport.md).

## Diagnose

- **`kb search --daemon` falls back silently**: run `kb serve status`. If exit
  `3`, start the daemon or set `KB_DAEMON_AUTOSTART=on` for opportunistic
  starts. If exit `1`, the daemon URL is occupied by an incompatible or stale
  process and autostart will not override it.
- **Daemon exits after 5 minutes**: that's the default idle timeout. Set
  `--idle-timeout-ms=0` to disable, or wrap in systemd with `Restart=`.
- **`Address already in use`**: another daemon (or other process) holds the
  port. Pick a free one with `--port=`, or stop the conflicting process.
- **CLI ignores the daemon**: confirm `kb serve status` returns reachable
  and the client passes `--daemon`. The fallback is by design — there is no
  warning when the client chose in-process.

## JSON contract

See [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-serve-status)
for the stable `kb serve status` envelope.

## Related

- [`docs/feature-flags.md` — Daemon and CLI Fast-Path](../feature-flags.md#daemon-and-cli-fast-path)
- [`docs/operations/local-services.md`](local-services.md) for the broader
  local stack (Ollama, llama-server, n8n).
