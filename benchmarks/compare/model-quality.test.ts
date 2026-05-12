import { parseGoldenLabels, scoreGoldenQuality } from './golden.js';

describe('golden model quality scoring', () => {
  it('scores binary labels with recall, MRR, hit rate, and MAP', () => {
    const labels = parseGoldenLabels({
      'cache invalidation': [
        { source: 'a.md', relevance: 1 },
        { source: 'b.md', relevance: 1 },
      ],
    });

    const scored = scoreGoldenQuality(labels, [{
      query: 'cache invalidation',
      topK_a: [
        { doc: 'a.md', score: 0.9 },
        { doc: 'x.md', score: 0.8 },
        { doc: 'b.md', score: 0.7 },
      ],
      topK_b: [
        { doc: 'x.md', score: 0.9 },
        { doc: 'y.md', score: 0.8 },
      ],
    }]);

    expect(scored.labelled_query_count).toBe(1);
    expect(scored.model_a.hit_rate_at_10).toBe(1);
    expect(scored.model_a.mrr_at_10).toBe(1);
    expect(scored.model_a.recall_at_5).toBe(1);
    expect(scored.model_a.map_at_10).toBeCloseTo((1 + 2 / 3) / 2, 6);
    expect(scored.model_b.hit_rate_at_10).toBe(0);
    expect(scored.model_b.recall_at_10).toBe(0);
  });

  it('uses graded relevance for nDCG@10', () => {
    const labels = parseGoldenLabels({
      'ranking quality': [
        { source: 'best.md', relevance: 3 },
        { source: 'ok.md', relevance: 1 },
      ],
    });

    const scored = scoreGoldenQuality(labels, [{
      query: 'ranking quality',
      topK_a: [
        { doc: 'best.md', score: 0.9 },
        { doc: 'ok.md', score: 0.8 },
      ],
      topK_b: [
        { doc: 'ok.md', score: 0.9 },
        { doc: 'best.md', score: 0.8 },
      ],
    }]);

    expect(scored.model_a.ndcg_at_10).toBe(1);
    expect(scored.model_b.ndcg_at_10).toBeGreaterThan(0);
    expect(scored.model_b.ndcg_at_10).toBeLessThan(1);
  });

  it('reports missing query labels without failing the run', () => {
    const labels = parseGoldenLabels({
      'labelled query': [{ source: 'answer.md', relevance: 1 }],
    });

    const scored = scoreGoldenQuality(labels, [
      {
        query: 'labelled query',
        topK_a: [{ doc: 'answer.md', score: 1 }],
        topK_b: [],
      },
      {
        query: 'unlabelled query',
        topK_a: [{ doc: 'other.md', score: 1 }],
        topK_b: [{ doc: 'answer.md', score: 1 }],
      },
    ]);

    expect(scored.query_count).toBe(2);
    expect(scored.labelled_query_count).toBe(1);
    expect(scored.missing_query_count).toBe(1);
    expect(scored.per_query[1]?.status).toBe('missing-labels');
    expect(scored.model_a.recall_at_10).toBe(1);
  });

  it('deduplicates retrieved sources before scoring', () => {
    const labels = parseGoldenLabels({
      duplicates: [
        { source: 'a.md', relevance: 1 },
        { source: 'b.md', relevance: 1 },
      ],
    });

    const scored = scoreGoldenQuality(labels, [{
      query: 'duplicates',
      topK_a: [
        { doc: 'a.md', score: 0.9 },
        { doc: 'a.md', score: 0.8 },
        { doc: 'b.md', score: 0.7 },
      ],
      topK_b: [
        { doc: 'a.md', score: 0.9 },
        { doc: 'a.md', score: 0.8 },
      ],
    }]);

    expect(scored.per_query[0]?.model_a?.unique_retrieved_count).toBe(2);
    expect(scored.model_a.recall_at_10).toBe(1);
    expect(scored.model_a.map_at_10).toBe(1);
    expect(scored.model_b.recall_at_10).toBe(0.5);
    expect(scored.model_b.map_at_10).toBe(0.5);
  });

  it('fails invalid golden labels with a clear error', () => {
    expect(() => parseGoldenLabels({
      broken: [{ source: 'a.md', relevance: 4 }],
    }, 'fixture.json')).toThrow('fixture.json: "broken"[0]: relevance must be one of 0, 1, 2, or 3');
  });

  it('accepts legacy string source arrays as binary labels', () => {
    const labels = parseGoldenLabels({
      legacy: ['a.md', 'b.md'],
    });

    expect(labels.legacy).toEqual([
      { source: 'a.md', relevance: 1 },
      { source: 'b.md', relevance: 1 },
    ]);
  });
});
