import { describe, expect, it } from '@jest/globals';
import type { KbStatsPayload } from './kb-stats.js';
import {
  bucketIndexForLatency,
  LATENCY_BUCKET_BOUNDS_MS,
} from './metrics.js';
import {
  formatKbStatsOpenMetrics,
  OPEN_METRICS_REFERENCE,
  openMetricsFamilyName,
} from './prometheus-export.js';

describe('formatKbStatsOpenMetrics', () => {
  it('renders bounded-label OpenMetrics text from kb stats payloads', () => {
    const payload = samplePayload();
    const text = formatKbStatsOpenMetrics(payload);

    expect(text).toContain('# TYPE kb_build_info gauge');
    expect(text).toContain('kb_build_info{commit="abc123def456",version="0.0.0-test"} 1');
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
    expect(text).toContain('kb_answer_cache_hits_total 2');
    expect(text).toContain('kb_answer_cache_misses_total 3');
    expect(text).toContain('kb_answer_cache_outcomes_total{outcome="not_applicable"} 1');
    expect(text).toContain('kb_answer_cache_disk_size_bytes 2048');
    expect(text).toContain('# TYPE kb_search_stage_duration_ms histogram');
    expect(text).toContain('kb_search_stage_duration_ms_bucket{le="30",mode="dense",stage="embed_query",status="success"} 1');
    expect(text).toContain('kb_search_stage_duration_ms_sum{mode="dense",stage="embed_query",status="success"} 12');
    expect(text).toContain('# TYPE kb_rerank_invocations counter');
    expect(text).toContain('kb_rerank_invocations_total 3');
    expect(text).toContain('kb_rerank_skipped_total{reason="skip_domain"} 2');
    expect(text).toContain('kb_rerank_candidates_total{source="model_scored"} 4');
    expect(text).toContain('# TYPE kb_rerank_latency_ms histogram');
    expect(text).toContain('kb_rerank_latency_ms_bucket{le="30",source="model_scored"} 1');
    expect(text).toContain('kb_rerank_latency_ms_sum{source="model_scored"} 12');
    expect(text).toContain('# TYPE kb_write_lock_wait_duration_ms histogram');
    expect(text).toContain('kb_write_lock_wait_duration_ms_bucket{le="30",resource_kind="model_index"} 1');
    expect(text).toContain('kb_write_lock_wait_duration_ms_sum{resource_kind="model_index"} 12');
    expect(text).toContain('# TYPE kb_write_lock_hold_duration_ms histogram');
    expect(text).toContain('kb_write_lock_hold_duration_ms_bucket{le="100",resource_kind="model_index"} 1');
    expect(text).toContain('kb_write_lock_hold_duration_ms_sum{resource_kind="model_index"} 80');
    expect(text).toContain('kb_remote_transport_requests_total 9');
    expect(text).toContain('# TYPE kb_remote_transport_responses_4xx counter');
    expect(text).toContain('kb_remote_transport_responses_4xx_total 2');
    expect(text.endsWith('# EOF\n')).toBe(true);
  });

  it('renders bounded LLM operation counters, token counters, and latency histogram', () => {
    const payload = samplePayload();
    payload.llm_calls = {
      ask: {
        count: 3,
        errors: 1,
        attempts: 5,
        retries: 2,
        prompt_tokens: 42,
        completion_tokens: 9,
        cache_outcomes: { hit: 1, miss: 2 },
        answer_impact: { used: 2, unknown: 1 },
        attribution: [{
          provider: 'openrouter',
          model: 'deepseek',
          count: 3,
          errors: 1,
          attempts: 5,
          retries: 2,
          prompt_tokens: 42,
          completion_tokens: 9,
          latency_ms: histogramSnapshot(80),
        }],
        latency_ms: histogramSnapshot(80),
      },
      gate: {
        count: 1,
        errors: 0,
        prompt_tokens: null,
        completion_tokens: null,
        latency_ms: histogramSnapshot(12),
      },
    };

    const text = formatKbStatsOpenMetrics(payload);

    expect(text).toContain('# TYPE kb_llm_calls counter');
    expect(text).toContain('kb_llm_calls_total{operation="ask"} 3');
    expect(text).toContain('kb_llm_call_errors_total{operation="ask"} 1');
    expect(text).toContain('kb_llm_calls_total{operation="gate"} 1');
    expect(text).toContain('kb_llm_call_errors_total{operation="gate"} 0');
    expect(text).toContain('kb_llm_attempts_total{operation="ask"} 5');
    expect(text).toContain('kb_llm_retries_total{operation="ask"} 2');
    expect(text).toContain('kb_llm_cache_outcomes_total{operation="ask",outcome="hit"} 1');
    expect(text).toContain('kb_llm_answer_impact_total{impact="used",operation="ask"} 2');
    expect(text).toContain('kb_llm_tokens_total{operation="ask",token_type="completion"} 9');
    expect(text).toContain('kb_llm_tokens_total{operation="ask",token_type="prompt"} 42');
    expect(text).toContain('kb_llm_attributed_calls_total{model="deepseek",operation="ask",provider="openrouter"} 3');
    expect(text).toContain('kb_llm_attributed_attempts_total{model="deepseek",operation="ask",provider="openrouter"} 5');
    expect(text).toContain('kb_llm_attributed_tokens_total{model="deepseek",operation="ask",provider="openrouter",token_type="completion"} 9');
    expect(text).not.toContain('token_type="gate"');
    expect(text).toContain('# TYPE kb_llm_call_latency_ms histogram');
    expect(text).toContain('kb_llm_call_latency_ms_bucket{le="100",operation="ask"} 1');
    expect(text).toContain('kb_llm_call_latency_ms_bucket{le="30",operation="gate"} 1');
    expect(text).toContain('kb_llm_call_latency_ms_sum{operation="ask"} 80');
    expect(text).toContain('kb_llm_call_latency_ms_sum{operation="gate"} 12');
    expect(text).toContain('kb_llm_call_latency_ms_count{operation="ask"} 1');
    expect(text).toContain('# TYPE kb_llm_attributed_call_latency_ms histogram');
    expect(text).toContain('kb_llm_attributed_call_latency_ms_bucket{le="100",model="deepseek",operation="ask",provider="openrouter"} 1');
  });

  it('emits provider token counters only when the provider reports token usage', () => {
    const payload = samplePayload();
    payload.provider_calls['ollama__nomic-embed-text-latest'].tokens_in = 42;

    const text = formatKbStatsOpenMetrics(payload);

    expect(text).toContain('# TYPE kb_provider_tokens_in counter');
    expect(text).toContain('kb_provider_tokens_in_total{model_id="ollama__nomic-embed-text-latest"} 42');
    expect(text).toContain('kb_query_cache_outcomes_total{outcome="hit"} 5');
  });

  it('renders provider circuit-breaker state and open-transition counters (issue #747)', () => {
    const payload = samplePayload();
    payload.provider_circuits = [
      // Two embedding/ollama keys: worst state (open=2) wins, opens summed (1+3=4).
      {
        key: 'embedding:ollama:http://localhost:11434:nomic',
        state: 'open',
        consecutive_failures: 3,
        opened_at_ms: 1000,
        half_open_probe_in_flight: false,
        opened_total: 1,
        retry_after_ms: 5000,
      },
      {
        key: 'embedding:ollama:http://localhost:11434:mxbai',
        state: 'closed',
        consecutive_failures: 0,
        opened_at_ms: null,
        half_open_probe_in_flight: false,
        opened_total: 3,
        retry_after_ms: 0,
      },
      {
        key: 'llm:openrouter:https://openrouter.ai/api/v1/chat/completions:qwen',
        state: 'half-open',
        consecutive_failures: 1,
        opened_at_ms: 2000,
        half_open_probe_in_flight: true,
        opened_total: 2,
        retry_after_ms: 0,
      },
    ];

    const text = formatKbStatsOpenMetrics(payload);

    expect(text).toContain('# TYPE kb_provider_circuit_state gauge');
    expect(text).toContain('kb_provider_circuit_state{kind="embedding",provider="ollama"} 2');
    expect(text).toContain('kb_provider_circuit_state{kind="llm",provider="openrouter"} 1');
    expect(text).toContain('# TYPE kb_provider_circuit_open counter');
    expect(text).toContain('kb_provider_circuit_open_total{kind="embedding",provider="ollama"} 4');
    expect(text).toContain('kb_provider_circuit_open_total{kind="llm",provider="openrouter"} 2');
  });

  it('omits provider circuit-breaker families when no breaker has tracked a call (issue #747)', () => {
    const text = formatKbStatsOpenMetrics(samplePayload());
    expect(text).not.toContain('kb_provider_circuit_state');
    expect(text).not.toContain('kb_provider_circuit_open');
  });

  it('keeps emitted metric families represented in the generated-reference catalog', () => {
    const names = OPEN_METRICS_REFERENCE.map((metric) => metric.name);
    expect(new Set(names).size).toBe(names.length);

    const catalogFamilies = new Set(names.map((name) => openMetricsFamilyName(name)));
    const emittedFamilies = [...formatKbStatsOpenMetrics(samplePayload()).matchAll(/^# HELP ([^ ]+) /gm)]
      .map((match) => match[1]);

    expect(emittedFamilies.length).toBeGreaterThan(0);
    for (const family of emittedFamilies) {
      expect(catalogFamilies).toContain(family);
    }
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
      commit: 'abc123def456',
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
    answer_cache: {
      hits: 2,
      misses: 3,
      writes: 3,
      corruptions: 0,
      disk_size_bytes: 2048,
      outcomes: { hit: 2, miss: 3, not_applicable: 1 },
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
    rerank: {
      invocations: 3,
      skipped: {
        skip_domain: 2,
        disabled: 1,
      },
      candidates: {
        cache_hit: 5,
        model_scored: 4,
      },
      latency: {
        model_scored: histogramSnapshot(12),
      },
    },
    write_locks: {
      wait: {
        model_index: histogramSnapshot(12),
      },
      hold: {
        model_index: histogramSnapshot(80),
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
