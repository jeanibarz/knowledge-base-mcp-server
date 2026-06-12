// metrics.ts — issue #210, runtime provider-call telemetry surfaced in
// `kb_stats` and `kb doctor`.
//
// Process-lifetime, in-memory only. No on-disk state, no network export.
// One record per `model_id` (the active model id from `model-id.ts`); the
// label set is intentionally fixed so cardinality stays bounded — we
// record one bucket update per `embedQuery`/`embedDocuments` call, never
// per-query labels. RFC 008 §6.8 capped `/health` at `{status:"ok"}`, so
// runtime histograms live on the existing `kb_stats` MCP tool surface.

import type { SearchLatencyStage } from './timing-core.js';

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

interface HistogramState {
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

export type SearchLatencyMode = 'dense' | 'lexical' | 'hybrid' | 'auto' | 'unknown';
export type SearchLatencyStatus = 'success' | 'error';

export interface SearchLatencyRecord {
  mode: SearchLatencyMode;
  status: SearchLatencyStatus;
  totalMs: number;
  stageDurationsMs?: Partial<Record<SearchLatencyStage, number>>;
}

export interface SearchLatencyMetricsSnapshot {
  requests: Partial<Record<SearchLatencyMode, Partial<Record<SearchLatencyStatus, LatencyHistogramSnapshot>>>>;
  stages: Partial<Record<
    SearchLatencyMode,
    Partial<Record<SearchLatencyStage, Partial<Record<SearchLatencyStatus, LatencyHistogramSnapshot>>>>
  >>;
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

function emptyHistogramState(now: number): HistogramState {
  return {
    buckets: new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
    count: 0,
    sumMs: 0,
    startedAtMs: now,
  };
}

function recordHistogramSample(state: HistogramState, latencyMs: number): void {
  const safe = !Number.isFinite(latencyMs) || latencyMs < 0 ? 0 : latencyMs;
  state.count += 1;
  state.sumMs += safe;
  state.buckets[bucketIndexForLatency(safe)] += 1;
}

function snapshotHistogram(state: HistogramState): LatencyHistogramSnapshot {
  return {
    buckets: [...state.buckets],
    count: state.count,
    sum_ms: roundLatency(state.sumMs),
    since_started_at: new Date(state.startedAtMs).toISOString(),
  };
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
    return Array.from(this.states.keys()).sort();
  }
}

/**
 * Process-lifetime search request latency registry for daemon-scrapeable
 * search paths. Labels are intentionally bounded to mode/status/stage:
 * no query text, KB name, path, request id, or error message is recorded.
 */
export class SearchLatencyMetrics {
  private readonly requestStates = new Map<string, HistogramState>();
  private readonly stageStates = new Map<string, HistogramState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  record(sample: SearchLatencyRecord): void {
    const requestState = this.getRequestState(sample.mode, sample.status);
    recordHistogramSample(requestState, sample.totalMs);

    for (const [stage, value] of Object.entries(sample.stageDurationsMs ?? {}) as Array<[SearchLatencyStage, number]>) {
      if (typeof value !== 'number') continue;
      const stageState = this.getStageState(sample.mode, stage, sample.status);
      recordHistogramSample(stageState, value);
    }
  }

  snapshot(): SearchLatencyMetricsSnapshot {
    const requests: SearchLatencyMetricsSnapshot['requests'] = {};
    for (const [key, state] of this.requestStates.entries()) {
      const [mode, status] = key.split('|') as [SearchLatencyMode, SearchLatencyStatus];
      requests[mode] ??= {};
      requests[mode]![status] = snapshotHistogram(state);
    }

    const stages: SearchLatencyMetricsSnapshot['stages'] = {};
    for (const [key, state] of this.stageStates.entries()) {
      const [mode, stage, status] = key.split('|') as [SearchLatencyMode, SearchLatencyStage, SearchLatencyStatus];
      stages[mode] ??= {};
      stages[mode]![stage] ??= {};
      stages[mode]![stage]![status] = snapshotHistogram(state);
    }

    return { requests, stages };
  }

  reset(): void {
    this.requestStates.clear();
    this.stageStates.clear();
  }

  private getRequestState(mode: SearchLatencyMode, status: SearchLatencyStatus): HistogramState {
    const key = `${mode}|${status}`;
    let state = this.requestStates.get(key);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      this.requestStates.set(key, state);
    }
    return state;
  }

  private getStageState(
    mode: SearchLatencyMode,
    stage: SearchLatencyStage,
    status: SearchLatencyStatus,
  ): HistogramState {
    const key = `${mode}|${stage}|${status}`;
    let state = this.stageStates.get(key);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      this.stageStates.set(key, state);
    }
    return state;
  }
}

/**
 * Round a latency to 3 significant decimal places. The histogram
 * resolution is bounded by bucket width, so reporting full
 * floating-point precision overstates accuracy; one decimal in
 * milliseconds is plenty for an operator-facing p95.
 */
function roundLatency(latencyMs: number): number {
  return Math.round(latencyMs * 10) / 10;
}

/**
 * Process-wide singleton. Tests that need isolation should construct a
 * fresh `ProviderCallMetrics` or call `reset()` between cases.
 */
export const providerCallMetrics = new ProviderCallMetrics();

export const searchLatencyMetrics = new SearchLatencyMetrics();

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
