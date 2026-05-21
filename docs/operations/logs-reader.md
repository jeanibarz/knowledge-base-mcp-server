# `kb logs` — Canonical Log Reader

`kb logs` is a structured reader for the canonical request log emitted under
`KB_LOG_FORMAT=canonical` or `both`. It exists so an operator (or an agent
shell) can answer "what happened in request X?" or "what queries fired in
the last hour?" without grepping mixed-format text logs by hand.

The reader consumes `kb-canonical.v1` JSON lines from a single log file and
ignores everything else, so you can point it at a log file that also contains
free-text lines without false matches.

## When to use it

- A `kb search` or `kb ask` returned an empty result or a slow timing and
  you want the full canonical envelope for that request.
- You are auditing recent retrieval activity (cache hit rate, top-source
  drift, error categories).
- You are wiring a downstream tool (Loki/Vector/Grafana) and want the same
  envelope shape over a one-shot pull rather than a streaming tail.

For *live* tailing, use your usual log-pipe tool against the file directly;
`kb logs` is a point-in-time reader.

## Two actions

```bash
kb logs recent [--limit=<n>] [--file=<path>] --format=md|json
kb logs show   --request-id=<id> [--file=<path>] --format=md|json
kb logs show   --query-sha=<hash> [--file=<path>] --format=md|json
```

`recent` returns the most recent canonical events (default limit `10`).
`show` filters by a stable id — `request_id` (one request) or `query_sha256`
(every request for the same query).

## Log-file resolution

`kb logs` resolves the source file in this order:

1. `--file=<path>` (explicit)
2. `$LOG_FILE`
3. Existing well-known local default paths

If nothing is discoverable, the command exits `2` with a JSON error envelope
(`schema_version: "kb.logs.v1"`).

## Enable canonical logging

The reader only sees lines emitted in the `kb-canonical.v1` shape. Turn that
shape on for the producing process:

```bash
export KB_LOG_FORMAT=both   # 'canonical' (JSON only) or 'both' (text + canonical)
export LOG_FILE=/tmp/kb.log # the file the producer writes
```

`both` is the safer default during rollout — you keep human-readable text
and gain machine-readable JSON in the same file. Switch to `canonical` once
your downstream consumers are wired up.

## Read a single request

When `kb search --format=json` includes a `request_id` in its error or
timing envelope, fetch the matching canonical line:

```bash
kb logs show --request-id=req-7e2b --format=json | jq
```

```jsonc
{
  "schema_version": "kb.logs.v1",
  "action": "show",
  "source": "/tmp/kb.log",
  "filters": { "request_id": "req-7e2b" },
  "scanned_line_count": 1247,
  "canonical_event_count": 412,
  "ignored_line_count": 835,
  "malformed_canonical_line_count": 0,
  "result_count": 1,
  "events": [
    {
      "ts": "2026-05-21T08:30:00.000Z",
      "request_id": "req-7e2b",
      "process": "cli",
      "cmd": "kb search",
      "query_sha256": "ab12…",
      "took_ms": 42,
      "timings": { "embed_ms": 10, "faiss_ms": 20, "format_ms": 3 },
      "cache": "miss",
      "result_count": 3,
      "top_sources": ["docs/a.md"]
    }
  ]
}
```

`scanned_line_count` minus `canonical_event_count` is the count of plain-text
log lines the reader skipped over. A high `malformed_canonical_line_count` is
a producer bug worth raising.

## Audit recent activity

```bash
kb logs recent --limit=50 --format=json \
  | jq -r '.events[] | "\(.ts) \(.took_ms)ms \(.cmd) \(.cache // "-") rc=\(.result_count // "-") err=\(.error.code // "-")"'
```

A canonical log line carries everything `kb stats` would summarise *per
request* — cache state, timings, top sources, error codes, recovery hints —
so this kind of pull is enough for a quick performance sanity-check.

## Group repeated queries

`query_sha256` is stable across runs of the same query string, so `show
--query-sha=<hash>` returns every historical hit for that query. Use it to
trace a query whose results changed after a reindex or model swap.

## Diagnose

- **`result_count: 0`** — no events matched. Check the filter; for
  `--request-id`, the id must be the exact value from the producer.
- **Exit `2` with a JSON error envelope** — the reader couldn't find a log
  file. Set `LOG_FILE` and re-run the producer first.
- **High `malformed_canonical_line_count`** — the producer is emitting
  invalid JSON. File an issue with the bad line.

## JSON contract

See [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-logs) for the
stable `recent` / `show` envelopes and event field list.

## Related

- [`docs/feature-flags.md` — Output, Diagnostics, and Logging](../feature-flags.md#output-diagnostics-and-logging)
- [RFC 009 — Error Taxonomy](../rfcs/009-error-taxonomy.md) for the
  `error.code` / `error.category` shape carried in canonical events.
