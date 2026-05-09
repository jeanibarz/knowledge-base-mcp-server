// Issue #206 stage 2 — unit + property tests for src/rrf.ts.

import { describe, expect, it } from '@jest/globals';
import { DEFAULT_C, reciprocalRankFusion, type RankedList } from './rrf.js';

describe('reciprocalRankFusion', () => {
  it('returns empty for empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('matches the Cormack formula on a single retriever', () => {
    // Single ranked list: A at rank 1, B at rank 2. With default c=60:
    //   score(A) = 1 / (60 + 1) = 1/61 ≈ 0.01639
    //   score(B) = 1 / (60 + 2) = 1/62 ≈ 0.01613
    const fused = reciprocalRankFusion([
      { retriever: 'dense', results: [{ id: 'A', rank: 1 }, { id: 'B', rank: 2 }] },
    ]);
    expect(fused.map((r) => r.id)).toEqual(['A', 'B']);
    expect(fused[0].fusedScore).toBeCloseTo(1 / (DEFAULT_C + 1), 12);
    expect(fused[1].fusedScore).toBeCloseTo(1 / (DEFAULT_C + 2), 12);
  });

  it('sums contributions across retrievers for a doc that appears in both', () => {
    const lists: RankedList[] = [
      { retriever: 'dense', results: [{ id: 'X', rank: 1 }, { id: 'Y', rank: 2 }] },
      { retriever: 'lexical', results: [{ id: 'Y', rank: 1 }, { id: 'X', rank: 5 }] },
    ];
    const fused = reciprocalRankFusion(lists);
    const yScore = 1 / (DEFAULT_C + 2) + 1 / (DEFAULT_C + 1);
    const xScore = 1 / (DEFAULT_C + 1) + 1 / (DEFAULT_C + 5);
    // Y wins because it appears at rank 1 in lexical AND rank 2 in dense;
    // X has a stronger first-place dense result but a much weaker rank-5
    // lexical contribution.
    expect(fused.map((r) => r.id)).toEqual(['Y', 'X']);
    expect(fused[0].fusedScore).toBeCloseTo(yScore, 12);
    expect(fused[1].fusedScore).toBeCloseTo(xScore, 12);
    expect(fused[0].contributions).toMatchObject({
      dense: 1 / (DEFAULT_C + 2),
      lexical: 1 / (DEFAULT_C + 1),
    });
  });

  it('honors per-retriever weights, including weight=0 to drop a retriever', () => {
    const lists: RankedList[] = [
      { retriever: 'dense', results: [{ id: 'X', rank: 1 }] },
      { retriever: 'lexical', results: [{ id: 'X', rank: 1 }, { id: 'Y', rank: 2 }] },
    ];
    const denseOnly = reciprocalRankFusion(lists, { weights: { dense: 1, lexical: 0 } });
    expect(denseOnly).toHaveLength(1);
    expect(denseOnly[0].id).toBe('X');

    const lexBias = reciprocalRankFusion(lists, { weights: { dense: 0.1, lexical: 2 } });
    expect(lexBias[0].id).toBe('X');
    // weight=2 doubles each lexical contribution
    expect(lexBias[0].contributions.lexical).toBeCloseTo(2 * (1 / (DEFAULT_C + 1)), 12);
  });

  it('falls back to array index when explicit rank is missing', () => {
    // No `rank` field — implicit 1-based from array order.
    const fused = reciprocalRankFusion([
      { retriever: 'dense', results: [{ id: 'A' } as any, { id: 'B' } as any, { id: 'C' } as any] },
    ]);
    expect(fused.map((r) => r.id)).toEqual(['A', 'B', 'C']);
    expect(fused[0].fusedScore).toBeCloseTo(1 / (DEFAULT_C + 1), 12);
    expect(fused[1].fusedScore).toBeCloseTo(1 / (DEFAULT_C + 2), 12);
  });

  it('keeps the BEST rank for within-list duplicates (no double counting)', () => {
    const lists: RankedList[] = [
      { retriever: 'dense', results: [{ id: 'X', rank: 5 }, { id: 'X', rank: 1 }] },
    ];
    const fused = reciprocalRankFusion(lists);
    expect(fused).toHaveLength(1);
    expect(fused[0].fusedScore).toBeCloseTo(1 / (DEFAULT_C + 1), 12);
  });

  it('breaks ties on insertion order across lists', () => {
    // X and Y get identical fused scores. Insertion order is dense→lexical;
    // X first appears in dense, Y first appears in lexical, so X wins ties.
    const lists: RankedList[] = [
      { retriever: 'dense', results: [{ id: 'X', rank: 1 }] },
      { retriever: 'lexical', results: [{ id: 'Y', rank: 1 }] },
    ];
    const fused = reciprocalRankFusion(lists);
    expect(fused.map((r) => r.id)).toEqual(['X', 'Y']);
  });

  it('rejects negative c', () => {
    expect(() => reciprocalRankFusion([], { c: -1 })).toThrow(/c=-1/);
  });

  it('rejects non-finite or negative weights', () => {
    expect(() => reciprocalRankFusion([], { weights: { dense: NaN } })).toThrow(/dense/);
    expect(() => reciprocalRankFusion([], { weights: { dense: -0.5 } })).toThrow(/dense/);
  });

  it('rejects non-positive ranks', () => {
    expect(() =>
      reciprocalRankFusion([{ retriever: 'dense', results: [{ id: 'X', rank: 0 }] }]),
    ).toThrow(/rank=0/);
  });

  // -- property-shaped checks (deterministic, no fast-check dep) ----------------

  it('property: fused score is monotonically non-increasing across the output', () => {
    const lists: RankedList[] = [
      {
        retriever: 'dense',
        results: Array.from({ length: 50 }, (_, i) => ({ id: `D${i}`, rank: i + 1 })),
      },
      {
        retriever: 'lexical',
        // Reverse-rank list to maximize fusion noise.
        results: Array.from({ length: 50 }, (_, i) => ({ id: `D${49 - i}`, rank: i + 1 })),
      },
    ];
    const fused = reciprocalRankFusion(lists);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].fusedScore).toBeGreaterThanOrEqual(fused[i].fusedScore);
    }
  });

  it('property: lower c amplifies first-rank contributions relative to deep ranks', () => {
    const lists: RankedList[] = [
      { retriever: 'dense', results: [{ id: 'A', rank: 1 }, { id: 'B', rank: 50 }] },
    ];
    const cSmall = reciprocalRankFusion(lists, { c: 1 });
    const cLarge = reciprocalRankFusion(lists, { c: 100 });
    const ratioSmall = cSmall[0].fusedScore / cSmall[1].fusedScore;
    const ratioLarge = cLarge[0].fusedScore / cLarge[1].fusedScore;
    expect(ratioSmall).toBeGreaterThan(ratioLarge);
  });

  it('property: weight=0 on every retriever yields empty output', () => {
    const lists: RankedList[] = [
      { retriever: 'dense', results: [{ id: 'A', rank: 1 }] },
      { retriever: 'lexical', results: [{ id: 'A', rank: 1 }] },
    ];
    expect(reciprocalRankFusion(lists, { weights: { dense: 0, lexical: 0 } })).toEqual([]);
  });
});
