import type { KbStatsPayload } from './kb-stats.js';
import {
  parseProviderCircuitKey,
  type ProviderCircuitSnapshot,
  type ProviderCircuitState,
} from './provider-breaker.js';
import {
  LATENCY_BUCKET_BOUNDS_MS,
  isLlmCallOperation,
  kbSearchFailureMetrics,
  type KbSearchFailureSnapshot,
  type LatencyHistogramSnapshot,
  type LlmCallMetricsSnapshot,
  type RerankMetricsSnapshot,
  type SearchLatencyMetricsSnapshot,
  type SearchLatencyMode,
  type SearchLatencyStatus,
  type WriteLockMetricsSnapshot,
} from './metrics.js';

interface MetricSample {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

interface MetricDefinition {
  name: string;
  help: string;
  type: OpenMetricsMetricType;
  samples: MetricSample[];
}

export type OpenMetricsMetricType = 'counter' | 'gauge' | 'histogram';

export interface OpenMetricsMetricReference {
  name: string;
  type: OpenMetricsMetricType;
  help: string;
  labels: readonly string[];
  emittedWhen: string;
}

export const OPEN_METRICS_REFERENCE: readonly OpenMetricsMetricReference[] = [
  {
    name: 'kb_build_info',
    type: 'gauge',
    help: 'Build identity for the serving process.',
    labels: ['commit', 'version'],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_knowledge_base_files',
    type: 'gauge',
    help: 'Number of ingestable source files by knowledge base.',
    labels: ['kb'],
    emittedWhen: 'Emitted once per registered knowledge base.',
  },
  {
    name: 'kb_knowledge_base_chunks',
    type: 'gauge',
    help: 'Number of dense index chunks by knowledge base.',
    labels: ['kb'],
    emittedWhen: 'Emitted once per registered knowledge base.',
  },
  {
    name: 'kb_knowledge_base_indexed_bytes',
    type: 'gauge',
    help: 'Total bytes from ingestable files by knowledge base.',
    labels: ['kb'],
    emittedWhen: 'Emitted once per registered knowledge base.',
  },
  {
    name: 'kb_knowledge_base_quarantined_chunks',
    type: 'gauge',
    help: 'Number of quarantined chunks by knowledge base.',
    labels: ['kb'],
    emittedWhen: 'Emitted once per knowledge base with quarantined chunks.',
  },
  {
    name: 'kb_server_uptime_ms',
    type: 'gauge',
    help: 'Process uptime in milliseconds for the serving process.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_index_embedding_dimensions',
    type: 'gauge',
    help: 'Embedding dimension of the active FAISS index, or 0 when unknown.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_provider_calls_total',
    type: 'counter',
    help: 'Embedding provider calls by model id.',
    labels: ['model_id'],
    emittedWhen: 'Emitted once per embedding model observed by the process.',
  },
  {
    name: 'kb_provider_call_errors_total',
    type: 'counter',
    help: 'Embedding provider call errors by model id.',
    labels: ['model_id'],
    emittedWhen: 'Emitted once per embedding model observed by the process.',
  },
  {
    name: 'kb_provider_tokens_in_total',
    type: 'counter',
    help: 'Reported input tokens consumed by embedding provider calls.',
    labels: ['model_id'],
    emittedWhen: 'Emitted once per model after the provider reports token usage.',
  },
  {
    name: 'kb_provider_call_latency_p50_ms',
    type: 'gauge',
    help: 'Embedding provider call latency p50 by model id, in milliseconds.',
    labels: ['model_id'],
    emittedWhen: 'Emitted once per embedding model observed by the process.',
  },
  {
    name: 'kb_provider_call_latency_p95_ms',
    type: 'gauge',
    help: 'Embedding provider call latency p95 by model id, in milliseconds.',
    labels: ['model_id'],
    emittedWhen: 'Emitted once per embedding model observed by the process.',
  },
  {
    name: 'kb_provider_call_latency_p99_ms',
    type: 'gauge',
    help: 'Embedding provider call latency p99 by model id, in milliseconds.',
    labels: ['model_id'],
    emittedWhen: 'Emitted once per embedding model observed by the process.',
  },
  {
    name: 'kb_llm_calls_total',
    type: 'counter',
    help: 'Chat-completion calls by bounded operation.',
    labels: ['operation'],
    emittedWhen: 'Emitted once per chat operation observed by the process.',
  },
  {
    name: 'kb_llm_call_errors_total',
    type: 'counter',
    help: 'Chat-completion call errors by bounded operation.',
    labels: ['operation'],
    emittedWhen: 'Emitted once per chat operation observed by the process.',
  },
  {
    name: 'kb_llm_tokens_total',
    type: 'counter',
    help: 'Reported prompt and completion tokens consumed by chat-completion calls.',
    labels: ['operation', 'token_type'],
    emittedWhen: 'Emitted once per operation and token type after the provider reports usage.',
  },
  {
    name: 'kb_provider_circuit_state',
    type: 'gauge',
    help: 'Provider circuit-breaker state (0=closed, 1=half-open, 2=open) by provider and kind; the worst state is reported when several keys share a provider/kind.',
    labels: ['kind', 'provider'],
    emittedWhen: 'Emitted once per provider/kind after a breaker has tracked at least one call in this process.',
  },
  {
    name: 'kb_provider_circuit_open_total',
    type: 'counter',
    help: 'Cumulative provider circuit-breaker open transitions by provider and kind.',
    labels: ['kind', 'provider'],
    emittedWhen: 'Emitted once per provider/kind after a breaker has tracked at least one call in this process.',
  },
  {
    name: 'kb_search_requests_total',
    type: 'counter',
    help: 'Daemon-served search requests by effective mode and status.',
    labels: ['mode', 'status'],
    emittedWhen: 'Emitted after daemon-served search requests are observed.',
  },
  {
    name: 'kb_search_degraded_total',
    type: 'counter',
    help: 'Search requests degraded from dense-provider retrieval to lexical-only output by bounded reason.',
    labels: ['mode', 'reason'],
    emittedWhen: 'Emitted after degraded daemon-served search requests are observed.',
  },
  {
    name: 'kb_search_kb_failures_total',
    type: 'counter',
    help: 'Per-KB fan-out failures in the multi-KB search leg (load/refresh/query errors that yielded partial results) by knowledge base.',
    labels: ['kb'],
    emittedWhen: 'Emitted once per knowledge base that has failed at least one fan-out during the process lifetime.',
  },
  {
    name: 'kb_rerank_invocations_total',
    type: 'counter',
    help: 'Reranker-stage invocations.',
    labels: [],
    emittedWhen: 'Emitted when reranker telemetry is available.',
  },
  {
    name: 'kb_rerank_skipped_total',
    type: 'counter',
    help: 'Reranker-stage skips by bounded reason.',
    labels: ['reason'],
    emittedWhen: 'Emitted when reranker telemetry is available and skip reasons have been observed.',
  },
  {
    name: 'kb_rerank_candidates_total',
    type: 'counter',
    help: 'Reranker-stage candidates by scoring source.',
    labels: ['source'],
    emittedWhen: 'Emitted when reranker telemetry is available and candidate sources have been observed.',
  },
  {
    name: 'kb_query_cache_hits_total',
    type: 'counter',
    help: 'Query embedding cache hits.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_query_cache_misses_total',
    type: 'counter',
    help: 'Query embedding cache misses.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_query_cache_bypasses_total',
    type: 'counter',
    help: 'Query embedding cache bypasses.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_query_cache_disk_size_bytes',
    type: 'gauge',
    help: 'Query embedding cache disk usage in bytes.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_relevance_gate_queries_total',
    type: 'counter',
    help: 'Relevance-gated retrieval queries.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_relevance_gate_verdict_injected_total',
    type: 'counter',
    help: 'Relevance gate injected-context verdict count.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_relevance_gate_verdict_no_relevant_context_total',
    type: 'counter',
    help: 'Relevance gate no-relevant-context verdict count.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_relevance_gate_verdict_empty_index_total',
    type: 'counter',
    help: 'Relevance gate empty-index verdict count.',
    labels: [],
    emittedWhen: 'Always emitted.',
  },
  {
    name: 'kb_remote_transport_requests_total',
    type: 'counter',
    help: 'Remote HTTP/SSE transport requests.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  {
    name: 'kb_remote_transport_sessions_opened_total',
    type: 'counter',
    help: 'Remote HTTP/SSE transport sessions opened.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  {
    name: 'kb_remote_transport_sessions_closed_total',
    type: 'counter',
    help: 'Remote HTTP/SSE transport sessions closed.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  {
    name: 'kb_remote_transport_current_sessions',
    type: 'gauge',
    help: 'Current remote HTTP/SSE transport sessions.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  {
    name: 'kb_remote_transport_in_flight_requests',
    type: 'gauge',
    help: 'Current in-flight remote HTTP/SSE transport requests.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  {
    name: 'kb_remote_transport_auth_failures_total',
    type: 'counter',
    help: 'Remote HTTP/SSE transport authentication failures.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  {
    name: 'kb_remote_transport_origin_denials_total',
    type: 'counter',
    help: 'Remote HTTP/SSE transport CORS origin denials.',
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  },
  ...(['1xx', '2xx', '3xx', '4xx', '5xx'] as const).map((bucket) => ({
    name: `kb_remote_transport_responses_${bucket}_total`,
    type: 'counter' as const,
    help: `Remote HTTP/SSE transport ${bucket} responses.`,
    labels: [],
    emittedWhen: 'Emitted when HTTP or SSE transport stats are available.',
  })),
  {
    name: 'kb_search_request_duration_ms',
    type: 'histogram',
    help: 'End-to-end daemon-served search request latency in milliseconds.',
    labels: ['le', 'mode', 'status'],
    emittedWhen: 'Emitted after daemon-served search requests are observed.',
  },
  {
    name: 'kb_llm_call_latency_ms',
    type: 'histogram',
    help: 'Chat-completion call latency in milliseconds by bounded operation.',
    labels: ['le', 'operation'],
    emittedWhen: 'Emitted after chat-completion calls are observed.',
  },
  {
    name: 'kb_search_stage_duration_ms',
    type: 'histogram',
    help: 'Daemon-served search stage latency in milliseconds.',
    labels: ['le', 'mode', 'stage', 'status'],
    emittedWhen: 'Emitted after daemon-served search stage timings are observed.',
  },
  {
    name: 'kb_rerank_latency_ms',
    type: 'histogram',
    help: 'Reranker-stage latency in milliseconds, split by bounded scoring source.',
    labels: ['le', 'source'],
    emittedWhen: 'Emitted when reranker latency telemetry is available.',
  },
  {
    name: 'kb_write_lock_wait_duration_ms',
    type: 'histogram',
    help: 'Write-lock acquisition wait time in milliseconds, split by bounded resource kind.',
    labels: ['le', 'resource_kind'],
    emittedWhen: 'Emitted after write-lock wait telemetry is observed.',
  },
  {
    name: 'kb_write_lock_hold_duration_ms',
    type: 'histogram',
    help: 'Write-lock function hold time in milliseconds, split by bounded resource kind.',
    labels: ['le', 'resource_kind'],
    emittedWhen: 'Emitted after write-lock hold telemetry is observed.',
  },
  {
    name: 'kb_daemon_inflight',
    type: 'gauge',
    help: 'Admitted-but-incomplete kb serve daemon requests (running + queued).',
    labels: [],
    emittedWhen: 'Emitted only by local kb serve metrics export.',
  },
  {
    name: 'kb_daemon_rejected_total',
    type: 'counter',
    help: 'Total kb serve daemon requests rejected by admission control.',
    labels: [],
    emittedWhen: 'Emitted only by local kb serve metrics export.',
  },
];

const OPEN_METRICS_REFERENCE_BY_NAME = new Map(
  OPEN_METRICS_REFERENCE.map((metric) => [metric.name, metric]),
);

export function openMetricsReference(name: string): OpenMetricsMetricReference {
  const metric = OPEN_METRICS_REFERENCE_BY_NAME.get(name);
  if (metric === undefined) throw new Error(`Unknown OpenMetrics metric reference: ${name}`);
  return metric;
}

export function openMetricsFamilyName(name: string): string {
  const metric = openMetricsReference(name);
  if (metric.type !== 'counter') return metric.name;
  return metric.name.endsWith('_total') ? metric.name.slice(0, -'_total'.length) : metric.name;
}

function defineMetric(name: string, samples: MetricSample[]): MetricDefinition {
  const reference = openMetricsReference(name);
  if (reference.type === 'histogram') throw new Error(`Histogram metric ${name} cannot be rendered as a scalar metric`);
  return {
    name: reference.name,
    help: reference.help,
    type: reference.type,
    samples,
  };
}

export function formatKbStatsOpenMetrics(
  payload: KbStatsPayload,
  options: { kbSearchFailures?: KbSearchFailureSnapshot } = {},
): string {
  const kbSearchFailures = options.kbSearchFailures ?? kbSearchFailureMetrics.snapshot();
  const metrics: MetricDefinition[] = [
    defineMetric('kb_build_info', [{
        name: 'kb_build_info',
        labels: {
          version: payload.server.version,
          commit: payload.server.commit ?? 'unknown',
        },
        value: 1,
      }]),
    defineMetric('kb_knowledge_base_files', Object.entries(payload.knowledge_bases).map(([kb, row]) => ({
        name: 'kb_knowledge_base_files',
        labels: { kb },
        value: row.file_count,
      }))),
    defineMetric('kb_knowledge_base_chunks', Object.entries(payload.knowledge_bases).map(([kb, row]) => ({
        name: 'kb_knowledge_base_chunks',
        labels: { kb },
        value: row.chunk_count,
      }))),
    defineMetric('kb_knowledge_base_indexed_bytes', Object.entries(payload.knowledge_bases).map(([kb, row]) => ({
        name: 'kb_knowledge_base_indexed_bytes',
        labels: { kb },
        value: row.total_bytes_indexed,
      }))),
    defineMetric('kb_knowledge_base_quarantined_chunks', Object.entries(payload.quarantined).map(([kb, count]) => ({
        name: 'kb_knowledge_base_quarantined_chunks',
        labels: { kb },
        value: count,
      }))),
    defineMetric('kb_server_uptime_ms', [{ name: 'kb_server_uptime_ms', value: payload.server.uptime_ms }]),
    defineMetric('kb_index_embedding_dimensions', [{
        name: 'kb_index_embedding_dimensions',
        value: payload.embedding.dim ?? 0,
      }]),
    defineMetric('kb_provider_calls_total', Object.entries(payload.provider_calls).map(([modelId, snapshot]) => ({
        name: 'kb_provider_calls_total',
        labels: { model_id: modelId },
        value: snapshot.count,
      }))),
    defineMetric('kb_provider_call_errors_total', Object.entries(payload.provider_calls).map(([modelId, snapshot]) => ({
        name: 'kb_provider_call_errors_total',
        labels: { model_id: modelId },
        value: snapshot.errors,
      }))),
    defineMetric('kb_provider_tokens_in_total', Object.entries(payload.provider_calls)
        .filter(([, snapshot]) => snapshot.tokens_in !== null)
        .map(([modelId, snapshot]) => ({
          name: 'kb_provider_tokens_in_total',
          labels: { model_id: modelId },
          value: snapshot.tokens_in ?? 0,
        }))),
    ...providerLatencyMetrics(payload),
    ...llmCallCounterMetrics(payload.llm_calls),
    ...searchLatencyCounterMetrics(payload.search_latency),
    ...searchDegradedCounterMetrics(payload.search_latency),
    ...kbSearchFailureCounterMetrics(kbSearchFailures),
    ...rerankCounterMetrics(payload.rerank),
    defineMetric('kb_query_cache_hits_total', [{ name: 'kb_query_cache_hits_total', value: payload.query_cache.hits }]),
    defineMetric('kb_query_cache_misses_total', [{ name: 'kb_query_cache_misses_total', value: payload.query_cache.misses }]),
    defineMetric('kb_query_cache_bypasses_total', [{ name: 'kb_query_cache_bypasses_total', value: payload.query_cache.bypasses }]),
    defineMetric('kb_query_cache_disk_size_bytes', [{ name: 'kb_query_cache_disk_size_bytes', value: payload.query_cache.disk_size_bytes }]),
    defineMetric('kb_relevance_gate_queries_total', [{ name: 'kb_relevance_gate_queries_total', value: payload.relevance_gate.gated_queries }]),
    defineMetric('kb_relevance_gate_verdict_injected_total', [{
        name: 'kb_relevance_gate_verdict_injected_total',
        value: payload.relevance_gate.verdict_injected,
      }]),
    defineMetric('kb_relevance_gate_verdict_no_relevant_context_total', [{
        name: 'kb_relevance_gate_verdict_no_relevant_context_total',
        value: payload.relevance_gate.verdict_no_relevant_context,
      }]),
    defineMetric('kb_relevance_gate_verdict_empty_index_total', [{
        name: 'kb_relevance_gate_verdict_empty_index_total',
        value: payload.relevance_gate.verdict_empty_index,
      }]),
    ...providerCircuitMetrics(payload.provider_circuits),
    ...remoteTransportMetrics(payload),
  ];

  const lines: string[] = [];
  for (const metric of metrics) {
    if (metric.samples.length === 0) continue;
    const familyName = metricFamilyName(metric);
    lines.push(`# HELP ${familyName} ${metric.help}`);
    lines.push(`# TYPE ${familyName} ${metric.type}`);
    for (const sample of metric.samples) {
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
    }
  }
  lines.push(...searchLatencyHistogramLines(payload.search_latency));
  lines.push(...llmCallLatencyHistogramLines(payload.llm_calls));
  lines.push(...rerankLatencyHistogramLines(payload.rerank));
  lines.push(...writeLockHistogramLines(payload.write_locks));
  lines.push('# EOF');
  return `${lines.join('\n')}\n`;
}

function metricFamilyName(metric: MetricDefinition): string {
  return openMetricsFamilyName(metric.name);
}

function providerLatencyMetrics(payload: KbStatsPayload): MetricDefinition[] {
  const quantiles = [
    ['p50', 'p50'] as const,
    ['p95', 'p95'] as const,
    ['p99', 'p99'] as const,
  ];
  return quantiles.map(([suffix, field]) => defineMetric(`kb_provider_call_latency_${suffix}_ms`, Object.entries(payload.provider_calls).map(([modelId, snapshot]) => ({
      name: `kb_provider_call_latency_${suffix}_ms`,
      labels: { model_id: modelId },
      value: snapshot.latency_ms[field],
    }))));
}

function llmCallCounterMetrics(snapshot: LlmCallMetricsSnapshot | undefined): MetricDefinition[] {
  const callSamples: MetricSample[] = [];
  const errorSamples: MetricSample[] = [];
  const tokenSamples: MetricSample[] = [];
  for (const [operation, row] of Object.entries(snapshot ?? {})) {
    if (!isLlmCallOperation(operation) || row === undefined) continue;
    const labels = { operation };
    callSamples.push({ name: 'kb_llm_calls_total', labels, value: row.count });
    errorSamples.push({ name: 'kb_llm_call_errors_total', labels, value: row.errors });
    if (row.prompt_tokens !== null) {
      tokenSamples.push({
        name: 'kb_llm_tokens_total',
        labels: { ...labels, token_type: 'prompt' },
        value: row.prompt_tokens,
      });
    }
    if (row.completion_tokens !== null) {
      tokenSamples.push({
        name: 'kb_llm_tokens_total',
        labels: { ...labels, token_type: 'completion' },
        value: row.completion_tokens,
      });
    }
  }
  return [
    defineMetric('kb_llm_calls_total', callSamples),
    defineMetric('kb_llm_call_errors_total', errorSamples),
    defineMetric('kb_llm_tokens_total', tokenSamples),
  ];
}

function llmCallLatencyHistogramLines(snapshot: LlmCallMetricsSnapshot | undefined): string[] {
  const rows: HistogramRow[] = [];
  for (const [operation, row] of Object.entries(snapshot ?? {})) {
    if (!isLlmCallOperation(operation) || row === undefined) continue;
    rows.push({ labels: { operation }, histogram: row.latency_ms });
  }
  return renderHistogramFamily({ name: 'kb_llm_call_latency_ms', rows });
}

const PROVIDER_CIRCUIT_STATE_VALUE: Record<ProviderCircuitState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/**
 * Issue #747 — render the provider circuit-breaker snapshot as a bounded
 * `{kind, provider}` gauge plus an open-transition counter. Several breaker
 * keys can share a provider/kind (e.g. two embedding models on the same
 * provider); the state gauge reports the worst (highest-value) state and
 * the counter sums the open transitions, so the label set stays bounded
 * and the emitted signal is "how bad is this provider right now / how
 * often has it tripped". Returns no samples for an empty snapshot, so the
 * families are omitted on a process that has not exercised any breaker.
 */
function providerCircuitMetrics(
  snapshots: ProviderCircuitSnapshot[] | undefined,
): MetricDefinition[] {
  const stateByLabel = new Map<string, { labels: Record<string, string>; value: number }>();
  const openByLabel = new Map<string, { labels: Record<string, string>; value: number }>();
  for (const snapshot of snapshots ?? []) {
    const { kind, provider } = parseProviderCircuitKey(snapshot.key);
    const labelKey = `${kind} ${provider}`;
    const labels = { kind, provider };

    const stateValue = PROVIDER_CIRCUIT_STATE_VALUE[snapshot.state];
    const existingState = stateByLabel.get(labelKey);
    if (existingState === undefined || stateValue > existingState.value) {
      stateByLabel.set(labelKey, { labels, value: stateValue });
    }

    const existingOpen = openByLabel.get(labelKey);
    openByLabel.set(labelKey, {
      labels,
      value: (existingOpen?.value ?? 0) + snapshot.opened_total,
    });
  }

  return [
    defineMetric(
      'kb_provider_circuit_state',
      [...stateByLabel.values()].map(({ labels, value }) => ({
        name: 'kb_provider_circuit_state',
        labels,
        value,
      })),
    ),
    defineMetric(
      'kb_provider_circuit_open_total',
      [...openByLabel.values()].map(({ labels, value }) => ({
        name: 'kb_provider_circuit_open_total',
        labels,
        value,
      })),
    ),
  ];
}

function remoteTransportMetrics(payload: KbStatsPayload): MetricDefinition[] {
  const stats = payload.remote_transport;
  if (stats === undefined) return [];
  return [
    defineMetric('kb_remote_transport_requests_total', [{ name: 'kb_remote_transport_requests_total', value: stats.requests_total }]),
    defineMetric('kb_remote_transport_sessions_opened_total', [{
        name: 'kb_remote_transport_sessions_opened_total',
        value: stats.sessions_opened,
      }]),
    defineMetric('kb_remote_transport_sessions_closed_total', [{
        name: 'kb_remote_transport_sessions_closed_total',
        value: stats.sessions_closed,
      }]),
    defineMetric('kb_remote_transport_current_sessions', [{
        name: 'kb_remote_transport_current_sessions',
        value: stats.current_sessions,
      }]),
    defineMetric('kb_remote_transport_in_flight_requests', [{
        name: 'kb_remote_transport_in_flight_requests',
        value: stats.in_flight_requests,
      }]),
    defineMetric('kb_remote_transport_auth_failures_total', [{
        name: 'kb_remote_transport_auth_failures_total',
        value: stats.auth_failures,
      }]),
    defineMetric('kb_remote_transport_origin_denials_total', [{
        name: 'kb_remote_transport_origin_denials_total',
        value: stats.origin_denials,
      }]),
    ...Object.entries(stats.response_status_buckets).map(([bucket, count]) => defineMetric(`kb_remote_transport_responses_${bucket}_total`, [{
        name: `kb_remote_transport_responses_${bucket}_total`,
        value: count,
      }])),
  ];
}

function searchLatencyCounterMetrics(snapshot: SearchLatencyMetricsSnapshot): MetricDefinition[] {
  const samples: MetricSample[] = [];
  for (const [mode, byStatus] of Object.entries(snapshot.requests)) {
    for (const [status, histogram] of Object.entries(byStatus)) {
      if (histogram === undefined) continue;
      samples.push({
        name: 'kb_search_requests_total',
        labels: { mode, status },
        value: histogram.count,
      });
    }
  }
  return [defineMetric('kb_search_requests_total', samples)];
}

function searchDegradedCounterMetrics(snapshot: SearchLatencyMetricsSnapshot): MetricDefinition[] {
  const samples: MetricSample[] = [];
  for (const [mode, byReason] of Object.entries(snapshot.degraded)) {
    for (const [reason, count] of Object.entries(byReason ?? {})) {
      samples.push({
        name: 'kb_search_degraded_total',
        labels: { mode, reason },
        value: count,
      });
    }
  }
  return [defineMetric('kb_search_degraded_total', samples)];
}

function kbSearchFailureCounterMetrics(snapshot: KbSearchFailureSnapshot): MetricDefinition[] {
  const samples: MetricSample[] = Object.entries(snapshot.by_kb).map(([kb, count]) => ({
    name: 'kb_search_kb_failures_total',
    labels: { kb },
    value: count,
  }));
  return [defineMetric('kb_search_kb_failures_total', samples)];
}

function rerankCounterMetrics(snapshot: RerankMetricsSnapshot | undefined): MetricDefinition[] {
  if (snapshot === undefined) return [];
  const skippedSamples: MetricSample[] = [];
  for (const [reason, count] of Object.entries(snapshot.skipped)) {
    skippedSamples.push({
      name: 'kb_rerank_skipped_total',
      labels: { reason },
      value: count ?? 0,
    });
  }

  const candidateSamples: MetricSample[] = [];
  for (const [source, count] of Object.entries(snapshot.candidates)) {
    candidateSamples.push({
      name: 'kb_rerank_candidates_total',
      labels: { source },
      value: count ?? 0,
    });
  }

  return [
    defineMetric('kb_rerank_invocations_total', [{ name: 'kb_rerank_invocations_total', value: snapshot.invocations }]),
    defineMetric('kb_rerank_skipped_total', skippedSamples),
    defineMetric('kb_rerank_candidates_total', candidateSamples),
  ];
}

function searchLatencyHistogramLines(snapshot: SearchLatencyMetricsSnapshot): string[] {
  const lines: string[] = [];
  lines.push(...renderHistogramFamily({
    name: 'kb_search_request_duration_ms',
    rows: requestHistogramRows(snapshot),
  }));
  lines.push(...renderHistogramFamily({
    name: 'kb_search_stage_duration_ms',
    rows: stageHistogramRows(snapshot),
  }));
  return lines;
}

function rerankLatencyHistogramLines(snapshot: RerankMetricsSnapshot | undefined): string[] {
  if (snapshot === undefined) return [];
  const rows: HistogramRow[] = [];
  for (const [source, histogram] of Object.entries(snapshot.latency)) {
    if (histogram === undefined) continue;
    rows.push({ labels: { source }, histogram });
  }
  return renderHistogramFamily({
    name: 'kb_rerank_latency_ms',
    rows,
  });
}

function writeLockHistogramLines(snapshot: WriteLockMetricsSnapshot): string[] {
  return [
    ...renderHistogramFamily({
      name: 'kb_write_lock_wait_duration_ms',
      rows: writeLockHistogramRows(snapshot.wait),
    }),
    ...renderHistogramFamily({
      name: 'kb_write_lock_hold_duration_ms',
      rows: writeLockHistogramRows(snapshot.hold),
    }),
  ];
}

function writeLockHistogramRows(
  snapshots: WriteLockMetricsSnapshot['wait'],
): HistogramRow[] {
  const rows: HistogramRow[] = [];
  for (const [resourceKind, histogram] of Object.entries(snapshots)) {
    if (histogram === undefined) continue;
    rows.push({ labels: { resource_kind: resourceKind }, histogram });
  }
  return rows;
}

function requestHistogramRows(snapshot: SearchLatencyMetricsSnapshot): HistogramRow[] {
  const rows: HistogramRow[] = [];
  for (const [mode, byStatus] of Object.entries(snapshot.requests)) {
    for (const [status, histogram] of Object.entries(byStatus)) {
      if (histogram === undefined) continue;
      rows.push({
        labels: {
          mode: mode as SearchLatencyMode,
          status: status as SearchLatencyStatus,
        },
        histogram,
      });
    }
  }
  return rows;
}

function stageHistogramRows(snapshot: SearchLatencyMetricsSnapshot): HistogramRow[] {
  const rows: HistogramRow[] = [];
  for (const [mode, byStage] of Object.entries(snapshot.stages)) {
    for (const [stage, byStatus] of Object.entries(byStage)) {
      if (byStatus === undefined) continue;
      for (const [status, histogram] of Object.entries(byStatus)) {
        if (histogram === undefined) continue;
        rows.push({
          labels: {
            mode,
            stage,
            status,
          },
          histogram,
        });
      }
    }
  }
  return rows;
}

interface HistogramRow {
  labels: Record<string, string>;
  histogram: LatencyHistogramSnapshot;
}

function renderHistogramFamily(input: {
  name: string;
  rows: HistogramRow[];
}): string[] {
  if (input.rows.length === 0) return [];
  const reference = openMetricsReference(input.name);
  if (reference.type !== 'histogram') throw new Error(`Metric ${input.name} is not a histogram reference`);
  const lines: string[] = [
    `# HELP ${input.name} ${reference.help}`,
    `# TYPE ${input.name} histogram`,
  ];
  for (const row of input.rows) {
    let cumulative = 0;
    for (let index = 0; index < LATENCY_BUCKET_BOUNDS_MS.length; index += 1) {
      cumulative += row.histogram.buckets[index] ?? 0;
      lines.push(
        `${input.name}_bucket${formatLabels({ ...row.labels, le: String(LATENCY_BUCKET_BOUNDS_MS[index]) })} ${formatNumber(cumulative)}`,
      );
    }
    lines.push(
      `${input.name}_bucket${formatLabels({ ...row.labels, le: '+Inf' })} ${formatNumber(row.histogram.count)}`,
    );
    lines.push(`${input.name}_sum${formatLabels(row.labels)} ${formatNumber(row.histogram.sum_ms)}`);
    lines.push(`${input.name}_count${formatLabels(row.labels)} ${formatNumber(row.histogram.count)}`);
  }
  return lines;
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (labels === undefined || Object.keys(labels).length === 0) return '';
  const body = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');
  return `{${body}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return '0';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}
