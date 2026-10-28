// metrics-recording.ts — issue #210/#1007, runtime provider-call telemetry
// surfaced in `kb_stats` and `kb doctor`.
//
// Process-lifetime, in-memory only. No on-disk state, no network export.
// One record per `model_id` (the active model id from `model-id.ts`); the
// label set is intentionally fixed so cardinality stays bounded — we
// record one bucket update per `embedQuery`/`embedDocuments` call, never
// per-query labels. RFC 008 §6.8 capped `/health` at `{status:"ok"}`, so
// runtime histograms live on the existing `kb_stats` MCP tool surface.
//
// Issue #1007 split metrics.ts by subsystem. This module holds the
// recording primitives (histogram math, the metric classes, their
// process-wide singletons, and the embeddings instrumentation helper) that
// do NOT depend on `search-core.ts`. That independence is load-bearing: it
// is what lets `canonical-log.ts` import `WriteLockResourceKind` from here
// without recreating the `metrics.ts > search-core.ts > active-model.ts >
// ... > canonical-log.ts > metrics.ts` cycle that existed before the split.
// Search-latency recording (which genuinely needs `DenseDegradationReason`
// from `search-core.ts`) lives in `search-latency-metrics.ts` instead — see
// that file's header.

import type { DenseDegradationReason } from './search-types.js';
import type { WriteLockResourceKind } from './metrics-types.js';
import {
  isLlmAnswerImpact,
  isLlmCacheOutcome,
  isLlmCallOperation,
  normalizeLlmModel,
  normalizeLlmProvider,
  type LlmAnswerImpact,
  type LlmCacheOutcome,
  type LlmCallOperation,
  type LlmModel,
  type LlmProvider,
} from './llm-taxonomy.js';

export type { WriteLockResourceKind } from './metrics-types.js';

/**
 * Fixed log-spaced latency bucket upper bounds, in milliseconds. 10 bucket
 * cap (issue #210 spec) — one per decade-ish step from sub-millisecond
 * local FAISS calls to long remote provider tails. Anything above the
 * last bound is counted in the overflow bucket so a 60 s outlier does not
 * silently fall out of the histogram.
 */
export const LATENCY_BUCKET_BOUNDS_MS: readonly number[] = [
  1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000,
];

/**
 * One record per active `model_id`. Lifetime = process; no rolling window
 * today (the issue's "rolling histogram" framing maps to "since process
 * start" — bounded by the absence of per-query labels rather than by
 * time-decay). `tokens_in` is null until at least one call records a
 * non-null token count: HuggingFace and OpenAI report token usage on
 * embed responses, Ollama does not, so the field stays null when no
 * provider in the mix supports it.
 */
export interface ProviderCallSnapshot {
  count: number;
  errors: number;
  tokens_in: number | null;
  latency_ms: { p50: number; p95: number; p99: number };
  since_started_at: string;
}

export interface LlmCallAttributionSnapshot {
  provider: LlmProvider;
  model: LlmModel;
  count: number;
  errors: number;
  attempts: number;
  retries: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: LatencyHistogramSnapshot;
}

export interface LlmCallSnapshot {
  count: number;
  errors: number;
  /** Logical calls and provider-level attempts are deliberately separate. */
  attempts?: number;
  retries?: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: LatencyHistogramSnapshot;
  /** Counts recorded by workflow boundaries, not inferred by the client. */
  cache_outcomes?: Partial<Record<LlmCacheOutcome, number>>;
  answer_impact?: Partial<Record<LlmAnswerImpact, number>>;
  /** One bounded row per operation/provider/coarse-model combination. */
  attribution?: LlmCallAttributionSnapshot[];
}

export type LlmCallMetricsSnapshot = Partial<Record<LlmCallOperation, LlmCallSnapshot>>;

interface MetricsState {
  /**
   * Bucket counts; length = LATENCY_BUCKET_BOUNDS_MS.length + 1. The
   * extra slot is the overflow bucket for samples > the largest bound.
   */
  buckets: number[];
  count: number;
  errors: number;
  tokensInSum: number;
  /**
   * Whether any recorded call carried a token count. When false, the
   * snapshot surfaces `tokens_in: null` — an operator can tell apart
   * "provider does not report tokens" from "provider reported zero".
   */
  tokensReported: boolean;
  startedAtMs: number;
}

/**
 * Shared histogram accumulator. Exported so `search-latency-metrics.ts`
 * (the one subsystem that still has to depend on `search-core.ts`, and
 * therefore cannot live in this module) can reuse the same bucket math
 * instead of duplicating it.
 */
export interface HistogramState {
  buckets: number[];
  count: number;
  sumMs: number;
  startedAtMs: number;
}

export interface LatencyHistogramSnapshot {
  buckets: number[];
  count: number;
  sum_ms: number;
  since_started_at: string;
}

export type RerankSkipReason = 'disabled' | 'skip_domain' | 'no_candidates';
export type RerankCandidateSource = 'cache_hit' | 'model_scored';

export interface RerankMetricsSnapshot {
  invocations: number;
  /**
   * Issue #1019 — count of invocations where the cross-encoder reranker threw
   * at runtime and the stage fell back to the fused order. Lets operators
   * alert on a silent search-quality regression that otherwise only
   * `warnOnce`'d on first occurrence.
   */
  degraded: number;
  skipped: Partial<Record<RerankSkipReason, number>>;
  candidates: Partial<Record<RerankCandidateSource, number>>;
  latency: Partial<Record<RerankCandidateSource, LatencyHistogramSnapshot>>;
}

export interface WriteLockMetricsSnapshot {
  wait: Partial<Record<WriteLockResourceKind, LatencyHistogramSnapshot>>;
  hold: Partial<Record<WriteLockResourceKind, LatencyHistogramSnapshot>>;
}

/**
 * Bounded response-status-class label shared with `transport-runtime-stats.ts`
 * (which re-exports this type for backward compatibility — see that file).
 * Defined here rather than there so this module never has to import from
 * `transport-runtime-stats.ts`: that former two-way type-only import was
 * itself a circular dependency (issue #1007 point 4).
 */
export type ResponseStatusBucket = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

/**
 * Issue #892 — per-request latency histogram for the remote HTTP/SSE
 * transport, keyed only by the bounded response status class (`1xx`..`5xx`).
 * The status-class label mirrors the existing
 * `kb_remote_transport_responses_${bucket}_total` counters, so the histogram
 * adds at most five time series and never carries request path, method,
 * origin, or session id — keeping cardinality bounded exactly like the other
 * transport telemetry.
 */
export interface RemoteTransportLatencyMetricsSnapshot {
  request_duration_ms: Partial<Record<ResponseStatusBucket, LatencyHistogramSnapshot>>;
}

function emptyState(now: number): MetricsState {
  return {
    buckets: new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
    count: 0,
    errors: 0,
    tokensInSum: 0,
    tokensReported: false,
    startedAtMs: now,
  };
}

export function emptyHistogramState(now: number): HistogramState {
  return {
    buckets: new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
    count: 0,
    sumMs: 0,
    startedAtMs: now,
  };
}

export function recordHistogramSample(state: HistogramState, latencyMs: number): void {
  const safe = !Number.isFinite(latencyMs) || latencyMs < 0 ? 0 : latencyMs;
  state.count += 1;
  state.sumMs += safe;
  state.buckets[bucketIndexForLatency(safe)] += 1;
}

export function snapshotHistogram(state: HistogramState): LatencyHistogramSnapshot {
  return {
    buckets: [...state.buckets],
    count: state.count,
    sum_ms: roundLatency(state.sumMs),
    since_started_at: new Date(state.startedAtMs).toISOString(),
  };
}

function emptyLlmState(now: number): LlmMetricsState {
  return {
    count: 0,
    errors: 0,
    attempts: 0,
    retries: 0,
    promptTokensSum: 0,
    promptTokensReported: false,
    completionTokensSum: 0,
    completionTokensReported: false,
    latency: emptyHistogramState(now),
    cacheOutcomes: new Map(),
    answerImpact: new Map(),
    attribution: new Map(),
  };
}

interface LlmMetricsState {
  count: number;
  errors: number;
  attempts: number;
  retries: number;
  promptTokensSum: number;
  promptTokensReported: boolean;
  completionTokensSum: number;
  completionTokensReported: boolean;
  latency: HistogramState;
  cacheOutcomes: Map<LlmCacheOutcome, number>;
  answerImpact: Map<LlmAnswerImpact, number>;
  attribution: Map<string, LlmAttributionState>;
}

interface LlmAttributionState {
  provider: LlmProvider;
  model: LlmModel;
  count: number;
  errors: number;
  attempts: number;
  retries: number;
  promptTokensSum: number;
  promptTokensReported: boolean;
  completionTokensSum: number;
  completionTokensReported: boolean;
  latency: HistogramState;
}

/**
 * Find the histogram bucket index for a given latency in ms. Returns
 * `LATENCY_BUCKET_BOUNDS_MS.length` for samples greater than the largest
 * bucket bound (overflow). Right-inclusive: a sample exactly equal to
 * `bounds[i]` lands in bucket `i`.
 */
export function bucketIndexForLatency(latencyMs: number): number {
  // Issue #210 — the histogram is the load-bearing structure for p50/p95
  // accuracy. NaN (broken `performance.now()` consumer) and negative
  // values (clock skew across `start = now()` and `now() - start` on a
  // suspended host) would otherwise corrupt the bucket counts. Coerce to
  // 0 so the call still increments `count` — losing one sample's
  // resolution is preferable to skipping the call entirely and letting
  // the `count` and the bucket sums diverge.
  const safe = !Number.isFinite(latencyMs) || latencyMs < 0 ? 0 : latencyMs;
  for (let index = 0; index < LATENCY_BUCKET_BOUNDS_MS.length; index += 1) {
    if (safe <= LATENCY_BUCKET_BOUNDS_MS[index]) return index;
  }
  return LATENCY_BUCKET_BOUNDS_MS.length;
}

/**
 * Linear-interpolate a quantile from the bucket counts. Within the bucket
 * containing the target rank we assume uniform distribution between the
 * bucket's lower and upper bounds — a standard cheap approximation that
 * is accurate to within one bucket width. Returns the last finite bucket
 * bound (30 s) when the target rank lands in the overflow bucket.
 */
export function quantileFromBuckets(
  buckets: readonly number[],
  count: number,
  quantile: number,
): number {
  if (count === 0) return 0;
  const target = quantile * count;
  let cumulative = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const next = cumulative + buckets[index];
    if (next >= target) {
      if (index === LATENCY_BUCKET_BOUNDS_MS.length) {
        // Overflow bucket — no upper bound; report the last finite one.
        return LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1];
      }
      const lower = index === 0 ? 0 : LATENCY_BUCKET_BOUNDS_MS[index - 1];
      const upper = LATENCY_BUCKET_BOUNDS_MS[index];
      const inBucket = buckets[index];
      if (inBucket === 0) return upper;
      const fraction = (target - cumulative) / inBucket;
      return lower + fraction * (upper - lower);
    }
    cumulative = next;
  }
  return LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1];
}

/**
 * Process-lifetime registry of per-model_id provider call telemetry.
 * Construct once via `providerCallMetrics`; tests can construct fresh
 * instances or call `reset()`.
 */
export class ProviderCallMetrics {
  private states = new Map<string, MetricsState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Record one provider call. `ok=false` increments the error counter
   * but still updates the latency histogram — operators want p95
   * including failures, since a slow timeout is itself a latency
   * regression worth surfacing.
   */
  record(
    modelId: string,
    sample: { latencyMs: number; ok: boolean; tokensIn?: number | null },
  ): void {
    let state = this.states.get(modelId);
    if (state === undefined) {
      state = emptyState(this.now());
      this.states.set(modelId, state);
    }
    state.count += 1;
    if (!sample.ok) state.errors += 1;
    state.buckets[bucketIndexForLatency(sample.latencyMs)] += 1;
    if (sample.tokensIn !== undefined && sample.tokensIn !== null) {
      state.tokensInSum += sample.tokensIn;
      state.tokensReported = true;
    }
  }

  /**
   * One-shot snapshot of every model_id seen since process start (or the
   * last `reset()`). Quantiles are computed from the current bucket
   * counts — cheap enough to call from the hot path of an MCP request.
   */
  snapshot(): Record<string, ProviderCallSnapshot> {
    const out: Record<string, ProviderCallSnapshot> = {};
    for (const [modelId, state] of this.states.entries()) {
      out[modelId] = {
        count: state.count,
        errors: state.errors,
        tokens_in: state.tokensReported ? state.tokensInSum : null,
        latency_ms: {
          p50: roundLatency(quantileFromBuckets(state.buckets, state.count, 0.5)),
          p95: roundLatency(quantileFromBuckets(state.buckets, state.count, 0.95)),
          p99: roundLatency(quantileFromBuckets(state.buckets, state.count, 0.99)),
        },
        since_started_at: new Date(state.startedAtMs).toISOString(),
      };
    }
    return out;
  }

  /**
   * Drop all recorded state. Intended for tests that need clean
   * isolation between cases. Production code never calls this — the
   * snapshot is process-lifetime by design.
   */
  reset(): void {
    this.states.clear();
  }

  /**
   * Read-only check used by tests and audit code that want to know
   * which model_ids have been observed without taking a full snapshot.
   */
  knownModelIds(): string[] {
    return Array.from(this.states.keys()).sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Process-lifetime registry of chat-completion telemetry by bounded
 * operation. One record represents one logical `callChatCompletion` call,
 * including any retries inside that call. Token usage is best-effort because
 * OpenAI-compatible providers may omit it, especially for streaming.
 */
export class LlmCallMetrics {
  private readonly states = new Map<LlmCallOperation, LlmMetricsState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  record(
    operation: LlmCallOperation,
    sample: {
      latencyMs: number;
      ok: boolean;
      promptTokens?: number | null;
      completionTokens?: number | null;
      /** Actual provider attempts; defaults to one for legacy callers. */
      attempts?: number;
      /** Provider kind and raw model are normalized to bounded values here. */
      provider?: string | null;
      model?: string | null;
    },
  ): void {
    if (!isLlmCallOperation(operation)) return;
    let state = this.states.get(operation);
    if (state === undefined) {
      state = emptyLlmState(this.now());
      this.states.set(operation, state);
    }
    const attempts = normalizeAttemptCount(sample.attempts);
    const retries = Math.max(0, attempts - 1);
    const provider = normalizeLlmProvider(sample.provider);
    const model = normalizeLlmModel(sample.model, provider);
    state.count += 1;
    if (!sample.ok) state.errors += 1;
    state.attempts += attempts;
    state.retries += retries;
    recordHistogramSample(state.latency, sample.latencyMs);

    const promptTokens = normalizeTokenCount(sample.promptTokens);
    if (promptTokens !== null) {
      state.promptTokensSum += promptTokens;
      state.promptTokensReported = true;
    }
    const completionTokens = normalizeTokenCount(sample.completionTokens);
    if (completionTokens !== null) {
      state.completionTokensSum += completionTokens;
      state.completionTokensReported = true;
    }

    const attributionKey = `${provider}\u0000${model}`;
    let attribution = state.attribution.get(attributionKey);
    if (attribution === undefined) {
      attribution = {
        provider,
        model,
        count: 0,
        errors: 0,
        attempts: 0,
        retries: 0,
        promptTokensSum: 0,
        promptTokensReported: false,
        completionTokensSum: 0,
        completionTokensReported: false,
        latency: emptyHistogramState(this.now()),
      };
      state.attribution.set(attributionKey, attribution);
    }
    attribution.count += 1;
    if (!sample.ok) attribution.errors += 1;
    attribution.attempts += attempts;
    attribution.retries += retries;
    recordHistogramSample(attribution.latency, sample.latencyMs);
    if (promptTokens !== null) {
      attribution.promptTokensSum += promptTokens;
      attribution.promptTokensReported = true;
    }
    if (completionTokens !== null) {
      attribution.completionTokensSum += completionTokens;
      attribution.completionTokensReported = true;
    }
  }

  /** Record a cache decision at a workflow boundary without creating a call. */
  recordCacheOutcome(operation: LlmCallOperation, outcome: LlmCacheOutcome): void {
    if (!isLlmCallOperation(operation) || !isLlmCacheOutcome(outcome)) return;
    const state = this.getOrCreateState(operation);
    state.cacheOutcomes.set(outcome, (state.cacheOutcomes.get(outcome) ?? 0) + 1);
  }

  /** Record whether a workflow used an LLM result in its final answer path. */
  recordAnswerImpact(operation: LlmCallOperation, impact: LlmAnswerImpact): void {
    if (!isLlmCallOperation(operation) || !isLlmAnswerImpact(impact)) return;
    const state = this.getOrCreateState(operation);
    state.answerImpact.set(impact, (state.answerImpact.get(impact) ?? 0) + 1);
  }

  snapshot(): LlmCallMetricsSnapshot {
    const out: LlmCallMetricsSnapshot = {};
    for (const [operation, state] of this.states.entries()) {
      out[operation] = {
        count: state.count,
        errors: state.errors,
        attempts: state.attempts,
        retries: state.retries,
        prompt_tokens: state.promptTokensReported ? state.promptTokensSum : null,
        completion_tokens: state.completionTokensReported ? state.completionTokensSum : null,
        latency_ms: snapshotHistogram(state.latency),
        cache_outcomes: mapCounts(state.cacheOutcomes),
        answer_impact: mapCounts(state.answerImpact),
        attribution: [...state.attribution.values()]
          .sort((a, b) => `${a.provider}\u0000${a.model}`.localeCompare(`${b.provider}\u0000${b.model}`))
          .map((row) => ({
            provider: row.provider,
            model: row.model,
            count: row.count,
            errors: row.errors,
            attempts: row.attempts,
            retries: row.retries,
            prompt_tokens: row.promptTokensReported ? row.promptTokensSum : null,
            completion_tokens: row.completionTokensReported ? row.completionTokensSum : null,
            latency_ms: snapshotHistogram(row.latency),
          })),
      };
    }
    return out;
  }

  reset(): void {
    this.states.clear();
  }

  private getOrCreateState(operation: LlmCallOperation): LlmMetricsState {
    let state = this.states.get(operation);
    if (state === undefined) {
      state = emptyLlmState(this.now());
      this.states.set(operation, state);
    }
    return state;
  }
}

/**
 * Process-lifetime reranker-stage telemetry. Labels are intentionally bounded:
 * skip reason and candidate/latency source are fixed enums, never query text,
 * KB name, path, model id, or error message.
 */
export class RerankMetrics {
  private invocations = 0;
  private degraded = 0;
  private readonly skippedCounts = new Map<RerankSkipReason, number>();
  private readonly candidateCounts = new Map<RerankCandidateSource, number>();
  private readonly latencyStates = new Map<RerankCandidateSource, HistogramState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  recordSkipped(reason: RerankSkipReason): void {
    this.skippedCounts.set(reason, (this.skippedCounts.get(reason) ?? 0) + 1);
  }

  /**
   * Issue #1019 — record that a reranker invocation degraded to the fused
   * order because the cross-encoder threw at runtime. Called from the
   * reranker's catch/fallback path so the degradation is visible on `/metrics`
   * rather than only in a one-shot warning.
   */
  recordDegraded(): void {
    this.degraded += 1;
  }

  recordInvocation(sample: { latencyMs: number; candidatesIn: number; cacheHits: number }): void {
    this.invocations += 1;
    const cacheHits = clampCount(sample.cacheHits);
    const candidatesIn = clampCount(sample.candidatesIn);
    const modelScored = Math.max(0, candidatesIn - cacheHits);
    if (cacheHits > 0) {
      this.candidateCounts.set('cache_hit', (this.candidateCounts.get('cache_hit') ?? 0) + cacheHits);
    }
    if (modelScored > 0) {
      this.candidateCounts.set('model_scored', (this.candidateCounts.get('model_scored') ?? 0) + modelScored);
    }

    const latencySource: RerankCandidateSource = candidatesIn > 0 && modelScored === 0 ? 'cache_hit' : 'model_scored';
    let state = this.latencyStates.get(latencySource);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      this.latencyStates.set(latencySource, state);
    }
    recordHistogramSample(state, sample.latencyMs);
  }

  snapshot(): RerankMetricsSnapshot {
    const skipped: RerankMetricsSnapshot['skipped'] = {};
    for (const [reason, count] of this.skippedCounts.entries()) skipped[reason] = count;

    const candidates: RerankMetricsSnapshot['candidates'] = {};
    for (const [source, count] of this.candidateCounts.entries()) candidates[source] = count;

    const latency: RerankMetricsSnapshot['latency'] = {};
    for (const [source, state] of this.latencyStates.entries()) latency[source] = snapshotHistogram(state);

    return { invocations: this.invocations, degraded: this.degraded, skipped, candidates, latency };
  }

  reset(): void {
    this.invocations = 0;
    this.degraded = 0;
    this.skippedCounts.clear();
    this.candidateCounts.clear();
    this.latencyStates.clear();
  }
}

/**
 * Process-lifetime write-lock telemetry. Labels stay bounded to coarse
 * resource kinds so model directories and KB paths never enter metrics.
 */
export class WriteLockMetrics {
  private readonly waitStates = new Map<WriteLockResourceKind, HistogramState>();
  private readonly holdStates = new Map<WriteLockResourceKind, HistogramState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  record(sample: { resourceKind: WriteLockResourceKind; waitMs: number; holdMs: number }): void {
    recordHistogramSample(this.getState(this.waitStates, sample.resourceKind), sample.waitMs);
    recordHistogramSample(this.getState(this.holdStates, sample.resourceKind), sample.holdMs);
  }

  snapshot(): WriteLockMetricsSnapshot {
    return {
      wait: this.snapshotStates(this.waitStates),
      hold: this.snapshotStates(this.holdStates),
    };
  }

  reset(): void {
    this.waitStates.clear();
    this.holdStates.clear();
  }

  private getState(
    states: Map<WriteLockResourceKind, HistogramState>,
    resourceKind: WriteLockResourceKind,
  ): HistogramState {
    let state = states.get(resourceKind);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      states.set(resourceKind, state);
    }
    return state;
  }

  private snapshotStates(
    states: Map<WriteLockResourceKind, HistogramState>,
  ): Partial<Record<WriteLockResourceKind, LatencyHistogramSnapshot>> {
    const out: Partial<Record<WriteLockResourceKind, LatencyHistogramSnapshot>> = {};
    for (const [resourceKind, state] of states.entries()) {
      out[resourceKind] = snapshotHistogram(state);
    }
    return out;
  }
}

/**
 * Instance-lifetime latency histogram for the remote HTTP/SSE transport
 * (issue #892). One instance is owned by each `BaseHttpHost`, so recording
 * happens on the transport hot path and the snapshot rides the existing
 * `remote_transport` stats surface. Buckets are the shared
 * `LATENCY_BUCKET_BOUNDS_MS`; the only label is the bounded response status
 * class, so a serving process can expose p50/p95/p99 request latency without
 * any unbounded per-request label.
 */
export class RemoteTransportLatencyMetrics {
  private readonly states = new Map<ResponseStatusBucket, HistogramState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  record(statusBucket: ResponseStatusBucket, durationMs: number): void {
    let state = this.states.get(statusBucket);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      this.states.set(statusBucket, state);
    }
    recordHistogramSample(state, durationMs);
  }

  snapshot(): RemoteTransportLatencyMetricsSnapshot {
    const request_duration_ms: RemoteTransportLatencyMetricsSnapshot['request_duration_ms'] = {};
    for (const [statusBucket, state] of this.states.entries()) {
      request_duration_ms[statusBucket] = snapshotHistogram(state);
    }
    return { request_duration_ms };
  }

  reset(): void {
    this.states.clear();
  }
}

/**
 * Snapshot of per-KB fan-out failures observed during multi-KB search. The
 * label is the KB *name* (never an absolute path), so cardinality is bounded
 * by the number of configured knowledge bases.
 */
export interface KbSearchFailureSnapshot {
  /** Total failures across all KBs since process start (or the last reset). */
  total: number;
  /** Per-KB-name failure counts. Absent KBs have had zero failures. */
  by_kb: Record<string, number>;
}

/**
 * Process-lifetime registry of per-KB fan-out failures in the multi-KB
 * search leg (issue #737). Before this counter, a KB whose load/refresh/query
 * threw was counted in `runLexicalLeg`'s `failed` and then swallowed when no
 * `onError` was supplied — the user got partial results with no signal. Each
 * failure now increments this counter so `/metrics` surfaces the loss.
 *
 * Labels are the KB name only: no path, query text, or error message, keeping
 * cardinality bounded and avoiding leaking sensitive absolute paths.
 */
export class KbSearchFailureMetrics {
  private readonly counts = new Map<string, number>();

  record(kbName: string): void {
    this.counts.set(kbName, (this.counts.get(kbName) ?? 0) + 1);
  }

  snapshot(): KbSearchFailureSnapshot {
    let total = 0;
    const by_kb: Record<string, number> = {};
    for (const [kbName, count] of this.counts.entries()) {
      by_kb[kbName] = count;
      total += count;
    }
    return { total, by_kb };
  }

  reset(): void {
    this.counts.clear();
  }
}

function clampCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeTokenCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function normalizeAttemptCount(value: number | null | undefined): number {
  if (value === undefined || value === null) return 1;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function mapCounts<T extends string>(counts: Map<T, number>): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const [key, value] of counts.entries()) out[key] = value;
  return out;
}

/**
 * Round a latency to 3 significant decimal places. The histogram
 * resolution is bounded by bucket width, so reporting full
 * floating-point precision overstates accuracy; one decimal in
 * milliseconds is plenty for an operator-facing p95.
 */
export function roundLatency(latencyMs: number): number {
  return Math.round(latencyMs * 10) / 10;
}

/**
 * Process-wide singleton. Tests that need isolation should construct a
 * fresh `ProviderCallMetrics` or call `reset()` between cases.
 */
export const providerCallMetrics = new ProviderCallMetrics();

export const llmCallMetrics = new LlmCallMetrics();

export const rerankMetrics = new RerankMetrics();

export const kbSearchFailureMetrics = new KbSearchFailureMetrics();

export const writeLockMetrics = new WriteLockMetrics();

/**
 * Wrap a langchain-shaped embeddings client so every `embedQuery` /
 * `embedDocuments` call increments the registry under `modelId`.
 * Mutates the input — returning the same reference keeps the type
 * narrow and matches how `FaissIndexManager` already passes `this.embeddings`
 * straight to `FaissStore`. Idempotent: a second wrap on the same
 * client is a no-op so a re-`initialize()` does not double-count.
 */
export function instrumentEmbeddingsClient<
  T extends {
    embedQuery: (text: string) => Promise<number[]>;
    embedDocuments: (texts: string[]) => Promise<number[][]>;
  },
>(
  client: T,
  modelId: string,
  options: { metrics?: ProviderCallMetrics; now?: () => number } = {},
): T {
  const marker = '__kbProviderCallMetrics' as const;
  const tagged = client as T & { [marker]?: string };
  if (tagged[marker] !== undefined) return client;
  // Defensive: tests and bench harnesses sometimes hand a partial
  // langchain stub through the same factory path. Wrapping a client
  // that does not implement both methods would crash on `.bind()` and
  // mask the real test setup error, so skip silently — the wrap is
  // strictly observability and never load-bearing.
  if (typeof client.embedQuery !== 'function' || typeof client.embedDocuments !== 'function') {
    return client;
  }
  const metrics = options.metrics ?? providerCallMetrics;
  const now = options.now ?? performanceNow;

  const originalQuery = client.embedQuery.bind(client);
  const originalDocs = client.embedDocuments.bind(client);

  client.embedQuery = async (text: string): Promise<number[]> => {
    const start = now();
    try {
      const result = await originalQuery(text);
      metrics.record(modelId, { latencyMs: now() - start, ok: true });
      return result;
    } catch (err) {
      metrics.record(modelId, { latencyMs: now() - start, ok: false });
      throw err;
    }
  };

  client.embedDocuments = async (texts: string[]): Promise<number[][]> => {
    const start = now();
    try {
      const result = await originalDocs(texts);
      metrics.record(modelId, { latencyMs: now() - start, ok: true });
      return result;
    } catch (err) {
      metrics.record(modelId, { latencyMs: now() - start, ok: false });
      throw err;
    }
  };

  Object.defineProperty(tagged, marker, {
    value: modelId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return client;
}

function performanceNow(): number {
  // performance.now() is monotonic across the process lifetime; falling
  // back to Date.now() preserves correctness on any runtime where
  // performance is shimmed away (older bundlers, REPLs) at the cost of
  // wall-clock skew that the bucket assignment already absorbs.
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
