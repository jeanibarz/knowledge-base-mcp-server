import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_LEXICAL_BM25_OPTIONS,
  LexicalBm25Ranker,
  tokenizeLexicalText,
} from './lexical-bm25.js';

describe('LexicalBm25Ranker', () => {
  it('tokenizes punctuation, case, and camelCase consistently', () => {
    expect(tokenizeLexicalText('INDEX_NOT_INITIALIZED parseHTTPResponse v2.1')).toEqual([
      'index',
      'not',
      'initialized',
      'parse',
      'httpresponse',
      'v2',
      '1',
    ]);
  });

  it('keeps non-Latin lexical terms searchable', () => {
    expect(tokenizeLexicalText('東京 障害対応 кириллица')).toEqual([
      '東京',
      '障害対応',
      'кириллица',
    ]);

    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'ja', text: '東京 障害対応 手順' },
      { item: 'en', text: 'ordinary incident response' },
    ]);
    expect(ranker.query('東京 障害対応', 1)[0]?.item).toBe('ja');
  });

  it('uses title weighting as a general retrieval signal', () => {
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'title-hit', title: 'Graph rollback', text: 'ordinary runbook body' },
      { item: 'body-hit', title: 'Ordinary', text: 'rollback rollback rollback body' },
    ], { k1: 1.2, b: 0.75, titleWeight: 6 });

    expect(ranker.query('graph rollback', 2)[0]?.item).toBe('title-hit');
  });
});

// Issue #1198 — pin the BM25 arithmetic itself, not just orderings, so a
// regression in the IDF, the length normalisation, or the `k` bound fails a
// unit test (and kills the matching Stryker mutants).
describe('LexicalBm25Ranker scoring arithmetic', () => {
  const NO_TITLE = { k1: 1.2, b: 0.75, titleWeight: 0 };

  it('matches hand-computed golden scores on a fixed corpus', () => {
    // N = 3 records, lengths 3 / 2 / 4, so avgdl = 3.
    //   idf(apple,  df=1) = ln(1 + (3 - 1 + 0.5) / (1 + 0.5)) = ln(8/3) ≈ 0.980829
    //   idf(cherry, df=2) = ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln(1.6) ≈ 0.470004
    //   termScore(tf, len) = tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avgdl))
    //   a: idf(apple)  * 2 * 2.2 / (2 + 1.2 * 1.00) = 0.980829 * 1.375000 ≈ 1.348640
    //   b: idf(cherry) * 1 * 2.2 / (1 + 1.2 * 0.75) = 0.470004 * 1.157895 ≈ 0.544215
    //   c: idf(cherry) * 1 * 2.2 / (1 + 1.2 * 1.25) = 0.470004 * 0.880000 ≈ 0.413603
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'a', text: 'apple banana apple' },
      { item: 'b', text: 'banana cherry' },
      { item: 'c', text: 'cherry date elderberry fig' },
    ], NO_TITLE);

    const results = ranker.query('apple cherry', 10);
    expect(results.map((result) => result.item)).toEqual(['a', 'b', 'c']);
    expect(results[0].score).toBeCloseTo(1.348640, 5);
    expect(results[1].score).toBeCloseTo(0.544215, 5);
    expect(results[2].score).toBeCloseTo(0.413603, 5);
  });

  it('ranks a rarer term above a common one at equal term frequency and length', () => {
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'rare', text: 'rare filler' },
      { item: 'common', text: 'common filler' },
      { item: 'other-1', text: 'common alpha' },
      { item: 'other-2', text: 'common beta' },
    ], NO_TITLE);

    const scores = new Map(ranker.query('rare common', 10).map((r) => [r.item, r.score]));
    expect(scores.get('rare')).toBeGreaterThan(scores.get('common') ?? Infinity);
  });

  it('prefers the shorter record at equal term frequency when b > 0', () => {
    const corpus = [
      { item: 'short', text: 'needle' },
      { item: 'long', text: 'needle hay hay hay hay' },
      { item: 'none', text: 'hay hay' },
    ];
    const results = LexicalBm25Ranker.fromRecords(corpus, NO_TITLE).query('needle', 10);
    expect(results.map((r) => r.item)).toEqual(['short', 'long']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('removes the length effect entirely when b = 0', () => {
    const corpus = [
      { item: 'short', text: 'needle' },
      { item: 'long', text: 'needle hay hay hay hay' },
      { item: 'none', text: 'hay hay' },
    ];
    const results = LexicalBm25Ranker.fromRecords(corpus, { ...NO_TITLE, b: 0 }).query('needle', 10);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeCloseTo(results[1].score, 10);
  });

  it('saturates term frequency under k1', () => {
    const k1 = 1.2;
    // b = 0 isolates the term-frequency component from record length.
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 1, text: 'term' },
      { item: 2, text: 'term term' },
      { item: 4, text: 'term term term term' },
      { item: 8, text: Array(8).fill('term').join(' ') },
      { item: 0, text: 'unrelated' },
    ], { k1, b: 0, titleWeight: 0 });

    const scoreByTf = new Map(ranker.query('term', 10).map((r) => [r.item, r.score]));
    const s1 = scoreByTf.get(1)!;
    const s2 = scoreByTf.get(2)!;
    const s4 = scoreByTf.get(4)!;
    const s8 = scoreByTf.get(8)!;

    // Monotone in term frequency...
    expect(s2).toBeGreaterThan(s1);
    expect(s4).toBeGreaterThan(s2);
    expect(s8).toBeGreaterThan(s4);
    // ...with diminishing returns per doubling...
    expect(s4 - s2).toBeLessThan(s2 - s1);
    expect(s8 - s4).toBeLessThan(s4 - s2);
    // ...and bounded: with b = 0, termScore(tf) = tf * (k1 + 1) / (tf + k1), so
    // termScore(1) = 1 and the limit as tf grows is k1 + 1. Any score is
    // therefore below (k1 + 1) times the tf = 1 score.
    expect(s8 / s1).toBeLessThan(k1 + 1);
  });

  it('ignores the title when titleWeight = 0 and counts it when titleWeight > 0', () => {
    const corpus = [
      { item: 'titled', title: 'zebra', text: 'body text' },
      { item: 'plain', text: 'other words' },
    ];
    expect(LexicalBm25Ranker.fromRecords(corpus, NO_TITLE).query('zebra', 10)).toEqual([]);
    expect(
      LexicalBm25Ranker.fromRecords(corpus, { ...NO_TITLE, titleWeight: 1 }).query('zebra', 10)
        .map((r) => r.item),
    ).toEqual(['titled']);
  });

  it('returns [] for k <= 0 and for an empty corpus', () => {
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'a', text: 'shared term' },
      { item: 'b', text: 'shared other' },
      { item: 'c', text: 'shared again' },
    ], NO_TITLE);
    expect(ranker.query('shared', 0)).toEqual([]);
    // A negative k must not fall through to slice(0, k), which would drop
    // results from the end instead of returning none.
    expect(ranker.query('shared', -1)).toEqual([]);
    expect(LexicalBm25Ranker.fromRecords<string>([], NO_TITLE).query('shared', 5)).toEqual([]);
  });

  it('truncates to k and sorts by descending score', () => {
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'one', text: 'match filler filler filler' },
      { item: 'three', text: 'match match match filler' },
      { item: 'two', text: 'match match filler filler' },
      { item: 'none', text: 'filler filler filler filler' },
    ], NO_TITLE);

    const all = ranker.query('match', 10);
    expect(all.map((r) => r.item)).toEqual(['three', 'two', 'one']);
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1].score).toBeGreaterThan(all[i].score);
    }
    expect(ranker.query('match', 2).map((r) => r.item)).toEqual(['three', 'two']);
  });

  it('defaults to k1 = 1.2, b = 0.75, titleWeight = 3', () => {
    expect(DEFAULT_LEXICAL_BM25_OPTIONS).toEqual({ k1: 1.2, b: 0.75, titleWeight: 3 });
    const corpus = [
      { item: 'a', title: 'apple', text: 'banana apple' },
      { item: 'b', text: 'banana cherry' },
      { item: 'c', text: 'cherry date elderberry fig' },
    ];
    const byDefault = LexicalBm25Ranker.fromRecords(corpus).query('apple cherry', 10);
    const explicit = LexicalBm25Ranker.fromRecords(corpus, { k1: 1.2, b: 0.75, titleWeight: 3 })
      .query('apple cherry', 10);
    expect(byDefault).toEqual(explicit);
    expect(byDefault.every((r) => Number.isFinite(r.score) && r.score > 0)).toBe(true);
  });

  it('adds no phantom tokens for a missing title or token-free text', () => {
    expect(tokenizeLexicalText('')).toEqual([]);
    expect(tokenizeLexicalText('  -- !! ')).toEqual([]);
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'untitled', text: 'body only' },
    ], { k1: 1.2, b: 0.75, titleWeight: 3 });
    // A fallback title must not contribute any searchable term.
    expect(ranker.query('stryker was here', 10)).toEqual([]);
  });
});
