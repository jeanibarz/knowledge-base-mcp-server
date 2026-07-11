import { describe, expect, it } from '@jest/globals';
import {
  bucketIndexForLatency,
  instrumentEmbeddingsClient,
  KbSearchFailureMetrics,
  LATENCY_BUCKET_BOUNDS_MS,
  ProviderCallMetrics,
  quantileFromBuckets,
  RerankMetrics,
  SearchLatencyMetrics,
  WriteLockMetrics,
} from './metrics.js';

describe('bucketIndexForLatency (issue #210 — fixed-bucket histogram)', () => {
  it('lands a sub-1ms sample in bucket 0 and a 30s sample in the last finite bucket', () => {
    expect(bucketIndexForLatency(0)).toBe(0);
    expect(bucketIndexForLatency(0.5)).toBe(0);
    expect(bucketIndexForLatency(LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1])).toBe(
      LATENCY_BUCKET_BOUNDS_MS.length - 1,
    );
  });

  it('is right-inclusive at every bucket boundary', () => {
    for (let index = 0; index < LATENCY_BUCKET_BOUNDS_MS.length; index += 1) {
      expect(bucketIndexForLatency(LATENCY_BUCKET_BOUNDS_MS[index])).toBe(index);
    }
  });

  it('routes overflow latencies (> last bound) to the overflow bucket', () => {
    const overflow = LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1] + 1;
    expect(bucketIndexForLatency(overflow)).toBe(LATENCY_BUCKET_BOUNDS_MS.length);
    expect(bucketIndexForLatency(120_000)).toBe(LATENCY_BUCKET_BOUNDS_MS.length);
  });

  it('coerces NaN and negative latencies to bucket 0 instead of corrupting counts', () => {
    expect(bucketIndexForLatency(Number.NaN)).toBe(0);
    expect(bucketIndexForLatency(-5)).toBe(0);
    expect(bucketIndexForLatency(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('is monotonic non-decreasing in the input latency', () => {
    let previous = -1;
    for (const value of [0, 0.5, 1, 2, 5, 10, 50, 100, 500, 1000, 5000, 30_000, 60_000]) {
      const index = bucketIndexForLatency(value);
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });
});

describe('quantileFromBuckets', () => {
  it('returns 0 when the histogram has no observations', () => {
    const buckets = new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0);
    expect(quantileFromBuckets(buckets, 0, 0.5)).toBe(0);
    expect(quantileFromBuckets(buckets, 0, 0.95)).toBe(0);
  });

  it('p50 lies between the bucket bounds containing the median sample', () => {
    // 100 samples at exactly 5 ms — bucket index is the one whose upper
    // bound is the smallest >= 5 (i.e. 10 ms). Lower bound for that
    // bucket is the previous boundary (3 ms).
    const targetBucket = bucketIndexForLatency(5);
    const buckets = new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0);
    buckets[targetBucket] = 100;
    const p50 = quantileFromBuckets(buckets, 100, 0.5);
    const lower = targetBucket === 0 ? 0 : LATENCY_BUCKET_BOUNDS_MS[targetBucket - 1];
    const upper = LATENCY_BUCKET_BOUNDS_MS[targetBucket];
    expect(p50).toBeGreaterThanOrEqual(lower);
    expect(p50).toBeLessThanOrEqual(upper);
  });

  it('overflow samples are reported as the largest finite bucket bound', () => {
    const buckets = new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0);
    buckets[LATENCY_BUCKET_BOUNDS_MS.length] = 5; // overflow only
    expect(quantileFromBuckets(buckets, 5, 0.95)).toBe(
      LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1],
    );
  });

  it('quantiles are monotonic non-decreasing as q increases', () => {
    const samples = [0.5, 5, 50, 200, 800, 1500, 4000, 9000, 25_000];
    const buckets = new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0);
    for (const value of samples) buckets[bucketIndexForLatency(value)] += 1;
    const p50 = quantileFromBuckets(buckets, samples.length, 0.5);
    const p95 = quantileFromBuckets(buckets, samples.length, 0.95);
    const p99 = quantileFromBuckets(buckets, samples.length, 0.99);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);
  });
});

describe('ProviderCallMetrics', () => {
  it('starts empty and yields {} from snapshot', () => {
    const metrics = new ProviderCallMetrics({ now: () => 1_700_000_000_000 });
    expect(metrics.snapshot()).toEqual({});
    expect(metrics.knownModelIds()).toEqual([]);
  });

  it('counts successes and errors per model_id and surfaces since_started_at', () => {
    const startMs = 1_700_000_000_000;
    let clock = startMs;
    const metrics = new ProviderCallMetrics({ now: () => clock });
    metrics.record('huggingface__a', { latencyMs: 5, ok: true });
    metrics.record('huggingface__a', { latencyMs: 50, ok: false });
    metrics.record('ollama__b', { latencyMs: 200, ok: true });
    clock = startMs + 1000; // later record under existing model — startedAt frozen.
    metrics.record('huggingface__a', { latencyMs: 800, ok: true });

    const snap = metrics.snapshot();
    expect(snap['huggingface__a'].count).toBe(3);
    expect(snap['huggingface__a'].errors).toBe(1);
    expect(snap['huggingface__a'].since_started_at).toBe(new Date(startMs).toISOString());
    expect(snap['ollama__b'].count).toBe(1);
    expect(snap['ollama__b'].errors).toBe(0);
    expect(metrics.knownModelIds()).toEqual(['huggingface__a', 'ollama__b']);
  });

  it('keeps tokens_in null until at least one call carries a token count', () => {
    const metrics = new ProviderCallMetrics({ now: () => 1 });
    metrics.record('m', { latencyMs: 1, ok: true });
    metrics.record('m', { latencyMs: 2, ok: true, tokensIn: null });
    expect(metrics.snapshot().m.tokens_in).toBeNull();
    metrics.record('m', { latencyMs: 3, ok: true, tokensIn: 17 });
    metrics.record('m', { latencyMs: 4, ok: true, tokensIn: 5 });
    expect(metrics.snapshot().m.tokens_in).toBe(22);
  });

  it('p50/p95 are stable across a synthetic workload (idempotent over equal inputs)', () => {
    const metrics = new ProviderCallMetrics({ now: () => 1 });
    const samples = [1, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000];
    for (const value of samples) metrics.record('m', { latencyMs: value, ok: true });
    const first = metrics.snapshot();
    const second = metrics.snapshot();
    expect(second).toEqual(first);
    expect(first.m.latency_ms.p95).toBeGreaterThanOrEqual(first.m.latency_ms.p50);
    expect(first.m.latency_ms.p99).toBeGreaterThanOrEqual(first.m.latency_ms.p95);
  });

  it('reset() clears all recorded state', () => {
    const metrics = new ProviderCallMetrics({ now: () => 1 });
    metrics.record('m', { latencyMs: 1, ok: true });
    expect(metrics.knownModelIds()).toEqual(['m']);
    metrics.reset();
    expect(metrics.snapshot()).toEqual({});
    expect(metrics.knownModelIds()).toEqual([]);
  });
});

describe('SearchLatencyMetrics', () => {
  it('records request and stage histograms by bounded mode/status/stage labels', () => {
    const metrics = new SearchLatencyMetrics({ now: () => 1_700_000_000_000 });
    metrics.record({
      mode: 'hybrid',
      status: 'success',
      totalMs: 125,
      stageDurationsMs: {
        embed_query: 12,
        faiss_search: 30,
        lexical_search: 40,
        fusion: 3,
      },
    });
    metrics.record({
      mode: 'hybrid',
      status: 'error',
      totalMs: 4,
    });

    const snap = metrics.snapshot();
    expect(snap.requests.hybrid?.success).toMatchObject({
      count: 1,
      sum_ms: 125,
      since_started_at: '2023-11-14T22:13:20.000Z',
    });
    expect(snap.requests.hybrid?.error).toMatchObject({ count: 1, sum_ms: 4 });
    expect(snap.stages.hybrid?.embed_query?.success).toMatchObject({ count: 1, sum_ms: 12 });
    expect(snap.stages.hybrid?.faiss_search?.success).toMatchObject({ count: 1, sum_ms: 30 });
    expect(snap.stages.hybrid?.lexical_search?.success).toMatchObject({ count: 1, sum_ms: 40 });
    expect(snap.stages.hybrid?.fusion?.success).toMatchObject({ count: 1, sum_ms: 3 });
    expect(snap.stages.hybrid?.fusion?.error).toBeUndefined();
    expect(snap.degraded).toEqual({});
  });

  it('records degraded search counters by bounded mode and reason labels', () => {
    const metrics = new SearchLatencyMetrics({ now: () => 1 });
    metrics.recordDegraded('dense', 'provider_timeout');
    metrics.recordDegraded('dense', 'provider_timeout');
    metrics.recordDegraded('hybrid', 'provider_unavailable');

    expect(metrics.snapshot().degraded).toEqual({
      dense: { provider_timeout: 2 },
      hybrid: { provider_unavailable: 1 },
    });
  });

  it('reset() clears search latency state', () => {
    const metrics = new SearchLatencyMetrics({ now: () => 1 });
    metrics.record({ mode: 'dense', status: 'success', totalMs: 1 });
    metrics.recordDegraded('dense', 'provider_timeout');
    expect(metrics.snapshot().requests.dense?.success?.count).toBe(1);
    metrics.reset();
    expect(metrics.snapshot()).toEqual({ requests: {}, stages: {}, degraded: {} });
  });
});

describe('RerankMetrics', () => {
  it('records skips, invocation counts, candidate sources, and latency source histograms', () => {
    const metrics = new RerankMetrics({ now: () => 1_700_000_000_000 });

    metrics.recordSkipped('disabled');
    metrics.recordSkipped('skip_domain');
    metrics.recordSkipped('skip_domain');
    metrics.recordInvocation({ latencyMs: 12, candidatesIn: 3, cacheHits: 1 });
    metrics.recordInvocation({ latencyMs: 2, candidatesIn: 2, cacheHits: 2 });

    const snap = metrics.snapshot();
    expect(snap.invocations).toBe(2);
    expect(snap.skipped).toEqual({ disabled: 1, skip_domain: 2 });
    expect(snap.candidates).toEqual({ cache_hit: 3, model_scored: 2 });
    expect(snap.latency.model_scored).toMatchObject({
      count: 1,
      sum_ms: 12,
      since_started_at: '2023-11-14T22:13:20.000Z',
    });
    expect(snap.latency.cache_hit).toMatchObject({ count: 1, sum_ms: 2 });
  });

  it('reset() clears rerank telemetry', () => {
    const metrics = new RerankMetrics();
    metrics.recordSkipped('no_candidates');
    metrics.recordInvocation({ latencyMs: 1, candidatesIn: 1, cacheHits: 0 });

    metrics.reset();

    expect(metrics.snapshot()).toEqual({
      invocations: 0,
      skipped: {},
      candidates: {},
      latency: {},
    });
  });
});

describe('WriteLockMetrics', () => {
  it('records wait and hold histograms by bounded resource kind', () => {
    const metrics = new WriteLockMetrics({ now: () => 1_700_000_000_000 });

    metrics.record({ resourceKind: 'model_index', waitMs: 12, holdMs: 80 });
    metrics.record({ resourceKind: 'active_index', waitMs: 2, holdMs: 5 });

    const snap = metrics.snapshot();
    expect(snap.wait.model_index).toMatchObject({
      count: 1,
      sum_ms: 12,
      since_started_at: '2023-11-14T22:13:20.000Z',
    });
    expect(snap.hold.model_index).toMatchObject({ count: 1, sum_ms: 80 });
    expect(snap.wait.active_index).toMatchObject({ count: 1, sum_ms: 2 });
    expect(snap.wait.other).toBeUndefined();
  });

  it('reset() clears write-lock telemetry', () => {
    const metrics = new WriteLockMetrics();
    metrics.record({ resourceKind: 'other', waitMs: 1, holdMs: 2 });

    metrics.reset();

    expect(metrics.snapshot()).toEqual({ wait: {}, hold: {} });
  });
});

describe('instrumentEmbeddingsClient', () => {
  function makeClient(opts: { failQuery?: boolean; failDocs?: boolean } = {}) {
    return {
      embedQuery: async (_text: string): Promise<number[]> => {
        if (opts.failQuery) throw new Error('boom');
        return [0.1, 0.2];
      },
      embedDocuments: async (texts: string[]): Promise<number[][]> => {
        if (opts.failDocs) throw new Error('boom-docs');
        return texts.map(() => [0.1, 0.2]);
      },
    };
  }

  it('records one success per embedQuery call', async () => {
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    let clock = 0;
    const client = makeClient();
    instrumentEmbeddingsClient(client, 'huggingface__bge', {
      metrics,
      now: () => {
        clock += 5;
        return clock;
      },
    });
    await client.embedQuery('hello');
    await client.embedQuery('world');
    const snap = metrics.snapshot();
    expect(snap['huggingface__bge'].count).toBe(2);
    expect(snap['huggingface__bge'].errors).toBe(0);
  });

  it('records errors when the underlying call throws and re-throws the original error', async () => {
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = makeClient({ failQuery: true });
    instrumentEmbeddingsClient(client, 'm', { metrics, now: () => 0 });
    await expect(client.embedQuery('x')).rejects.toThrow('boom');
    expect(metrics.snapshot().m).toMatchObject({ count: 1, errors: 1 });
  });

  it('records errors on embedDocuments without losing the underlying message', async () => {
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = makeClient({ failDocs: true });
    instrumentEmbeddingsClient(client, 'm', { metrics, now: () => 0 });
    await expect(client.embedDocuments(['a'])).rejects.toThrow('boom-docs');
    expect(metrics.snapshot().m).toMatchObject({ count: 1, errors: 1 });
  });

  it('is idempotent — a second wrap with the same modelId does not double-count', async () => {
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = makeClient();
    instrumentEmbeddingsClient(client, 'm', { metrics, now: () => 0 });
    instrumentEmbeddingsClient(client, 'm', { metrics, now: () => 0 });
    await client.embedQuery('x');
    expect(metrics.snapshot().m.count).toBe(1);
  });

  it('preserves the original return value', async () => {
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = makeClient();
    instrumentEmbeddingsClient(client, 'm', { metrics, now: () => 0 });
    expect(await client.embedQuery('x')).toEqual([0.1, 0.2]);
    expect(await client.embedDocuments(['a', 'b'])).toEqual([[0.1, 0.2], [0.1, 0.2]]);
  });
});

describe('KbSearchFailureMetrics (issue #737 — per-KB fan-out failures)', () => {
  it('counts failures per KB name and totals them', () => {
    const metrics = new KbSearchFailureMetrics();
    metrics.record('kb-a');
    metrics.record('kb-b');
    metrics.record('kb-a');

    const snapshot = metrics.snapshot();
    expect(snapshot.total).toBe(3);
    expect(snapshot.by_kb).toEqual({ 'kb-a': 2, 'kb-b': 1 });
  });

  it('reports an empty snapshot before any failure and after reset', () => {
    const metrics = new KbSearchFailureMetrics();
    expect(metrics.snapshot()).toEqual({ total: 0, by_kb: {} });
    metrics.record('kb-a');
    metrics.reset();
    expect(metrics.snapshot()).toEqual({ total: 0, by_kb: {} });
  });
});
