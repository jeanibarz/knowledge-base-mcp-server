import { describe, expect, it } from '@jest/globals';
import type { KbStatsPayload } from './kb-stats.js';
import {
  bucketIndexForLatency,
  LATENCY_BUCKET_BOUNDS_MS,
} from './metrics.js';
import { formatKbStatsOpenMetrics } from './prometheus-export.js';

describe('formatKbStatsOpenMetrics', () => {
  it('renders bounded-label OpenMetrics text from kb stats payloads', () => {
    const payload = samplePayload();
    const text = formatKbStatsOpenMetrics(payload);

    expect(text).toContain('# TYPE kb_knowledge_base_chunks gauge');
    expect(text).toContain('# TYPE kb_provider_calls counter');
    expect(text).not.toContain('# TYPE kb_provider_calls_total counter');
    expect(text).toContain('kb_knowledge_base_chunks{kb="ops\\\\team\\"a\\nline"} 7');
    expect(text).toContain('kb_provider_calls_total{model_id="ollama__nomic-embed-text-latest"} 11');
    expect(text).not.toContain('kb_provider_tokens_in_total');
    expect(text).toContain('kb_provider_call_latency_p95_ms{model_id="ollama__nomic-embed-text-latest"} 123.4');
    expect(text).toContain('kb_search_requests_total{mode="dense",status="success"} 1');
    expect(text).toContain('# TYPE kb_search_request_duration_ms histogram');
    expect(text).toContain('kb_search_request_duration_ms_bucket{le="100",mode="dense",status="success"} 1');
    expect(text).toContain('kb_search_request_duration_ms_bucket{le="+Inf",mode="dense",status="success"} 1');
    expect(text).toContain('kb_search_request_duration_ms_sum{mode="dense",status="success"} 80');
    expect(text).toContain('kb_search_request_duration_ms_count{mode="dense",status="success"} 1');
    expect(text).toContain('kb_search_degraded_total{mode="hybrid",reason="provider_timeout"} 2');
    expect(text).toContain('# TYPE kb_search_stage_duration_ms histogram');
    expect(text).toContain('kb_search_stage_duration_ms_bucket{le="30",mode="dense",stage="embed_query",status="success"} 1');
    expect(text).toContain('kb_search_stage_duration_ms_sum{mode="dense",stage="embed_query",status="success"} 12');
    expect(text).toContain('kb_remote_transport_requests_total 9');
    expect(text).toContain('# TYPE kb_remote_transport_responses_4xx counter');
    expect(text).toContain('kb_remote_transport_responses_4xx_total 2');
    expect(text.endsWith('# EOF\n')).toBe(true);
  });

  it('emits provider token counters only when the provider reports token usage', () => {
    const payload = samplePayload();
    payload.provider_calls['ollama__nomic-embed-text-latest'].tokens_in = 42;

    const text = formatKbStatsOpenMetrics(payload);

    expect(text).toContain('# TYPE kb_provider_tokens_in counter');
    expect(text).toContain('kb_provider_tokens_in_total{model_id="ollama__nomic-embed-text-latest"} 42');
  });
});

function samplePayload(): KbStatsPayload {
  return {
    knowledge_bases: {
      'ops\\team"a\nline': {
        file_count: 3,
        chunk_count: 7,
        total_bytes_indexed: 2048,
        last_updated_at: '2026-05-21T00:00:00.000Z',
      },
    },
    quarantined: {
      'ops\\team"a\nline': 1,
    },
    filesystem: {
      enumeration_failures: { failure_count: 0, failures: [] },
    },
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text:latest',
      dim: 768,
    },
    index_path: '/tmp/faiss',
    last_index_update: {
      status: 'success',
      scope: 'global',
      model_id: 'ollama__nomic-embed-text-latest',
      started_at: '2026-05-21T00:00:00.000Z',
      finished_at: '2026-05-21T00:00:01.000Z',
      duration_ms: 1000,
      files_scanned: 3,
      files_changed: 1,
      files_unchanged: 2,
      files_skipped: 0,
      chunks_attempted: 7,
      chunks_added: 7,
      index_mutated: true,
      saved: true,
      sidecars_written: true,
      warning_count: 0,
      warnings: [],
      failure_count: 0,
      failures: [],
    },
    server: {
      version: '0.0.0-test',
      uptime_ms: 42,
    },
    provider_calls: {
      'ollama__nomic-embed-text-latest': {
        count: 11,
        errors: 2,
        tokens_in: null,
        latency_ms: {
          p50: 12.3,
          p95: 123.4,
          p99: 300,
        },
        since_started_at: '2026-05-21T00:00:00.000Z',
      },
    },
    search_latency: {
      requests: {
        dense: {
          success: histogramSnapshot(80),
        },
      },
      stages: {
        dense: {
          embed_query: {
            success: histogramSnapshot(12),
          },
        },
      },
      degraded: {
        hybrid: {
          provider_timeout: 2,
        },
      },
    },
    query_cache: {
      hits: 5,
      misses: 6,
      hit_ratio: 5 / 11,
      l1_hits: 4,
      disk_hits: 1,
      bypasses: 0,
      writes: 6,
      corruptions: 0,
      l1_size: 4,
      disk_size_bytes: 1024,
    },
    relevance_gate: {
      gated_queries: 2,
      verdict_injected: 1,
      verdict_no_relevant_context: 1,
      verdict_empty_index: 0,
      low_confidence_rate: 0,
      drop_rate_A1: 0,
      drop_rate_A2: 0,
      drop_rate_B: 0,
      judge_degrade_rate: 0,
      judge_window: {
        size: 2,
        degraded: 0,
        rate: 0,
        warn_threshold: 0.1,
      },
    },
    remote_transport: {
      transport: 'http',
      sessions_opened: 2,
      sessions_closed: 1,
      current_sessions: 1,
      in_flight_requests: 0,
      requests_total: 9,
      response_status_buckets: {
        '1xx': 0,
        '2xx': 7,
        '3xx': 0,
        '4xx': 2,
        '5xx': 0,
      },
      auth_failures: 1,
      origin_denials: 1,
      last_error: null,
    },
  };
}

function histogramSnapshot(value: number) {
  const buckets = new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0);
  buckets[bucketIndexForLatency(value)] = 1;
  return {
    buckets,
    count: 1,
    sum_ms: value,
    since_started_at: '2026-05-21T00:00:00.000Z',
  };
}
