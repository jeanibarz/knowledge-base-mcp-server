import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  applyRerankerIfEnabled,
  InMemoryRerankScoreCache,
  rerankFusedResults,
  scoresFromSequenceClassifierOutput,
  setRerankerFactoryForTests,
  type Reranker,
  type RerankableDocument,
} from './reranker.js';
import { rerankMetrics } from './metrics.js';

function doc(source: string, score: number, body = source): RerankableDocument {
  return {
    pageContent: body,
    metadata: { source, chunkIndex: 0 },
    score,
  };
}

function stubReranker(scores: number[]): Reranker {
  return {
    id: 'stub-reranker',
    rerank: jest.fn(async () => scores),
  };
}

describe('rerankFusedResults (RFC 019)', () => {
  it('reranks the topN block by descending cross-encoder score and returns top k', async () => {
    const reranker = stubReranker([0.10, 0.95, 0.40]);
    const fused = [doc('a.md', 0.030), doc('b.md', 0.025), doc('c.md', 0.020)];

    const out = await rerankFusedResults({
      query: 'how do rollbacks work',
      fused,
      k: 2,
      topN: 3,
      reranker,
    });

    expect(out.degraded).toBe(false);
    expect(out.results.map((r) => r.metadata.source)).toEqual(['b.md', 'c.md']);
    expect(out.results.map((r) => r.rerankScore)).toEqual([0.95, 0.40]);
    expect(out.results[0].score).toBe(0.025);
  });

  it('keeps unscored tail candidates after the reranked block in original fused order', async () => {
    const reranker = stubReranker([0.20, 0.90]);
    const fused = [
      doc('a.md', 0.040),
      doc('b.md', 0.030),
      doc('c.md', 0.020),
      doc('d.md', 0.010),
    ];

    const out = await rerankFusedResults({
      query: 'query',
      fused,
      k: 4,
      topN: 2,
      reranker,
    });

    expect(out.results.map((r) => r.metadata.source)).toEqual(['b.md', 'a.md', 'c.md', 'd.md']);
    expect(out.results.map((r) => r.rerankScore ?? null)).toEqual([0.90, 0.20, null, null]);
  });

  it('uses an in-memory cache keyed by normalized query, model id, and candidate content', async () => {
    const reranker = stubReranker([0.75, 0.25]);
    const cache = new InMemoryRerankScoreCache({ maxEntries: 10 });
    const fused = [doc('a.md', 0.020, 'same body'), doc('b.md', 0.010, 'other body')];

    await rerankFusedResults({ query: '  Query   Text ', fused, k: 2, topN: 2, reranker, cache });
    const second = await rerankFusedResults({ query: 'query text', fused, k: 2, topN: 2, reranker, cache });

    expect(reranker.rerank).toHaveBeenCalledTimes(1);
    expect(second.cacheHits).toBe(2);
    expect(second.results.map((r) => r.rerankScore)).toEqual([0.75, 0.25]);
  });

  it('degrades to the original fused order when the provider fails', async () => {
    const reranker: Reranker = {
      id: 'throwing',
      rerank: jest.fn(async () => {
        throw new Error('model unavailable');
      }),
    };
    const fused = [doc('a.md', 0.030), doc('b.md', 0.020)];

    const out = await rerankFusedResults({ query: 'q', fused, k: 2, topN: 2, reranker });

    expect(out.degraded).toBe(true);
    expect(out.degradeReason).toContain('model unavailable');
    expect(out.results).toEqual(fused);
  });

  it('degrades to the original fused order when the provider returns the wrong number of scores', async () => {
    const reranker = stubReranker([0.1]);
    const fused = [doc('a.md', 0.030), doc('b.md', 0.020)];

    const out = await rerankFusedResults({ query: 'q', fused, k: 2, topN: 2, reranker });

    expect(out.degraded).toBe(true);
    expect(out.degradeReason).toMatch(/expected 2 scores, got 1/);
    expect(out.results).toEqual(fused);
  });
});

describe('applyRerankerIfEnabled — per-domain skip-rerank fallback (RFC 020 §9)', () => {
  const ENV_KEYS = ['KB_RERANK', 'KB_RERANK_MODEL', 'KB_RERANK_TOP_N', 'KB_RERANK_SKIP_DOMAINS'] as const;
  let saved: Record<string, string | undefined>;

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  }

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    rerankMetrics.reset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rerankMetrics.reset();
  });

  it('does NOT invoke the cross-encoder when the scoped domain is on KB_RERANK_SKIP_DOMAINS', async () => {
    const reranker = stubReranker([0.9, 0.1]);
    const restore = setRerankerFactoryForTests(async () => reranker);
    try {
      setEnv({ KB_RERANK: 'on', KB_RERANK_SKIP_DOMAINS: 'code,skills' });
      const fused = [doc('a.md', 0.030), doc('b.md', 0.020)];

      const out = await applyRerankerIfEnabled({
        query: 'q',
        results: fused,
        k: 2,
        kbScope: 'code',
      });

      // Reranker is bypassed; fused order is returned unchanged, no degrade.
      expect(reranker.rerank).not.toHaveBeenCalled();
      expect(out.degraded).toBe(false);
      expect(out.candidatesIn).toBe(0);
      expect(out.results.map((r) => r.metadata.source)).toEqual(['a.md', 'b.md']);
      expect(rerankMetrics.snapshot().skipped).toEqual({ skip_domain: 1 });
    } finally {
      restore();
    }
  });

  it('DOES invoke the cross-encoder for a domain not on the skip list', async () => {
    const reranker = stubReranker([0.1, 0.9]);
    const restore = setRerankerFactoryForTests(async () => reranker);
    try {
      setEnv({ KB_RERANK: 'on', KB_RERANK_SKIP_DOMAINS: 'code,skills' });
      const fused = [doc('a.md', 0.030), doc('b.md', 0.020)];

      const out = await applyRerankerIfEnabled({
        query: 'q',
        results: fused,
        k: 2,
        kbScope: 'prose',
      });

      expect(reranker.rerank).toHaveBeenCalledTimes(1);
      expect(out.degraded).toBe(false);
      // b.md outscores a.md after reranking.
      expect(out.results.map((r) => r.metadata.source)).toEqual(['b.md', 'a.md']);
      expect(rerankMetrics.snapshot()).toMatchObject({
        invocations: 1,
        candidates: { model_scored: 2 },
      });
    } finally {
      restore();
    }
  });

  it('records a no-candidates skip without invoking the cross-encoder', async () => {
    const reranker = stubReranker([]);
    const restore = setRerankerFactoryForTests(async () => reranker);
    try {
      setEnv({ KB_RERANK: 'on' });

      const out = await applyRerankerIfEnabled({
        query: 'q',
        results: [],
        k: 2,
        kbScope: 'prose',
      });

      expect(reranker.rerank).not.toHaveBeenCalled();
      expect(out.results).toEqual([]);
      expect(out.degraded).toBe(false);
      expect(out.candidatesIn).toBe(0);
      expect(rerankMetrics.snapshot().skipped).toEqual({ no_candidates: 1 });
    } finally {
      restore();
    }
  });

  it('records cache-hit rerank paths separately from model-scored candidates', async () => {
    const reranker = stubReranker([0.8, 0.2]);
    const restore = setRerankerFactoryForTests(async () => reranker);
    try {
      setEnv({ KB_RERANK: 'on' });
      const fused = [doc('a.md', 0.030, 'same body'), doc('b.md', 0.020, 'other body')];

      await applyRerankerIfEnabled({ query: 'q', results: fused, k: 2, kbScope: 'prose' });
      await applyRerankerIfEnabled({ query: 'q', results: fused, k: 2, kbScope: 'prose' });

      expect(reranker.rerank).toHaveBeenCalledTimes(1);
      expect(rerankMetrics.snapshot()).toMatchObject({
        invocations: 2,
        candidates: {
          cache_hit: 2,
          model_scored: 2,
        },
      });
      expect(rerankMetrics.snapshot().latency.cache_hit?.count).toBe(1);
      expect(rerankMetrics.snapshot().latency.model_scored?.count).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('scoresFromSequenceClassifierOutput', () => {
  it('uses raw logits for one-label MS MARCO cross-encoder models', () => {
    expect(scoresFromSequenceClassifierOutput({
      logits: { dims: [3, 1], data: [8.1, -2.4, 0.5] },
    })).toEqual([8.1, -2.4, 0.5]);
  });

  it('uses the positive-label softmax probability for two-label classifiers', () => {
    const scores = scoresFromSequenceClassifierOutput(
      { logits: { dims: [2, 2], data: [1, 3, 4, 1] } },
      { label2id: { negative: 0, positive: 1 } },
    );

    expect(scores[0]).toBeCloseTo(0.8808, 4);
    expect(scores[1]).toBeCloseTo(0.0474, 4);
  });
});
