# Metrics Export

`KB_METRICS_EXPORT=on` exposes an OpenMetrics text endpoint for scrape-based
monitoring:

- `kb serve`: `GET /metrics` on the loopback daemon URL.
- `MCP_TRANSPORT=http|sse`: `GET /metrics` on the remote transport host, behind
  the same bearer-token and origin checks as MCP requests.

The endpoint is disabled by default. It includes KB names and model ids, so do
not expose it on an untrusted interface. Remote transports already require
`MCP_AUTH_TOKEN`; the local `kb serve` daemon is not exposed remotely by
default.

For the generated catalog of metric names, types, help text, and labels, see
[Metrics reference](../reference/metrics.md).

## Enable

```bash
KB_METRICS_EXPORT=on kb serve
curl -s http://127.0.0.1:17799/metrics
```

For authenticated HTTP transport:

```bash
MCP_TRANSPORT=http \
MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
KB_METRICS_EXPORT=on \
node build/index.js

curl -s \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  http://127.0.0.1:8765/metrics
```

## Daemonless one-shot dump

Hosts without a long-lived `kb serve` daemon (single-shot CLI usage, cron jobs,
node-exporter textfile collectors) can render the same OpenMetrics exposition
from a one-shot `kb stats` run — no daemon and no `KB_METRICS_EXPORT` flag
required:

```bash
kb stats --format=openmetrics > /var/lib/node_exporter/textfile/kb.prom
# or push to a Pushgateway:
kb stats --format=openmetrics | curl --data-binary @- http://pushgateway:9091/metrics/job/kb
```

The output is pipe-clean on stdout (diagnostics go to stderr). It covers the
process-derivable families — corpus (`kb_knowledge_base_*`), index
(`kb_index_embedding_dimensions`, `kb_build_info`), provider
(`kb_provider_*`), chat LLM (`kb_llm_*` and bounded attribution), query and
answer cache (`kb_query_cache_*`, `kb_answer_cache_*`), rerank
(`kb_rerank_*`), search-latency, and relevance-gate counters.

Daemon-instance-only gauges are **omitted** rather than emitted as misleading
zeros, because they only have meaning inside a running daemon:

- `kb_daemon_inflight` / `kb_daemon_rejected_total` — admission control (`kb serve`).
- Provider circuit-breaker state (`kb_provider_circuit_*`) — process-local and
  resets each process, so a one-shot dump emits nothing until that process has
  itself exercised a provider; the signal is meaningful from the long-lived
  daemon.
- Remote-transport counters (`kb_remote_transport_*`) — only present when the
  metrics come from an HTTP/SSE transport instance.

Use the daemon `GET /metrics` endpoint when you need those live gauges.

## Label Contract

The v1 exporter keeps labels bounded:

| Label | Metrics | Cardinality bound |
|---|---|---|
| `kb` | `kb_knowledge_base_*` | registered knowledge bases |
| `model_id` | `kb_provider_call*` | registered embedding models observed by the process |
| `operation` | `kb_llm_*` | fixed `ask`, `gate`, `preface` chat paths |
| `provider` | `kb_llm_attributed_*` | fixed `local`, `openrouter`, `fake`, `unknown` |
| `model` | `kb_llm_attributed_*` | fixed coarse families: `local`, `fake`, `deepseek`, `qwen`, `llama`, `gpt`, `claude`, `gemini`, `mistral`, `other`, `unknown` |
| `token_type` | `kb_llm_tokens_total` | fixed `prompt`, `completion` usage types |
| `outcome` | `kb_llm_cache_outcomes_total`, `kb_query_cache_outcomes_total`, `kb_answer_cache_outcomes_total` | fixed `hit`, `miss`, `not_applicable` |
| `impact` | `kb_llm_answer_impact_total` | fixed `used`, `not_used`, `unknown` |
| `kind` | `kb_provider_circuit_*` | `embedding`, `llm`, `unknown` |
| `provider` | `kb_provider_circuit_*` | configured embedding/LLM provider names |
| `mode` | `kb_search_*` | `dense`, `lexical`, `hybrid`, `auto`, `unknown` |
| `stage` | `kb_search_stage_duration_ms` | fixed search timing stage names |
| `status` | `kb_search_*` | `success`, `error` |
| `resource_kind` | `kb_write_lock_*` | `active_index`, `model_index`, `other` |
| `version`, `commit` | `kb_build_info` | one serving process build identity |

There are no query text, file path, user, request id, source URL, or raw error
labels.

## Metric Groups

| Prefix | Meaning |
|---|---|
| `kb_build_info` | package version and source/build commit for the serving process |
| `kb_knowledge_base_*` | file counts, chunk counts, indexed bytes, quarantine counts by KB |
| `kb_provider_call*` | provider call counts, errors, token totals when reported, p50/p95/p99 latency |
| `kb_llm_*` | chat-completion logical call/error/attempt/retry counters, reported prompt/completion tokens, workflow cache outcomes, answer impact, and latency histograms by operation |
| `kb_llm_attributed_*` | logical calls, attempts, retries, token totals, and latency grouped by bounded provider and coarse model family |
| `kb_provider_circuit_*` | provider circuit-breaker state gauge (0=closed, 1=half-open, 2=open) and cumulative open-transition counter, by `kind`/`provider` |
| `kb_search_requests_total` | daemon-served search request totals by mode/status |
| `kb_search_request_duration_ms` | end-to-end daemon-served search request latency histogram |
| `kb_search_stage_duration_ms` | per-stage daemon-served search latency histogram |
| `kb_write_lock_wait_duration_ms` | write-lock acquisition wait latency histogram by resource kind |
| `kb_write_lock_hold_duration_ms` | write-lock function hold latency histogram by resource kind |
| `kb_query_cache_*` | query embedding cache hits, misses, not-applicable outcomes, bypasses, and disk usage |
| `kb_answer_cache_*` | answer-cache hits, misses, bounded outcomes, and disk usage; an answer-cache hit avoids a provider call |
| `kb_relevance_gate_*` | relevance gate query and verdict counters |
| `kb_remote_transport_*` | HTTP/SSE sessions, requests, auth failures, origin denials, status buckets |
| `kb_server_uptime_ms` | process uptime for the serving process |
| `kb_index_embedding_dimensions` | active dense index dimensionality, or `0` when unknown |

Search latency histograms use the same millisecond bucket bounds as provider
latency telemetry: `1`, `3`, `10`, `30`, `100`, `300`, `1000`, `3000`,
`10000`, `30000`, and `+Inf`.

Search timing scope is process-local and scrapeable only for searches served
by the resident process:

- MCP `retrieve_knowledge` on stdio, HTTP, or SSE transports.
- `kb search --daemon` requests handled by `kb serve`.

One-shot `kb search` processes are not exported: the process exits before a
Prometheus scraper can reliably collect its in-memory timings. Stage labels
come from the existing `--timing`/canonical-log vocabulary where practical
(`embed_query`, `faiss_search`, `query_search`, `post_filter`,
`lexical_search`, `fusion`, `rerank`, `gate`, `format`, and related setup
stages).

## Retrieval summarization audit (#859)

The current implementation has no distinct `retrieval_summary` LLM path. The
`ask` operation generates the final answer, `gate` performs the optional
relevance judgment, and `preface` generates contextual text for embedding and
indexing rather than for the final answer. Query and answer caches are
workflow boundaries around those paths. `retrieval_summary` is therefore not
applicable to this telemetry contract.

## Prometheus Scrape

```yaml
scrape_configs:
  - job_name: knowledge-base-mcp-server
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:17799']
```

For authenticated MCP HTTP/SSE transport, configure your scraper to send the
same bearer token used by MCP clients.
