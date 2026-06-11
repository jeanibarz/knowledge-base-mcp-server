import { describe, expect, it } from '@jest/globals';
import {
  applyHighRecallCandidateFilters,
  highRecallDiagnosticsToJson,
  resolveCandidatePoolK,
} from './high-recall-candidates.js';
import type { HybridChunk } from './hybrid-retrieval.js';

function candidate(source: string, chunkIndex: number, body: string, score = 1): HybridChunk {
  return {
    pageContent: body,
    metadata: { source, chunkIndex },
    score,
  };
}

describe('resolveCandidatePoolK', () => {
  it('keeps the default path opt-out when no pool is supplied', () => {
    expect(resolveCandidatePoolK(10, undefined)).toBeNull();
  });

  it('rejects candidate pools smaller than final k', () => {
    expect(() => resolveCandidatePoolK(10, 5)).toThrow(/candidatePoolK must be >= k/);
  });
});

describe('applyHighRecallCandidateFilters', () => {
  it('collapses byte-near duplicate chunks and records diagnostic groups', () => {
    const input = [
      candidate('a.md', 0, 'Alpha deployment rollback evidence.'),
      candidate('a.md', 1, 'Alpha deployment rollback evidence.'),
      candidate('b.md', 0, 'Alpha deployment canary evidence.'),
    ];
    const out = applyHighRecallCandidateFilters({
      query: 'deployment rollback',
      candidates: input,
      k: 2,
      candidatePoolK: 3,
      lexicalHitIds: new Set(['a.md#0', 'a.md#1', 'b.md#0']),
    });

    expect(out.results.map((hit) => hit.metadata.chunkIndex)).toEqual([0, 0]);
    expect(out.diagnostics.reasonCounts.duplicate_collapse).toBe(1);
    expect(out.diagnostics.collapsedGroups).toEqual([{
      keptId: 'a.md#0',
      collapsedIds: ['a.md#1'],
      source: 'a.md',
      reason: 'duplicate_collapse',
    }]);
  });

  it('caps overrepresented sources after the final-k floor has enough candidates', () => {
    const input = [
      candidate('a.md', 0, 'Alpha rollback one.'),
      candidate('a.md', 1, 'Alpha rollback two.'),
      candidate('b.md', 0, 'Alpha rollback three.'),
      candidate('a.md', 2, 'Alpha rollback four.'),
      candidate('c.md', 0, 'Alpha rollback five.'),
    ];
    const out = applyHighRecallCandidateFilters({
      query: 'alpha rollback',
      candidates: input,
      k: 3,
      candidatePoolK: 5,
      sourceDiversityCap: 2,
      lexicalHitIds: new Set(input.map((hit) => `${hit.metadata.source}#${hit.metadata.chunkIndex}`)),
    });

    expect(out.results.map((hit) => `${hit.metadata.source}:${hit.metadata.chunkIndex}`)).toEqual([
      'a.md:0',
      'a.md:1',
      'b.md:0',
      'c.md:0',
    ]);
    expect(out.diagnostics.reasonCounts.source_diversity_cap).toBe(1);
    expect(out.diagnostics.removed).toEqual([
      expect.objectContaining({ id: 'a.md#2', reason: 'source_diversity_cap' }),
    ]);
  });

  it('filters unanchored candidates when enough anchored candidates remain', () => {
    const input = [
      candidate('a.md', 0, 'Alpha kinase pathway evidence.'),
      candidate('b.md', 0, 'Beta kinase pathway evidence.'),
      candidate('c.md', 0, 'Unrelated weather paragraph.'),
    ];
    const out = applyHighRecallCandidateFilters({
      query: 'kinase pathway',
      candidates: input,
      k: 2,
      candidatePoolK: 3,
    });

    expect(out.results.map((hit) => hit.metadata.source)).toEqual(['a.md', 'b.md']);
    expect(out.diagnostics.reasonCounts.anchor_filter).toBe(1);
    expect(out.diagnostics.anchorFilterRelaxed).toBe(false);
  });

  it('keeps adjacent same-source chunks as cheap neighbor expansion evidence', () => {
    const input = [
      candidate('paper.md', 4, 'Kinase pathway direct anchor.'),
      candidate('paper.md', 5, 'Continuation paragraph without query terms.'),
      candidate('other.md', 0, 'Unrelated weather paragraph.'),
    ];
    const out = applyHighRecallCandidateFilters({
      query: 'kinase pathway',
      candidates: input,
      k: 2,
      candidatePoolK: 3,
    });

    expect(out.results.map((hit) => `${hit.metadata.source}:${hit.metadata.chunkIndex}`)).toEqual([
      'paper.md:4',
      'paper.md:5',
    ]);
    expect(out.diagnostics.neighborExpansionMatches).toBe(1);
    expect(out.diagnostics.reasonCounts.anchor_filter).toBe(1);
  });

  it('reports dense/lexical provenance counts in JSON diagnostics', () => {
    const input = [
      candidate('a.md', 0, 'Alpha evidence.'),
      candidate('b.md', 0, 'Alpha evidence.'),
    ];
    const out = applyHighRecallCandidateFilters({
      query: 'alpha',
      candidates: input,
      k: 1,
      candidatePoolK: 2,
      denseDistanceById: new Map([['a.md#0', 0.1], ['b.md#0', 0.2]]),
      lexicalHitIds: new Set(['b.md#0']),
    });

    expect(highRecallDiagnosticsToJson(out.diagnostics)).toMatchObject({
      schema_version: 'kb.search.high-recall-candidates.v1',
      candidate_pool_k: 2,
      recall_candidates: { dense: 2, lexical: 1, both: 1 },
    });
  });
});
