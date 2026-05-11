import { describe, expect, it } from '@jest/globals';
import {
  bucketIndexForLatency,
  instrumentEmbeddingsClient,
  LATENCY_BUCKET_BOUNDS_MS,
  ProviderCallMetrics,
  quantileFromBuckets,
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
