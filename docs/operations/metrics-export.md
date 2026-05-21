# Metrics Export

`KB_METRICS_EXPORT=on` exposes an OpenMetrics text endpoint for scrape-based
monitoring:

- `kb serve`: `GET /metrics` on the loopback daemon URL.
- `MCP_TRANSPORT=http|sse`: `GET /metrics` on the remote transport host, behind
  the same bearer-token and origin checks as MCP requests.

The endpoint is disabled by default. It includes KB names and model ids, so do
not expose it on an untrusted interface. Remote transports already require
`MCP_AUTH_TOKEN`; the local `kb serve` daemon remains loopback-only.

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

## Label Contract

The v1 exporter keeps labels bounded:

| Label | Metrics | Cardinality bound |
|---|---|---|
| `kb` | `kb_knowledge_base_*` | registered knowledge bases |
| `model_id` | `kb_provider_*` | registered embedding models observed by the process |

There are no query text, file path, user, request id, source URL, or raw error
labels.

## Metric Groups

| Prefix | Meaning |
|---|---|
| `kb_knowledge_base_*` | file counts, chunk counts, indexed bytes, quarantine counts by KB |
| `kb_provider_*` | provider call counts, errors, token totals when reported, p50/p95/p99 latency |
| `kb_query_cache_*` | query embedding cache hits, misses, bypasses, disk usage |
| `kb_relevance_gate_*` | relevance gate query and verdict counters |
| `kb_remote_transport_*` | HTTP/SSE sessions, requests, auth failures, origin denials, status buckets |
| `kb_server_uptime_ms` | process uptime for the serving process |
| `kb_index_embedding_dimensions` | active dense index dimensionality, or `0` when unknown |

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
