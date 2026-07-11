# `kb serve` — Local CLI Daemon Lifecycle

`kb serve` runs a local HTTP daemon that serves read-only `kb search`, `kb list`,
and `kb stats` requests from CLI clients over loopback TCP or a Unix-domain
socket. The point is *warm reads*: the daemon keeps the FAISS index, model
adapter, and lexical store loaded in memory so each CLI invocation skips the
cold-start cost.

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
kb serve [--host=127.0.0.1] [--port=17799] [--idle-timeout-ms=300000] [--warm]
```

Defaults:

- `--host=127.0.0.1` (loopback only; non-loopback bind is rejected)
- `--port=17799`
- `--idle-timeout-ms=300000` (5 minutes; `0` disables auto-exit)
- `--warm` pre-loads the active model, FAISS index, and lexical indexes
  before the daemon reports ready. `KB_DAEMON_PREWARM=on` enables the same
  behavior from the environment.

Startup prewarm is best-effort: if active model or index loading fails, the
daemon still starts, reports `"prewarm": {"status": "failed", ...}` in
`/health`, and falls back to lazy loading on the first real request.

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
    "commands": ["search", "list", "stats"],
    "prewarm": {
      "enabled": true,
      "status": "ready",
      "model_id": "ollama__nomic-embed-text-latest",
      "lexical_kbs": 3
    }
  }
}

// Unreachable
{ "reachable": false, "url": "http://127.0.0.1:17799/" }
```

## Configure the daemon URL

CLI clients and `kb serve status` resolve the daemon URL in this order:

1. `KB_DAEMON_URL` (explicit, used verbatim — must include scheme)
2. `KB_DAEMON_SOCKET` (Unix-domain socket path)
3. `KB_DAEMON_HOST` + `KB_DAEMON_PORT` (composed)
4. Default `http://127.0.0.1:17799/`

For a non-default port:

```bash
export KB_DAEMON_PORT=18888
kb serve &
kb serve status
# kb serve: daemon running at http://127.0.0.1:18888/
```

For a per-user instance on a multi-tenant host, prefer a Unix-domain socket so
filesystem permissions control access and no TCP port allocation is needed:

```bash
export KB_DAEMON_SOCKET="$XDG_RUNTIME_DIR/kb-daemon.sock"
kb serve &
kb serve status
# kb serve: daemon running at unix:///run/user/1000/kb-daemon.sock
```

`kb serve --socket=/path/to/kb-daemon.sock` binds the foreground daemon to a
socket path directly. The daemon creates the socket with `0600` permissions,
removes stale socket files before binding, and refuses to replace a socket that
already accepts connections.

## Use the daemon from CLI clients

Any CLI subcommand that supports `--daemon` will use the daemon when set:

```bash
kb search "your query" --daemon --format=json
```

Without `--daemon` the CLI runs in-process.

## Wire protocol: `POST /v1/run`

`POST /v1/run` is the internal endpoint used by daemon-capable CLI commands.
It is an **unstable, local-only implementation detail**, not a public API or a
compatibility promise. Prefer the `kb` CLI as the client. There is no HTTP
authentication layer: access is limited by the daemon's loopback-only TCP bind
or, for a Unix-domain socket, the socket's `0600` filesystem permissions.

Send a JSON object with one of the supported read-only commands and its CLI
arguments:

```json
{
  "command": "search",
  "args": ["daemon admission control", "--format=json"]
}
```

- `command` must be `search`, `list`, or `stats`.
- `args` must be an array of strings. They are the arguments after the command
  name, exactly as the CLI handler would receive them.
- `search --refresh` is rejected because the daemon is read-only.
- Unknown top-level fields are currently ignored, but clients should not rely
  on that behavior.

For example, over loopback TCP:

```bash
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  --data '{"command":"list","args":["--format=json"]}' \
  http://127.0.0.1:17799/v1/run
```

Or over a configured Unix-domain socket:

```bash
curl --fail-with-body --unix-socket "$KB_DAEMON_SOCKET" \
  -H 'Content-Type: application/json' \
  --data '{"command":"stats","args":["--format=json"]}' \
  http://localhost/v1/run
```

An admitted command returns HTTP `200` and a CLI-shaped JSON envelope:

```json
{
  "exitCode": 0,
  "stdout": "{\"knowledge_bases\":[\"engineering\"]}\n",
  "stderr": ""
}
```

`exitCode` is an integer and `stdout` and `stderr` are strings. A command-level
failure may still use HTTP `200` with a non-zero `exitCode`; callers should
interpret all three fields as they would the result of an in-process CLI run.
The bundled client requires these fields with these types and ignores extra
response fields. A malformed `200` payload is a protocol error.

Transport and admission errors use non-2xx HTTP statuses:

| Status | JSON body | Meaning |
| --- | --- | --- |
| `400` | `{"error":"invalid_json"}` | The request body is not valid JSON. |
| `400` | `{"error":"invalid_request"}` | `command` is unsupported or `args` is not an array of strings. |
| `400` | `{"error":"read_only_daemon","message":"kb serve does not run search --refresh"}` | The request attempts a refreshing search. |
| `404` | `{"error":"not_found"}` | The method/path combination is not `POST /v1/run` (and is not another daemon endpoint). |
| `429` | `{"error":"too_many_requests","message":"kb serve: daemon at capacity; retry after backoff"}` | All execution slots and queue positions are occupied. |
| `500` | `{"exitCode":1,"stdout":"","stderr":"kb serve: <message>\n"}` | An admitted handler threw before it could return a command result. |

A `429` response includes `Retry-After: 1`, in seconds. Alternate clients may
wait at least that long and retry with their own bounded retry policy. The
bundled client does not automatically retry a `429`: like every non-2xx
response, it raises a daemon protocol error and does not silently fall back to
an in-process run. Connection failures and its 1500 ms request timeout are
availability failures; those can trigger the documented fallback or autostart
behavior instead.

All daemon JSON responses currently use `Content-Type: application/json` and
end with a newline. Clients should parse JSON rather than depend on whitespace,
error message text, ignored request fields, or fields beyond the required
success envelope. Before sending a command, an alternate client can inspect
`GET /health` and its `commands` array, but must still tolerate a later rejection
or protocol mismatch because `/v1/run` remains unstable across versions.

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
