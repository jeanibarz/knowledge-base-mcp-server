# 0007 - Canonical log line format

- **Status:** Accepted (#216)
- **Date:** 2026-05-12
- **Deciders:** Repo owner

## Context and Problem Statement

The MCP server and `kb` CLI have historically emitted human-readable log
fragments. Those fragments are useful at a terminal, but they cannot answer
request-shaped questions such as "which retrieve calls timed out?", "what was
the p99 latency for this model?", or "which KB scope produced empty results?"
without reconstructing state from multiple unrelated lines.

The project is local-first and stdout-sensitive: MCP JSON-RPC must stay on
stdout, and observability should not introduce a metrics endpoint, exporter, or
new runtime service.

## Decision

Emit one schema-versioned JSON event at the end of each MCP tool call and each
dispatched `kb` subcommand invocation.

The event uses `schema_version: "kb-canonical.v1"` and is written through the
existing logger destinations: `LOG_FILE` when configured and stderr otherwise.
It never writes to stdout. The event contains stable request fields such as
`request_id`, `process`, `tool` or `cmd`, `model_id`, `kb_scope`,
`query_sha256`, `result_count`, `top_score`, `top_sources`, timing fields, and
an optional `{ code, category }` error object.

Queries are redacted by default. The raw query is never serialized; only a
16-character SHA-256 prefix of the whitespace-normalized query is emitted.
`top_sources` is capped at three entries to bound line size and cardinality.

Operators choose log output with `KB_LOG_FORMAT=text|canonical|both`. The
default is `both`. `text` preserves legacy human-readable output, while
`canonical` emits only canonical JSON lines.

## Consequences

- Existing JSON-RPC response shapes are unchanged.
- Existing logger destinations and `LOG_FILE` setup remain the only transport.
- Downstream scripts can rely on additive evolution within `kb-canonical.v1`.
- High-volume users need normal file log rotation if `LOG_FILE` is enabled.

## Validation

The validation gate for #216 is:

1. `KB_LOG_FORMAT=text` suppresses canonical events and keeps text logging.
2. `KB_LOG_FORMAT=canonical` writes only JSON canonical events.
3. Canonical events never include the raw query string.
4. MCP retrieve emits exactly one canonical event with model, scope, count,
   top score/source, and timing fields.
5. CLI subcommands emit exactly one invocation event from the central dispatcher.
