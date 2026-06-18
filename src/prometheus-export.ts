import type { KbStatsPayload } from './kb-stats.js';
import {
  LATENCY_BUCKET_BOUNDS_MS,
  type LatencyHistogramSnapshot,
  type RerankMetricsSnapshot,
  type SearchLatencyMetricsSnapshot,
  type SearchLatencyMode,
  type SearchLatencyStatus,
} from './metrics.js';

interface MetricSample {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

interface MetricDefinition {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  samples: MetricSample[];
}

export function formatKbStatsOpenMetrics(payload: KbStatsPayload): string {
  const metrics: MetricDefinition[] = [
    {
      name: 'kb_knowledge_base_files',
      help: 'Number of ingestable source files by knowledge base.',
      type: 'gauge',
      samples: Object.entries(payload.knowledge_bases).map(([kb, row]) => ({
        name: 'kb_knowledge_base_files',
        labels: { kb },
        value: row.file_count,
      })),
    },
    {
      name: 'kb_knowledge_base_chunks',
      help: 'Number of dense index chunks by knowledge base.',
      type: 'gauge',
      samples: Object.entries(payload.knowledge_bases).map(([kb, row]) => ({
        name: 'kb_knowledge_base_chunks',
        labels: { kb },
        value: row.chunk_count,
      })),
    },
    {
      name: 'kb_knowledge_base_indexed_bytes',
      help: 'Total bytes from ingestable files by knowledge base.',
      type: 'gauge',
      samples: Object.entries(payload.knowledge_bases).map(([kb, row]) => ({
        name: 'kb_knowledge_base_indexed_bytes',
        labels: { kb },
        value: row.total_bytes_indexed,
      })),
    },
    {
      name: 'kb_knowledge_base_quarantined_chunks',
      help: 'Number of quarantined chunks by knowledge base.',
      type: 'gauge',
      samples: Object.entries(payload.quarantined).map(([kb, count]) => ({
        name: 'kb_knowledge_base_quarantined_chunks',
        labels: { kb },
        value: count,
      })),
    },
    {
      name: 'kb_server_uptime_ms',
      help: 'Process uptime in milliseconds for the serving process.',
      type: 'gauge',
      samples: [{ name: 'kb_server_uptime_ms', value: payload.server.uptime_ms }],
    },
    {
      name: 'kb_index_embedding_dimensions',
      help: 'Embedding dimension of the active FAISS index, or 0 when unknown.',
      type: 'gauge',
      samples: [{
        name: 'kb_index_embedding_dimensions',
        value: payload.embedding.dim ?? 0,
      }],
    },
    {
      name: 'kb_provider_calls_total',
      help: 'Embedding provider calls by model id.',
      type: 'counter',
      samples: Object.entries(payload.provider_calls).map(([modelId, snapshot]) => ({
        name: 'kb_provider_calls_total',
        labels: { model_id: modelId },
        value: snapshot.count,
      })),
    },
    {
      name: 'kb_provider_call_errors_total',
      help: 'Embedding provider call errors by model id.',
      type: 'counter',
      samples: Object.entries(payload.provider_calls).map(([modelId, snapshot]) => ({
        name: 'kb_provider_call_errors_total',
        labels: { model_id: modelId },
        value: snapshot.errors,
      })),
    },
    {
      name: 'kb_provider_tokens_in_total',
      help: 'Reported input tokens consumed by embedding provider calls.',
      type: 'counter',
      samples: Object.entries(payload.provider_calls)
        .filter(([, snapshot]) => snapshot.tokens_in !== null)
        .map(([modelId, snapshot]) => ({
          name: 'kb_provider_tokens_in_total',
          labels: { model_id: modelId },
          value: snapshot.tokens_in ?? 0,
        })),
    },
    ...providerLatencyMetrics(payload),
    ...searchLatencyCounterMetrics(payload.search_latency),
    ...searchDegradedCounterMetrics(payload.search_latency),
    ...rerankCounterMetrics(payload.rerank),
    {
      name: 'kb_query_cache_hits_total',
      help: 'Query embedding cache hits.',
      type: 'counter',
      samples: [{ name: 'kb_query_cache_hits_total', value: payload.query_cache.hits }],
    },
    {
      name: 'kb_query_cache_misses_total',
      help: 'Query embedding cache misses.',
      type: 'counter',
      samples: [{ name: 'kb_query_cache_misses_total', value: payload.query_cache.misses }],
    },
    {
      name: 'kb_query_cache_bypasses_total',
      help: 'Query embedding cache bypasses.',
      type: 'counter',
      samples: [{ name: 'kb_query_cache_bypasses_total', value: payload.query_cache.bypasses }],
    },
    {
      name: 'kb_query_cache_disk_size_bytes',
      help: 'Query embedding cache disk usage in bytes.',
      type: 'gauge',
      samples: [{ name: 'kb_query_cache_disk_size_bytes', value: payload.query_cache.disk_size_bytes }],
    },
    {
      name: 'kb_relevance_gate_queries_total',
      help: 'Relevance-gated retrieval queries.',
      type: 'counter',
      samples: [{ name: 'kb_relevance_gate_queries_total', value: payload.relevance_gate.gated_queries }],
    },
    {
      name: 'kb_relevance_gate_verdict_injected_total',
      help: 'Relevance gate injected-context verdict count.',
      type: 'counter',
      samples: [{
        name: 'kb_relevance_gate_verdict_injected_total',
        value: payload.relevance_gate.verdict_injected,
      }],
    },
    {
      name: 'kb_relevance_gate_verdict_no_relevant_context_total',
      help: 'Relevance gate no-relevant-context verdict count.',
      type: 'counter',
      samples: [{
        name: 'kb_relevance_gate_verdict_no_relevant_context_total',
        value: payload.relevance_gate.verdict_no_relevant_context,
      }],
    },
    {
      name: 'kb_relevance_gate_verdict_empty_index_total',
      help: 'Relevance gate empty-index verdict count.',
      type: 'counter',
      samples: [{
        name: 'kb_relevance_gate_verdict_empty_index_total',
        value: payload.relevance_gate.verdict_empty_index,
      }],
    },
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
  lines.push(...rerankLatencyHistogramLines(payload.rerank));
  lines.push('# EOF');
  return `${lines.join('\n')}\n`;
}

function metricFamilyName(metric: MetricDefinition): string {
  if (metric.type !== 'counter') return metric.name;
  return metric.name.endsWith('_total') ? metric.name.slice(0, -'_total'.length) : metric.name;
}

function providerLatencyMetrics(payload: KbStatsPayload): MetricDefinition[] {
  const quantiles = [
    ['p50', 'p50'] as const,
    ['p95', 'p95'] as const,
    ['p99', 'p99'] as const,
  ];
  return quantiles.map(([suffix, field]) => ({
    name: `kb_provider_call_latency_${suffix}_ms`,
    help: `Embedding provider call latency ${suffix} by model id, in milliseconds.`,
    type: 'gauge' as const,
    samples: Object.entries(payload.provider_calls).map(([modelId, snapshot]) => ({
      name: `kb_provider_call_latency_${suffix}_ms`,
      labels: { model_id: modelId },
      value: snapshot.latency_ms[field],
    })),
  }));
}

function remoteTransportMetrics(payload: KbStatsPayload): MetricDefinition[] {
  const stats = payload.remote_transport;
  if (stats === undefined) return [];
  return [
    {
      name: 'kb_remote_transport_requests_total',
      help: 'Remote HTTP/SSE transport requests.',
      type: 'counter',
      samples: [{ name: 'kb_remote_transport_requests_total', value: stats.requests_total }],
    },
    {
      name: 'kb_remote_transport_sessions_opened_total',
      help: 'Remote HTTP/SSE transport sessions opened.',
      type: 'counter',
      samples: [{
        name: 'kb_remote_transport_sessions_opened_total',
        value: stats.sessions_opened,
      }],
    },
    {
      name: 'kb_remote_transport_sessions_closed_total',
      help: 'Remote HTTP/SSE transport sessions closed.',
      type: 'counter',
      samples: [{
        name: 'kb_remote_transport_sessions_closed_total',
        value: stats.sessions_closed,
      }],
    },
    {
      name: 'kb_remote_transport_current_sessions',
      help: 'Current remote HTTP/SSE transport sessions.',
      type: 'gauge',
      samples: [{
        name: 'kb_remote_transport_current_sessions',
        value: stats.current_sessions,
      }],
    },
    {
      name: 'kb_remote_transport_in_flight_requests',
      help: 'Current in-flight remote HTTP/SSE transport requests.',
      type: 'gauge',
      samples: [{
        name: 'kb_remote_transport_in_flight_requests',
        value: stats.in_flight_requests,
      }],
    },
    {
      name: 'kb_remote_transport_auth_failures_total',
      help: 'Remote HTTP/SSE transport authentication failures.',
      type: 'counter',
      samples: [{
        name: 'kb_remote_transport_auth_failures_total',
        value: stats.auth_failures,
      }],
    },
    {
      name: 'kb_remote_transport_origin_denials_total',
      help: 'Remote HTTP/SSE transport CORS origin denials.',
      type: 'counter',
      samples: [{
        name: 'kb_remote_transport_origin_denials_total',
        value: stats.origin_denials,
      }],
    },
    ...Object.entries(stats.response_status_buckets).map(([bucket, count]) => ({
      name: `kb_remote_transport_responses_${bucket}_total`,
      help: `Remote HTTP/SSE transport ${bucket} responses.`,
      type: 'counter' as const,
      samples: [{
        name: `kb_remote_transport_responses_${bucket}_total`,
        value: count,
      }],
    })),
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
  return [{
    name: 'kb_search_requests_total',
    help: 'Daemon-served search requests by effective mode and status.',
    type: 'counter',
    samples,
  }];
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
  return [{
    name: 'kb_search_degraded_total',
    help: 'Search requests degraded from dense-provider retrieval to lexical-only output by bounded reason.',
    type: 'counter',
    samples,
  }];
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
    {
      name: 'kb_rerank_invocations_total',
      help: 'Reranker-stage invocations.',
      type: 'counter',
      samples: [{ name: 'kb_rerank_invocations_total', value: snapshot.invocations }],
    },
    {
      name: 'kb_rerank_skipped_total',
      help: 'Reranker-stage skips by bounded reason.',
      type: 'counter',
      samples: skippedSamples,
    },
    {
      name: 'kb_rerank_candidates_total',
      help: 'Reranker-stage candidates by scoring source.',
      type: 'counter',
      samples: candidateSamples,
    },
  ];
}

function searchLatencyHistogramLines(snapshot: SearchLatencyMetricsSnapshot): string[] {
  const lines: string[] = [];
  lines.push(...renderHistogramFamily({
    name: 'kb_search_request_duration_ms',
    help: 'End-to-end daemon-served search request latency in milliseconds.',
    rows: requestHistogramRows(snapshot),
  }));
  lines.push(...renderHistogramFamily({
    name: 'kb_search_stage_duration_ms',
    help: 'Daemon-served search stage latency in milliseconds.',
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
    help: 'Reranker-stage latency in milliseconds, split by bounded scoring source.',
    rows,
  });
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
  help: string;
  rows: HistogramRow[];
}): string[] {
  if (input.rows.length === 0) return [];
  const lines: string[] = [
    `# HELP ${input.name} ${input.help}`,
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
