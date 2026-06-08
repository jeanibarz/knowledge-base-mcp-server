import { describe, expect, it } from '@jest/globals';
import {
  createRuleBasedQueryDecomposer,
  defaultQueryDecompositionBudget,
  queryDecompositionTraceToJson,
  runQueryDecomposition,
} from './query-decomposition.js';
import type { HybridChunk } from './hybrid-retrieval.js';

function chunk(source: string, chunkIndex: number, body: string): HybridChunk {
  return {
    pageContent: body,
    metadata: { source, chunkIndex },
    score: 1,
  };
}

describe('rule-based query decomposition', () => {
  it('splits connective multi-hop questions into deterministic subqueries', async () => {
    const provider = createRuleBasedQueryDecomposer();

    await expect(provider.decompose('Which kinase regulates MAPK and where is it expressed?')).resolves.toEqual([
      'Which kinase regulates MAPK',
      'where is it expressed?',
    ]);
  });
});

describe('runQueryDecomposition', () => {
  it('retrieves each subquery, deduplicates canonical chunks, and stops when sufficient', async () => {
    const calls: string[] = [];
    let now = 0;
    const result = await runQueryDecomposition({
      query: 'Which kinase regulates MAPK and where is it expressed?',
      k: 5,
      budget: defaultQueryDecompositionBudget({ maxSubqueries: 4, maxIterations: 4, maxTotalCandidates: 10 }),
      provider: createRuleBasedQueryDecomposer(),
      nowMs: () => now += 1,
      retrieveSubquery: async (query) => {
        calls.push(query);
        if (query.includes('kinase')) {
          return [chunk('biology.md', 0, 'ERK kinase regulates the MAPK pathway.')];
        }
        return [chunk('biology.md', 1, 'ERK is expressed in epithelial tissue.')];
      },
    });

    expect(calls).toEqual([
      'Which kinase regulates MAPK and where is it expressed?',
      'Which kinase regulates MAPK',
      'where is it expressed?',
    ]);
    expect(result.results.map((hit) => `${hit.metadata.source}:${hit.metadata.chunkIndex}`)).toEqual([
      'biology.md:0',
      'biology.md:1',
    ]);
    expect(result.trace.stopReason).toBe('sufficient');
    expect(result.trace.retrievalCalls).toBe(3);
    expect(result.trace.evidence).toHaveLength(2);
    expect(result.trace.subqueries[1]).toMatchObject({
      query: 'Which kinase regulates MAPK',
      newEvidenceCount: 0,
      redundantEvidenceCount: 1,
    });
    expect(result.trace.evidence[0]?.retrieverQueryCount).toBe(2);
  });

  it('keeps later subquery evidence available when the original query returns a full page', async () => {
    const result = await runQueryDecomposition({
      query: 'original broad question',
      k: 2,
      budget: defaultQueryDecompositionBudget({ maxSubqueries: 3, maxIterations: 3, maxTotalCandidates: 6 }),
      provider: {
        name: 'test',
        decompose: async () => ['hop one', 'hop two'],
        judgeSufficiency: async (_query, evidence) => ({
          sufficient: evidence.some((entry) => entry.content.includes('hop one evidence')) &&
            evidence.some((entry) => entry.content.includes('hop two evidence')),
          missingAspects: [],
        }),
      },
      retrieveSubquery: async (query, remainingCandidateBudget) => {
        expect(remainingCandidateBudget).toBeLessThanOrEqual(2);
        if (query === 'hop one') return [chunk('hop-one.md', 0, 'hop one evidence')];
        if (query === 'hop two') return [chunk('hop-two.md', 0, 'hop two evidence')];
        return [
          chunk('broad.md', 0, 'broad filler 0'),
          chunk('broad.md', 1, 'broad filler 1'),
          chunk('broad.md', 2, 'broad filler 2'),
        ];
      },
    });

    expect(result.trace.stopReason).toBe('sufficient');
    expect(result.trace.evidence.map((entry) => entry.id)).toEqual([
      'broad.md#0',
      'broad.md#1',
      'hop-one.md#0',
      'hop-two.md#0',
    ]);
    expect(result.results.map((hit) => `${hit.metadata.source}:${hit.metadata.chunkIndex}`)).toEqual([
      'hop-one.md:0',
      'hop-two.md:0',
    ]);
  });

  it('records budget stop reasons and JSON trace fields', async () => {
    const result = await runQueryDecomposition({
      query: 'alpha and beta',
      k: 5,
      budget: defaultQueryDecompositionBudget({ maxSubqueries: 3, maxIterations: 1, maxTotalCandidates: 10 }),
      provider: createRuleBasedQueryDecomposer(),
      retrieveSubquery: async () => [chunk('alpha.md', 0, 'alpha only')],
    });

    expect(result.trace.stopReason).toBe('max_iterations');
    expect(queryDecompositionTraceToJson(result.trace)).toMatchObject({
      schema_version: 'kb.search.query-decomposition.v1',
      provider: 'rule',
      stop_reason: 'max_iterations',
      retrieval_calls: 1,
      evidence_groups: [
        expect.objectContaining({
          id: 'alpha.md#0',
          first_seen_subquery: 'alpha and beta',
        }),
      ],
    });
  });
});
