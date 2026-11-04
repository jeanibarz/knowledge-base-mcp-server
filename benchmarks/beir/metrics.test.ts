import { describe, expect, it } from '@jest/globals';
import {
  aggregateQueryMetrics,
  formatTrecRun,
  parseQrelsTsv,
  rollUpChunksToDocuments,
  scoreQuery,
  summarizeLatencies,
  QREL_ROLLUP_RULE,
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

describe('chunk→document qrel roll-up (issue #1053)', () => {
  it('names the single roll-up rule reported in result files', () => {
    expect(QREL_ROLLUP_RULE).toBe('max-pool');
  });

  it("max-pools chunks to one row per document using the best chunk's score ('score' mode)", () => {
    // d1 and d2 each appear in several chunks; each collapses to one row carrying
    // its MAX chunk score, re-sorted highest-first. d3 and d1 TIE at 7 and are
    // deliberately inserted in reverse-id order (d3 seen before d1's best chunk)
    // so the ascending-docId tie-break is load-bearing: without it a stable sort
    // would emit d3 before d1.
    const rolled = rollUpChunksToDocuments(
      [
        { docId: 'd3', score: 7 }, // ties d1 at 7, but inserted first
        { docId: 'd2', score: 9 },
        { docId: 'd1', score: 4 },
        { docId: 'd1', score: 7 }, // d1's best chunk (ties d3)
        { docId: 'd2', score: 2 },
      ],
      10,
      { order: 'score' },
    );

    expect(rolled).toEqual([
      { docId: 'd2', score: 9 },
      { docId: 'd1', score: 7 }, // tie-break: d1 < d3
      { docId: 'd3', score: 7 },
    ]);
  });

  it("keeps each document's first (best) appearance in retrieval order ('retrieval-order' mode)", () => {
    // Dense/hybrid legs rank chunks best-first with scores that are NOT
    // higher-is-better (distances, RRF). Pooling must keep the native order and
    // emit a strictly decreasing rank score, never re-sort by raw score.
    const rolled = rollUpChunksToDocuments(
      [
        { docId: 'd2', score: 0.11 }, // ranked first despite the lower raw score
        { docId: 'd1', score: 0.90 },
        { docId: 'd2', score: 0.05 }, // duplicate parent -> dropped
        { docId: 'd3', score: 0.80 },
      ],
      10,
      { order: 'retrieval-order' },
    );

    expect(rolled).toEqual([
      { docId: 'd2', score: 3 },
      { docId: 'd1', score: 2 },
      { docId: 'd3', score: 1 },
    ]);
  });

  it('applies top-k to the pooled DOCUMENTS, not the raw chunks, in both modes', () => {
    // d1 fills the first three chunk slots. If k were (wrongly) applied to chunks
    // before pooling, k=2 would see only d1 and drop d2. Applying k after pooling
    // must return the top-2 distinct documents [d1, d2].
    const chunks = [
      { docId: 'd1', score: 9 },
      { docId: 'd1', score: 8 },
      { docId: 'd1', score: 7 },
      { docId: 'd2', score: 6 },
      { docId: 'd3', score: 5 },
    ];
    expect(rollUpChunksToDocuments(chunks, 2, { order: 'score' }).map((d) => d.docId)).toEqual([
      'd1',
      'd2',
    ]);
    expect(
      rollUpChunksToDocuments(chunks, 2, { order: 'retrieval-order' }).map((d) => d.docId),
    ).toEqual(['d1', 'd2']);
  });

  it('returns an empty ranking for empty input or non-positive k in both modes', () => {
    const chunks = [
      { docId: 'd1', score: 9 },
      { docId: 'd2', score: 8 },
    ];
    for (const order of ['score', 'retrieval-order'] as const) {
      expect(rollUpChunksToDocuments([], 10, { order })).toEqual([]);
      expect(rollUpChunksToDocuments(chunks, 0, { order })).toEqual([]);
      expect(rollUpChunksToDocuments(chunks, -1, { order })).toEqual([]);
    }
  });

  it('produces the same pooled document order in both modes when input is best-first', () => {
    // The relevance roll-up (document set + rank order) is identical across the
    // two score-cosmetic modes when chunks arrive sorted best-first; only the
    // emitted score differs. This is what makes the rule uniform across legs.
    const chunks = [
      { docId: 'd5', score: 9 },
      { docId: 'd1', score: 8 },
      { docId: 'd5', score: 6 },
      { docId: 'd2', score: 4 },
    ];
    const byScore = rollUpChunksToDocuments(chunks, 10, { order: 'score' });
    const byOrder = rollUpChunksToDocuments(chunks, 10, { order: 'retrieval-order' });
    expect(byScore.map((d) => d.docId)).toEqual(byOrder.map((d) => d.docId));
  });

  it('removes the chunk-vs-source confound: chunk+rollup scores equal the whole-document ranking', () => {
    // BEIR qrels are document-level. A whole-document (lexical --unit=source) leg
    // ranks documents directly; a chunk leg returns many chunks per document and,
    // WITHOUT a roll-up, dilutes the signal. After the max-pool roll-up the two
    // legs are apples-to-apples: the same documents, scored identically.
    const qrels = parseQrelsTsv(
      ['query-id corpus-id score', 'q1 d1 2', 'q1 d2 1', 'q1 d3 0'].join('\n'),
    );

    // Whole-document leg: one row per document already.
    const sourceRanking = [
      { docId: 'd1', score: 9 },
      { docId: 'd2', score: 8 },
      { docId: 'd3', score: 6 },
    ];
    const sourceScored = scoreQuery('q1', sourceRanking, qrels);

    // Chunk leg: d1/d2/d3 each retrieved via several interleaved chunks whose
    // parent document is already resolved onto docId. Rolling up reconstructs the
    // document-level ranking the source leg sees.
    const chunkRanking = rollUpChunksToDocuments(
      [
        { docId: 'd1', score: 5 },
        { docId: 'd2', score: 8 },
        { docId: 'd3', score: 6 },
        { docId: 'd1', score: 9 }, // d1's strongest chunk, buried below d2/d3
        { docId: 'd2', score: 1 },
      ],
      100,
      { order: 'score' },
    );
    const chunkScored = scoreQuery('q1', chunkRanking, qrels);

    expect(chunkRanking.map((d) => d.docId)).toEqual(['d1', 'd2', 'd3']);
    // Apples-to-apples: chunk+rollup reproduces the whole-document ranking exactly.
    expect(chunkScored).toEqual(sourceScored);
    expect(chunkScored?.ndcgAt10).toBeGreaterThan(0);

    // Contrast — the confound itself: scoring the SAME retrieval at chunk
    // granularity (chunk ids that never match the document-level qrels) finds
    // nothing relevant, which is exactly the dilution the roll-up removes.
    const unrolledChunkRanking = [
      { docId: 'd1#0', score: 9 },
      { docId: 'd2#0', score: 8 },
      { docId: 'd3#0', score: 6 },
    ];
    const unrolledScored = scoreQuery('q1', unrolledChunkRanking, qrels);
    expect(unrolledScored?.ndcgAt10).toBe(0);
    expect(unrolledScored?.recallAt10).toBe(0);
    expect(chunkScored?.ndcgAt10).toBeGreaterThan(unrolledScored?.ndcgAt10 ?? 0);
  });
});
