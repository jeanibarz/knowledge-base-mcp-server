import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createLocalLlmQueryDecomposer,
  createRuleBasedQueryDecomposer,
  defaultQueryDecompositionBudget,
  queryDecompositionTraceToJson,
  runQueryDecomposition,
} from './query-decomposition.js';
import type { DecompositionCache } from './decomposition-cache.js';
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

describe('LLM query decomposition cache (#736)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuses a successful result for a normalized query and resolved model', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"subqueries":["hop one","hop two"]}' } }],
      model: 'model-a',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const values = new Map<string, string[]>();
    const get = jest.fn<DecompositionCache['get']>((model, query) =>
      values.get(`${model}:${query.toLowerCase().replace(/\s+/g, ' ')}`)?.slice() ?? null);
    const set = jest.fn<DecompositionCache['set']>((model, query, subqueries) => {
      values.set(`${model}:${query.toLowerCase().replace(/\s+/g, ' ')}`, [...subqueries]);
    });
    const cache: DecompositionCache = {
      get,
      set,
    };
    const provider = createLocalLlmQueryDecomposer(undefined, {
      endpoint: 'http://llm.test',
      model: 'model-a',
      cache,
    });

    await expect(provider.decompose('Multi   hop query')).resolves.toEqual(['hop one', 'hop two']);
    await expect(provider.decompose('multi hop query')).resolves.toEqual(['hop one', 'hop two']);
    expect(get).toHaveBeenNthCalledWith(1, 'model-a', 'Multi   hop query');
    expect(set).toHaveBeenCalledWith('model-a', 'Multi   hop query', ['hop one', 'hop two']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches provider failures, invalid responses, or offline fallback results', async () => {
    const fallback = createRuleBasedQueryDecomposer();
    const cache: DecompositionCache = {
      get: jest.fn<DecompositionCache['get']>().mockReturnValue(null),
      set: jest.fn<DecompositionCache['set']>(),
    };
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"subqueries":[]}' } }],
        model: 'model-a',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = createLocalLlmQueryDecomposer(fallback, {
      endpoint: 'http://llm.test',
      model: 'model-a',
      cache,
    });

    await provider.decompose('alpha and beta');
    await provider.decompose('alpha and beta');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('keeps protected and unverifiable evidence out of sufficiency prompts', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-query-decomposition-policy-'));
    try {
      const protectedSource = path.join(tempDir, 'protected.md');
      const publicSource = path.join(tempDir, 'public.md');
      await fsp.writeFile(protectedSource, [
        '---',
        'kb_policy:',
        '  no_llm_context: true',
        '---',
        'secret evidence',
      ].join('\n'));
      await fsp.writeFile(publicSource, 'public evidence');

      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"sufficient":true,"missing_aspects":[]}' } }],
          model: 'model-a',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      const provider = createLocalLlmQueryDecomposer(undefined, {
        endpoint: 'http://llm.test',
        model: 'model-a',
      });

      await expect(provider.judgeSufficiency('what is documented?', [
        {
          id: 'protected',
          source: protectedSource,
          chunkIndex: 0,
          score: 0.1,
          firstSeenSubquery: 'what is documented?',
          retrieverQueryCount: 1,
          content: 'secret evidence',
          metadata: { source: protectedSource },
        },
        {
          id: 'public',
          source: publicSource,
          chunkIndex: 0,
          score: 0.2,
          firstSeenSubquery: 'what is documented?',
          retrieverQueryCount: 1,
          content: 'public evidence',
          metadata: { source: publicSource },
        },
        {
          id: 'missing',
          source: path.join(tempDir, 'missing.md'),
          chunkIndex: 0,
          score: 0.3,
          firstSeenSubquery: 'what is documented?',
          retrieverQueryCount: 1,
          content: 'unverifiable evidence',
          metadata: { source: path.join(tempDir, 'missing.md') },
        },
      ], [])).resolves.toEqual({ sufficient: true, missingAspects: [] });

      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as {
        messages?: Array<{ content?: string }>;
      };
      const prompt = body.messages?.[1]?.content ?? '';
      expect(prompt).toContain('public evidence');
      expect(prompt).not.toContain('secret evidence');
      expect(prompt).not.toContain('unverifiable evidence');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
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
