import { describe, expect, it } from '@jest/globals';
import { SearchLatencyMetrics } from './search-latency-metrics.js';

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
