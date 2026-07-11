// Issue #339 — unit tests for src/hybrid-retrieval.ts.
//
// Coverage targets called out in the issue:
//
//   - Fetch sizing across small/medium/large k.
//   - RRF fusion with overlapping and disjoint dense/lexical inputs.
//   - Identity mapping when the same id appears in both lists.
//   - Result assembly preserving the documented (fused) order.
//
// We also cover the lexical-leg orchestrator's policy knobs (refresh
// always vs when-empty) and its per-KB error semantics, since those are
// the only behaviours the adapters had to reimplement consistently.

import { describe, expect, it, jest } from '@jest/globals';

import {
  HYBRID_FETCH_CAP,
  HYBRID_FETCH_MULTIPLIER,
  HYBRID_RRF_C,
  fuseHybridResults,
  fuseHybridResultsWithDiagnostics,
  hybridFetchK,
  runLexicalLeg,
  type HybridChunk,
  type LexicalKb,
} from './hybrid-retrieval.js';
import type { LexicalIndex, LexicalSearchResult } from './lexical-index.js';
import { kbSearchFailureMetrics } from './metrics.js';
import { logger } from './logger.js';
import { DEFAULT_C } from './rrf.js';

function chunk(source: string, chunkIndex: number, score: number, body = `c${chunkIndex}`): HybridChunk {
  return {
    pageContent: `${source}::${body}`,
    metadata: { source, chunkIndex },
    score,
  };
}

describe('hybridFetchK', () => {
  it('returns k * HYBRID_FETCH_MULTIPLIER for small k (matches the prior CLI/eval formula)', () => {
    expect(hybridFetchK(1)).toBe(1 * HYBRID_FETCH_MULTIPLIER);
    expect(hybridFetchK(5)).toBe(5 * HYBRID_FETCH_MULTIPLIER);
    expect(hybridFetchK(10)).toBe(40); // pinned: matches the prior MCP HYBRID_FETCH_K
    expect(hybridFetchK(25)).toBe(25 * HYBRID_FETCH_MULTIPLIER);
  });

  it('clamps fetch to HYBRID_FETCH_CAP for medium k', () => {
    // The cap kicks in once k * 4 > 200, i.e. k > 50.
    expect(hybridFetchK(50)).toBe(200);
    expect(hybridFetchK(51)).toBe(HYBRID_FETCH_CAP);
    expect(hybridFetchK(100)).toBe(HYBRID_FETCH_CAP);
  });

  it('falls back to k itself for very large k so we never fetch fewer than the requested top-k', () => {
    // For k > HYBRID_FETCH_CAP the cap would otherwise lower us below k. The
    // `Math.max(..., k)` guard prevents that.
    expect(hybridFetchK(HYBRID_FETCH_CAP)).toBe(HYBRID_FETCH_CAP);
    expect(hybridFetchK(HYBRID_FETCH_CAP + 1)).toBe(HYBRID_FETCH_CAP + 1);
    expect(hybridFetchK(1000)).toBe(1000);
  });

  it('rejects non-positive, non-integer, and non-finite k', () => {
    expect(() => hybridFetchK(0)).toThrow(/positive integer/);
    expect(() => hybridFetchK(-3)).toThrow(/positive integer/);
    expect(() => hybridFetchK(1.5)).toThrow(/positive integer/);
    expect(() => hybridFetchK(Number.NaN)).toThrow(/positive integer/);
    expect(() => hybridFetchK(Number.POSITIVE_INFINITY)).toThrow(/positive integer/);
  });
});

describe('fuseHybridResults', () => {
  it('returns disjoint lists in fused-score order, preserving rank within each leg', () => {
    // Dense: A (rank 1), B (rank 2). Lexical: C (rank 1), D (rank 2).
    // No overlap, so fused score for each id is exactly the single-leg
    // contribution. With c=60: A,C tie at 1/61, B,D tie at 1/62. The tie
    // breaks on insertion order across lists (dense first, then lexical),
    // so the fused order is [A, C, B, D].
    const dense = [chunk('a.md', 0, 0.9), chunk('b.md', 0, 0.8)];
    const lexical = [chunk('c.md', 0, 0.7), chunk('d.md', 0, 0.6)];
    const out = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: 4 });
    expect(out.map((r) => r.metadata.source)).toEqual(['a.md', 'c.md', 'b.md', 'd.md']);
    // The first two are tied at 1/(60+1).
    expect(out[0].score).toBeCloseTo(1 / (DEFAULT_C + 1), 12);
    expect(out[1].score).toBeCloseTo(1 / (DEFAULT_C + 1), 12);
    expect(out[2].score).toBeCloseTo(1 / (DEFAULT_C + 2), 12);
    expect(out[3].score).toBeCloseTo(1 / (DEFAULT_C + 2), 12);
  });

  it('sums contributions when the same chunk appears in both legs (overlapping inputs)', () => {
    // Y appears at rank 2 dense and rank 1 lexical → wins.
    // X appears at rank 1 dense and rank 5 lexical → strong dense, weak lexical.
    const dense = [chunk('x.md', 0, 0.9), chunk('y.md', 0, 0.85)];
    const lexical = [
      chunk('y.md', 0, 0.7),
      chunk('w.md', 0, 0.6),
      chunk('v.md', 0, 0.55),
      chunk('u.md', 0, 0.5),
      chunk('x.md', 0, 0.45),
    ];
    const out = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: 5 });

    const yScore = 1 / (DEFAULT_C + 2) + 1 / (DEFAULT_C + 1);
    const xScore = 1 / (DEFAULT_C + 1) + 1 / (DEFAULT_C + 5);
    expect(out[0].metadata.source).toBe('y.md');
    expect(out[0].score).toBeCloseTo(yScore, 12);
    expect(out[1].metadata.source).toBe('x.md');
    expect(out[1].score).toBeCloseTo(xScore, 12);

    // The remaining lexical-only ids fill the rest in their lexical-rank order.
    expect(out.slice(2).map((r) => r.metadata.source)).toEqual(['w.md', 'v.md', 'u.md']);
  });

  it('prefers the dense entry when both legs return the same chunk id (identity mapping)', () => {
    // The two legs return the SAME chunk id but with different pageContent.
    // The dense pageContent should win (writes happen lexical-first then dense).
    const dense = [chunk('shared.md', 7, 0.9, 'DENSE-BODY')];
    const lexical = [chunk('shared.md', 7, 0.6, 'LEXICAL-BODY')];
    const out = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].pageContent).toBe('shared.md::DENSE-BODY');
    // Score is replaced by the fused score, NOT carried from either leg.
    const expected = 1 / (DEFAULT_C + 1) + 1 / (DEFAULT_C + 1);
    expect(out[0].score).toBeCloseTo(expected, 12);
  });

  it('clips to k while preserving fused order', () => {
    const dense = [chunk('a.md', 0, 0.9), chunk('b.md', 0, 0.8), chunk('c.md', 0, 0.7)];
    const lexical = [chunk('a.md', 0, 0.5), chunk('d.md', 0, 0.4)];
    const top1 = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: 1 });
    expect(top1).toHaveLength(1);
    expect(top1[0].metadata.source).toBe('a.md');
    const top3 = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: 3 });
    expect(top3.map((r) => r.metadata.source)).toEqual(['a.md', 'b.md', 'd.md']);
  });

  it('returns [] when both legs are empty', () => {
    expect(fuseHybridResults({ denseResults: [], lexicalResults: [], k: 10 })).toEqual([]);
  });

  it('handles a single-leg-only query (the other leg returned nothing)', () => {
    const dense = [chunk('a.md', 0, 0.9), chunk('b.md', 0, 0.8)];
    const out = fuseHybridResults({ denseResults: dense, lexicalResults: [], k: 5 });
    expect(out.map((r) => r.metadata.source)).toEqual(['a.md', 'b.md']);
    expect(out[0].score).toBeCloseTo(1 / (DEFAULT_C + 1), 12);
  });

  it('returns dense-distance and lexical-hit side channels for the relevance gate', () => {
    const dense = [chunk('a.md', 0, 0.42), chunk('b.md', 0, 0.73)];
    const lexical = [chunk('b.md', 0, 4.0), chunk('c.md', 0, 3.0)];
    const out = fuseHybridResultsWithDiagnostics({ denseResults: dense, lexicalResults: lexical, k: 3 });

    expect(out.results.map((r) => r.metadata.source)).toEqual(['b.md', 'a.md', 'c.md']);
    expect(out.denseDistanceById.get('a.md#0')).toBe(0.42);
    expect(out.denseDistanceById.get('b.md#0')).toBe(0.73);
    expect(out.lexicalHitIds.has('b.md#0')).toBe(true);
    expect(out.lexicalHitIds.has('c.md#0')).toBe(true);
  });

  it('uses HYBRID_RRF_C by default and accepts an override', () => {
    // Sanity: HYBRID_RRF_C is the rrf module's DEFAULT_C.
    expect(HYBRID_RRF_C).toBe(DEFAULT_C);
    const dense = [chunk('a.md', 0, 0.9)];
    const out = fuseHybridResults({ denseResults: dense, lexicalResults: [], k: 1, c: 1 });
    expect(out[0].score).toBeCloseTo(1 / (1 + 1), 12);
  });

  it('rejects non-positive k', () => {
    expect(() =>
      fuseHybridResults({ denseResults: [], lexicalResults: [], k: 0 }),
    ).toThrow(/positive integer/);
  });
});

// -- runLexicalLeg --------------------------------------------------------

interface FakeIndexOptions {
  numFiles: number;
  hits: LexicalSearchResult[];
  /** When set, the next `query` rejects with this error. */
  failQuery?: Error;
  /** When set, the next `refresh` rejects with this error. */
  failRefresh?: Error;
}

function makeFakeIndex(opts: FakeIndexOptions) {
  let files = opts.numFiles;
  const refresh = jest.fn(async () => {
    if (opts.failRefresh) throw opts.failRefresh;
    files = Math.max(files, 1);
    return { added: 1, updated: 0, removed: 0, failed: 0, totalFiles: files, totalChunks: 1 };
  });
  const save = jest.fn(async () => {});
  const query = jest.fn(async (_q: string, _k: number) => {
    if (opts.failQuery) throw opts.failQuery;
    return opts.hits;
  });
  const numFiles = jest.fn(() => files);
  const idx = { refresh, save, query, numFiles } as unknown as LexicalIndex;
  return { idx, refresh, save, query, numFiles };
}

const KB_LIST: LexicalKb[] = [
  { kbName: 'kb-a', kbPath: '/tmp/fake/kb-a' },
  { kbName: 'kb-b', kbPath: '/tmp/fake/kb-b' },
];

function lexicalHit(source: string, score: number): LexicalSearchResult {
  return { pageContent: `${source}::body`, metadata: { source, chunkIndex: 0 }, score };
}

describe('runLexicalLeg', () => {
  it('refreshes only when the index is empty under refresh="when-empty"', async () => {
    const empty = makeFakeIndex({ numFiles: 0, hits: [lexicalHit('a.md', 0.9)] });
    const populated = makeFakeIndex({ numFiles: 5, hits: [lexicalHit('b.md', 0.8)] });
    const loadIndex = jest.fn(async (kbName: string) =>
      kbName === 'kb-a' ? empty.idx : populated.idx,
    );

    const result = await runLexicalLeg({
      kbs: KB_LIST,
      query: 'q',
      fetchK: 10,
      refresh: 'when-empty',
      loadIndex,
    });

    expect(empty.refresh).toHaveBeenCalledTimes(1);
    expect(empty.save).toHaveBeenCalledTimes(1);
    expect(populated.refresh).not.toHaveBeenCalled();
    expect(populated.save).not.toHaveBeenCalled();
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    // Hits are sorted descending by score: a.md (0.9) before b.md (0.8).
    expect(result.hits.map((h) => h.metadata.source)).toEqual(['a.md', 'b.md']);
  });

  it('always refreshes under refresh="always" even when the index is populated', async () => {
    const populated = makeFakeIndex({ numFiles: 5, hits: [lexicalHit('a.md', 0.9)] });
    const loadIndex = jest.fn(async () => populated.idx);
    const result = await runLexicalLeg({
      kbs: [{ kbName: 'kb-a', kbPath: '/tmp/fake/kb-a' }],
      query: 'q',
      fetchK: 10,
      refresh: 'always',
      loadIndex,
    });
    expect(populated.refresh).toHaveBeenCalledTimes(1);
    expect(populated.save).toHaveBeenCalledTimes(1);
    expect(result.refreshed).toBe(1);
  });

  it('survives per-KB load/query failures, counts them in failed, and notifies onError', async () => {
    const ok = makeFakeIndex({ numFiles: 5, hits: [lexicalHit('a.md', 0.9)] });
    const failingQuery = makeFakeIndex({
      numFiles: 5,
      hits: [],
      failQuery: new Error('boom-query'),
    });
    const loadIndex = jest.fn(async (kbName: string) => {
      if (kbName === 'kb-a') return ok.idx;
      if (kbName === 'kb-b') return failingQuery.idx;
      throw new Error('boom-load');
    });
    const onError = jest.fn();
    const kbs: LexicalKb[] = [
      { kbName: 'kb-a', kbPath: '/tmp/a' },
      { kbName: 'kb-b', kbPath: '/tmp/b' },
      { kbName: 'kb-c', kbPath: '/tmp/c' },
    ];
    const result = await runLexicalLeg({
      kbs,
      query: 'q',
      fetchK: 10,
      refresh: 'when-empty',
      loadIndex,
      onError,
    });
    expect(result.failed).toBe(2);
    expect(result.refreshed).toBe(0);
    expect(result.hits.map((h) => h.metadata.source)).toEqual(['a.md']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map(([kbName]) => kbName).sort()).toEqual(['kb-b', 'kb-c']);
  });

  it('clips merged hits to fetchK after sorting by score', async () => {
    const a = makeFakeIndex({
      numFiles: 5,
      hits: [lexicalHit('a1', 0.9), lexicalHit('a2', 0.5)],
    });
    const b = makeFakeIndex({
      numFiles: 5,
      hits: [lexicalHit('b1', 0.95), lexicalHit('b2', 0.4)],
    });
    const loadIndex = jest.fn(async (kbName: string) => (kbName === 'kb-a' ? a.idx : b.idx));
    const result = await runLexicalLeg({
      kbs: KB_LIST,
      query: 'q',
      fetchK: 2,
      refresh: 'when-empty',
      loadIndex,
    });
    // After sort: b1 (0.95), a1 (0.9), a2 (0.5), b2 (0.4) → top-2 = [b1, a1].
    expect(result.hits.map((h) => h.metadata.source)).toEqual(['b1', 'a1']);
  });

  it('returns an empty result for an empty KB list', async () => {
    const result = await runLexicalLeg({
      kbs: [],
      query: 'q',
      fetchK: 10,
      refresh: 'when-empty',
    });
    expect(result).toEqual({ hits: [], refreshed: 0, failed: 0, failedKbs: [] });
  });

  // Issue #737 — a deliberately-broken KB must increment the process metric
  // and surface its NAME (not path) so a partial "search everything" result is
  // never silent.
  it('records kbSearchFailureMetrics and names the failed KB when a KB fails', async () => {
    kbSearchFailureMetrics.reset();
    const ok = makeFakeIndex({ numFiles: 5, hits: [lexicalHit('a.md', 0.9)] });
    const loadIndex = jest.fn(async (kbName: string) => {
      if (kbName === 'kb-a') return ok.idx;
      throw new Error('corrupt index');
    });
    const result = await runLexicalLeg({
      kbs: [
        { kbName: 'kb-a', kbPath: '/tmp/secret/kb-a' },
        { kbName: 'kb-b', kbPath: '/tmp/secret/kb-b' },
      ],
      query: 'q',
      fetchK: 10,
      refresh: 'when-empty',
      loadIndex,
    });

    expect(result.failed).toBe(1);
    expect(result.failedKbs).toEqual(['kb-b']);

    const snapshot = kbSearchFailureMetrics.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.by_kb).toEqual({ 'kb-b': 1 });
    // KB name only — the absolute path must never leak into the metric label.
    expect(Object.keys(snapshot.by_kb)).not.toContain('/tmp/secret/kb-b');
  });

  // Issue #737 — with no caller-supplied onError, the failure is logged rather
  // than silently swallowed.
  it('logs a warning via the default onError when the caller supplies none', async () => {
    kbSearchFailureMetrics.reset();
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      const loadIndex = jest.fn(async () => {
        throw new Error('boom-load');
      });
      const result = await runLexicalLeg({
        kbs: [{ kbName: 'kb-x', kbPath: '/tmp/fake/kb-x' }],
        query: 'q',
        fetchK: 10,
        refresh: 'when-empty',
        loadIndex,
      });
      expect(result.failed).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('kb-x');
      expect(message).not.toContain('/tmp/fake/kb-x');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
