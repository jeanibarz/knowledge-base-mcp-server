import { describe, expect, it } from '@jest/globals';
import type { SearchResultDocument } from './FaissIndexManager.js';
import {
  applyAdvancedRetrieval,
  computeAdvancedCandidateK,
  filterAdvancedRetrievalMetadata,
  hasAdvancedRetrieval,
} from './advanced-retrieval.js';

function doc(id: string, source: string, content: string, score: number): SearchResultDocument {
  return {
    pageContent: content,
    metadata: {
      source: `/kb/${source}`,
      relativePath: source,
      chunkIndex: Number(id),
    },
    score,
  };
}

describe('advanced retrieval operators', () => {
  it('detects when advanced search flags are active', () => {
    expect(hasAdvancedRetrieval({
      diverse: false,
      plusQueries: [],
      antiQueries: [],
      minusQueries: [],
    })).toBe(false);
    expect(hasAdvancedRetrieval({
      diverse: true,
      plusQueries: [],
      antiQueries: [],
      minusQueries: [],
    })).toBe(true);
  });

  it('uses a bounded overfetch pool for reranking', () => {
    expect(computeAdvancedCandidateK(3)).toBe(20);
    expect(computeAdvancedCandidateK(30)).toBe(100);
    expect(computeAdvancedCandidateK(200)).toBe(200);
  });

  it('diversifies away from duplicate sources while preserving relevance support', () => {
    const nearA = doc('1', 'ops/a.md', 'rollback deploy safety runbook', 0.1);
    const nearADuplicate = doc('2', 'ops/a.md', 'rollback deploy safety checklist', 0.11);
    const representativeB = doc('3', 'ops/b.md', 'rollback incident escalation evidence', 0.12);

    const out = applyAdvancedRetrieval([
      { role: 'primary', query: 'rollback', results: [nearA, nearADuplicate, representativeB] },
    ], {
      k: 2,
      candidateK: 20,
      diverse: true,
      plusQueries: [],
      antiQueries: [],
      minusQueries: [],
    });

    expect(out.results.map((result) => result.metadata.relativePath)).toEqual([
      'ops/a.md',
      'ops/b.md',
    ]);
    expect(out.metadata.mode).toBe('diverse');
    expect(out.metadata.constraints.requires_positive_support).toBe(true);
  });

  it('penalizes anti-query matches without admitting negative-only candidates', () => {
    const relevant = doc('1', 'ops/relevant.md', 'agent evidence queue triage', 0.1);
    const tooCloseToAnti = doc('2', 'ops/ui.md', 'agent evidence visual component styling', 0.12);
    const negativeOnly = doc('3', 'ops/negative-only.md', 'visual component css palette', 0.05);

    const out = applyAdvancedRetrieval([
      { role: 'primary', query: 'agent evidence', results: [tooCloseToAnti, relevant] },
      { role: 'anti_query', query: 'visual component styling', results: [negativeOnly, tooCloseToAnti] },
    ], {
      k: 2,
      candidateK: 20,
      diverse: false,
      plusQueries: [],
      antiQueries: ['visual component styling'],
      minusQueries: [],
    });

    expect(out.results.map((result) => result.metadata.relativePath)).toEqual([
      'ops/relevant.md',
      'ops/ui.md',
    ]);
    expect(out.results).not.toContain(negativeOnly);
    expect(out.metadata.mode).toBe('contrastive');
    expect(out.metadata.constraints.anti_query_guard).toContain('no raw farthest-neighbor search');
    expect(out.metadata.result_signals[0].negative_similarity).toBe(0);
    expect(out.metadata.result_signals[1].negative_similarity).toBeGreaterThan(0);
  });

  it('combines positive and negative query components for composed exploration', () => {
    const primary = doc('1', 'ops/primary.md', 'queue debt triage', 0.1);
    const plusSupported = doc('2', 'ops/slow-loop.md', 'slow loop queue review debt', 0.4);

    const out = applyAdvancedRetrieval([
      { role: 'primary', query: 'queue debt', results: [primary, plusSupported] },
      { role: 'plus', query: 'slow loop review', results: [plusSupported] },
      { role: 'minus', query: 'frontend layout', results: [primary] },
    ], {
      k: 1,
      candidateK: 20,
      diverse: false,
      plusQueries: ['slow loop review'],
      antiQueries: [],
      minusQueries: ['frontend layout'],
    });

    expect(out.results[0].metadata.relativePath).toBe('ops/slow-loop.md');
    expect(out.metadata.mode).toBe('composed');
    expect(out.metadata.query_components.map((component) => component.role)).toEqual([
      'primary',
      'plus',
      'minus',
    ]);
  });

  it('keeps result signals aligned with post-gate results', () => {
    const keep = doc('1', 'ops/keep.md', 'kept candidate', 0.1);
    const drop = doc('2', 'ops/drop.md', 'dropped candidate', 0.2);
    const out = applyAdvancedRetrieval([
      { role: 'primary', query: 'candidate', results: [keep, drop] },
    ], {
      k: 2,
      candidateK: 20,
      diverse: false,
      plusQueries: [],
      antiQueries: [],
      minusQueries: [],
    });

    const filtered = filterAdvancedRetrievalMetadata(out.metadata, [keep]);

    expect(filtered.result_signals.map((signal) => signal.source)).toEqual([
      'ops/keep.md',
    ]);
  });
});
