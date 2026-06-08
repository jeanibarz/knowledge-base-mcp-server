import { describe, expect, it } from '@jest/globals';
import {
  aggregateQueryMetrics,
  formatTrecRun,
  parseQrelsTsv,
  scoreQuery,
  summarizeLatencies,
} from './metrics.js';

describe('BEIR benchmark metrics', () => {
  it('scores BEIR-style qrels with graded nDCG and binary recall/MAP', () => {
    const qrels = parseQrelsTsv([
      'query-id corpus-id score',
      'q1 d1 2',
      'q1 d2 1',
      'q1 d3 0',
      'q2 d9 1',
    ].join('\n'));

    const scored = scoreQuery('q1', [
      { docId: 'd2', score: 12 },
      { docId: 'd3', score: 11 },
      { docId: 'd1', score: 10 },
    ], qrels);

    expect(scored).toMatchObject({
      queryId: 'q1',
      relevant: 2,
      retrieved: 3,
      recallAt10: 1,
      recallAt100: 1,
    });
    expect(scored?.mapAt100).toBeCloseTo(0.833333, 6);
    expect(scored?.ndcgAt10).toBeCloseTo(0.688529, 6);
    expect(scored?.ndcgAt10).toBeLessThan(1);
    // 2 of the top-10 slots are relevant (d2, d1) over a cutoff of 10 -> 0.2.
    expect(scored?.precisionAt10).toBeCloseTo(0.2, 6);
  });

  it('aggregates query metrics and latency percentiles deterministically', () => {
    const aggregate = aggregateQueryMetrics([
      {
        queryId: 'q1',
        relevant: 1,
        retrieved: 1,
        ndcgAt10: 1,
        mapAt100: 1,
        precisionAt10: 0.1,
        recallAt10: 1,
        recallAt100: 1,
      },
      {
        queryId: 'q2',
        relevant: 2,
        retrieved: 1,
        ndcgAt10: 0.5,
        mapAt100: 0.25,
        precisionAt10: 0.2,
        recallAt10: 0.5,
        recallAt100: 0.5,
      },
    ]);

    expect(aggregate).toEqual({
      judgedQueries: 2,
      ndcgAt10: 0.75,
      mapAt100: 0.625,
      precisionAt10: 0.15,
      recallAt10: 0.75,
      recallAt100: 0.75,
    });
    expect(summarizeLatencies([7, 1, 3, 9, 5])).toEqual({
      queries: 5,
      p50Ms: 5,
      p95Ms: 9,
      p99Ms: 9,
      meanMs: 5,
    });
  });

  it('emits TREC run rows with stable ranks and score formatting', () => {
    expect(formatTrecRun([
      {
        queryId: 'q1',
        ranking: [
          { docId: 'd1', score: 1.23456789 },
          { docId: 'd2', score: 0 },
        ],
      },
    ], 'kb-lexical')).toBe('q1 Q0 d1 1 1.234568 kb-lexical\nq1 Q0 d2 2 0.000000 kb-lexical\n');
  });
});
