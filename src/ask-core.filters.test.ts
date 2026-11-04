import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import * as path from 'path';

import {
  askKnowledge,
  type RunAskCoreDeps,
} from './ask-core.js';
import { AnswerCache } from './ask-answer-cache.js';

// Issue #974 — metadata filters + neighbor windows on ask_knowledge.
//
// These exercise the ask-side wiring: that the wire-level filter/neighbor
// fields are built into a SimilaritySearchFilters / NeighborContextOptions and
// forwarded to the retrieval legs (dense similaritySearch, hybrid lexical leg)
// and to expandWithNeighborContext, and that an omitted-argument call keeps the
// exact pre-#974 call shape. The actual post-filtering lives in
// search-filters.ts (covered by search-filters.test.ts); here we assert the
// ask path forwards the right objects and that a filtered ask cannot surface a
// chunk the (mocked) retrieval leg excluded.

interface Doc {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

// Point `source` at a real, readable repo file so the sensitivity-policy
// hydration step keeps the doc (an unreadable source is marked no_llm_context
// and dropped from the answer + citations). `relativePath` is the logical path
// we assert citations against.
function doc(relativePath: string, content: string, score: number): Doc {
  return {
    pageContent: content,
    metadata: {
      knowledgeBase: 'ops',
      relativePath,
      source: path.join(process.cwd(), 'src/ask-core.ts'),
      chunkIndex: 0,
    },
    score,
  };
}

interface ManagerOverrides {
  denseResults?: Doc[];
  /** Filter predicate applied to denseResults using the forwarded filters. */
  applyFilters?: (results: Doc[], filters: unknown) => Doc[];
  expandReturn?: Doc[];
}

function makeManager(overrides: ManagerOverrides = {}): {
  similaritySearch: jest.Mock;
  expandWithNeighborContext: jest.Mock;
} & Record<string, unknown> {
  const denseResults = overrides.denseResults ?? [doc('runbooks/a.md', 'Dense answer about rollback.', 0.1)];
  return {
    modelDir: '/tmp/kb-ask-filters-model',
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async (...args: any[]): Promise<Doc[]> => (overrides.applyFilters
      ? overrides.applyFilters(denseResults, args[4])
      : denseResults)),
    expandWithNeighborContext: jest.fn((...args: any[]): Doc[] => overrides.expandReturn ?? (args[0] as Doc[])),
  };
}

function makeDeps(
  manager: ReturnType<typeof makeManager>,
  overrides: Partial<RunAskCoreDeps> = {},
): RunAskCoreDeps {
  return {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest') as RunAskCoreDeps['resolveActiveModel'],
    loadManagerForModel: jest.fn(async () => manager as never),
    loadReadOnlyIndex: jest.fn(async () => {}),
    withWriteLock: (jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action())) as RunAskCoreDeps['withWriteLock'],
    callChatCompletion: (jest.fn(async () => ({ content: 'grounded answer', model: 'qwen3', raw: {} }))) as unknown as RunAskCoreDeps['callChatCompletion'],
    answerCache: new AnswerCache({ enabled: false, indexPath: '/tmp/kb-ask-filters-cache' }),
    ...overrides,
  };
}

describe('ask_knowledge metadata filters + neighbor windows (#974)', () => {
  const prevEndpoint = process.env.KB_LLM_ENDPOINT;

  beforeEach(() => {
    process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
  });

  afterEach(() => {
    if (prevEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
    else process.env.KB_LLM_ENDPOINT = prevEndpoint;
  });

  it('default ask (no filters / no neighbor window) keeps the pre-#974 dense call shape', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    const result = await askKnowledge(
      { query: 'How do we roll back a deploy?', knowledge_base_name: 'ops', search_mode: 'dense', timing: true },
      deps,
    );

    // 5th arg (filters) is undefined and the neighbor expansion never runs.
    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'How do we roll back a deploy?',
      8,
      undefined,
      'ops',
      undefined,
      expect.anything(),
    );
    expect(manager.expandWithNeighborContext).not.toHaveBeenCalled();
    expect(result.retrieval.search_mode).toBe('dense');
    expect(result.citations.map((c) => c.path)).toEqual(['runbooks/a.md']);
  });

  it('forwards every tag / path / recency filter field to the dense retrieval leg', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    await askKnowledge(
      {
        query: 'rollback steps',
        knowledge_base_name: 'ops',
        search_mode: 'dense',
        timing: true,
        path_glob: 'runbooks/**',
        tags: ['runbook'],
        extensions: ['.md'],
        since: '30d',
        until: '1d',
      },
      deps,
    );

    // Exact object (not objectContaining): pins every field so a mutation that
    // drops `until` or swaps `since`/`until` is caught.
    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'rollback steps',
      8,
      undefined,
      'ops',
      { pathGlob: 'runbooks/**', tags: ['runbook'], extensions: ['.md'], since: '30d', until: '1d' },
      expect.anything(),
    );
  });

  it('keeps an until-only ask filtered (active-filter guard covers the until clause)', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    await askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', search_mode: 'dense', until: '1d', timing: true },
      deps,
    );

    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'rollback',
      8,
      undefined,
      'ops',
      expect.objectContaining({ until: '1d' }),
      expect.anything(),
    );
  });

  it('treats empty / whitespace metadata filters as absent (undefined, not an empty object)', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    // Recency bounds are omitted here: an empty-string since/until is a
    // VALIDATION error (parseRecencyFilterRange, same as retrieve_knowledge),
    // not an "absent" value — covered by the malformed-recency test. This pins
    // the extension/tag/path arm of the active-filter guard.
    await askKnowledge(
      {
        query: 'rollback',
        knowledge_base_name: 'ops',
        search_mode: 'dense',
        path_glob: '',
        tags: [],
        extensions: ['   '],
      },
      deps,
    );

    // 5th arg is exactly `undefined` — an all-empty payload must not become a
    // live filter object that would needlessly engage the post-filter path.
    const [, , , , filtersArg] = manager.similaritySearch.mock.calls[0] as unknown[];
    expect(filtersArg).toBeUndefined();
  });

  it('a path-filtered ask does not cite files the filter excludes', async () => {
    // The mocked dense leg honors path_glob, mirroring the real post-filter, so
    // the excluded file never reaches packing or the citation list.
    const manager = makeManager({
      denseResults: [
        doc('runbooks/rollback.md', 'In-scope rollback note.', 0.1),
        doc('notes/scratch.md', 'Out-of-scope scratch note.', 0.2),
      ],
      applyFilters: (results, filters) => {
        const glob = (filters as { pathGlob?: string } | undefined)?.pathGlob;
        if (glob === 'runbooks/**') {
          return results.filter((r) => String(r.metadata.relativePath).startsWith('runbooks/'));
        }
        return results;
      },
    });
    const deps = makeDeps(manager);

    const result = await askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', search_mode: 'dense', path_glob: 'runbooks/**' },
      deps,
    );

    const citedPaths = result.citations.map((c) => c.path);
    expect(citedPaths).toEqual(['runbooks/rollback.md']);
    expect(citedPaths).not.toContain('notes/scratch.md');
  });

  it('expands dense hits with the requested neighbor window and packs the neighbor text', async () => {
    const neighborText = 'NEIGHBOR-CHUNK-SENTINEL around the hit.';
    const manager = makeManager({
      denseResults: [doc('runbooks/a.md', 'Dense hit.', 0.1)],
      // The real expandWithNeighborContext pulls in adjacent chunks; the spy
      // returns the hit plus one neighbor so we can assert it was applied AND
      // that the neighbor's content actually reached the packed LLM prompt.
      expandReturn: [doc('runbooks/a.md', 'Dense hit.', 0.1), doc('runbooks/a.md', neighborText, 0.1)],
    });
    const callChatCompletion = jest.fn(async (..._args: any[]) => ({ content: 'answer', model: 'qwen3', raw: {} }));
    const deps = makeDeps(manager, {
      callChatCompletion: callChatCompletion as unknown as RunAskCoreDeps['callChatCompletion'],
    });

    const result = await askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', search_mode: 'dense', context_window: 2 },
      deps,
    );

    expect(manager.expandWithNeighborContext).toHaveBeenCalledWith(
      expect.any(Array),
      { before: 2, after: 2 },
    );
    // The neighbor chunk is packed as additional evidence...
    expect(result.context_packing.chunks.length).toBe(2);
    // ...and its text crosses into the actual LLM prompt.
    const promptText = JSON.stringify(callChatCompletion.mock.calls[0]?.[0]);
    expect(promptText).toContain(neighborText);
  });

  it('context_after overrides context_window on its side only', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    await askKnowledge(
      {
        query: 'rollback',
        knowledge_base_name: 'ops',
        search_mode: 'dense',
        context_window: 1,
        context_after: 3,
      },
      deps,
    );

    expect(manager.expandWithNeighborContext).toHaveBeenCalledWith(
      expect.any(Array),
      { before: 1, after: 3 },
    );
  });

  it('context_before=0 with context_window=2 keeps before at 0 (?? treats 0 as set, not ||)', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    await askKnowledge(
      {
        query: 'rollback',
        knowledge_base_name: 'ops',
        search_mode: 'dense',
        context_window: 2,
        context_before: 0,
      },
      deps,
    );

    // A `||` mutation would coalesce 0 → 2 here; `??` must keep before=0.
    expect(manager.expandWithNeighborContext).toHaveBeenCalledWith(
      expect.any(Array),
      { before: 0, after: 2 },
    );
  });

  it('rejects a neighbor window with an explicit hybrid search_mode (no retrieval runs)', async () => {
    const manager = makeManager();
    const loadManagerForModel = jest.fn(async () => manager as never);
    const deps = makeDeps(manager, { loadManagerForModel });

    await expect(askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', search_mode: 'hybrid', context_window: 2 },
      deps,
    )).rejects.toThrow(/neighbor context expansion is only supported with dense/i);
    expect(loadManagerForModel).not.toHaveBeenCalled();
    expect(manager.similaritySearch).not.toHaveBeenCalled();
  });

  it('rejects a neighbor window with an explicit lexical search_mode (guard is !== dense, not just hybrid)', async () => {
    const manager = makeManager();
    const loadManagerForModel = jest.fn(async () => manager as never);
    const deps = makeDeps(manager, { loadManagerForModel });

    await expect(askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', search_mode: 'lexical', context_after: 2 },
      deps,
    )).rejects.toThrow(/neighbor context expansion is only supported with dense/i);
    expect(loadManagerForModel).not.toHaveBeenCalled();
  });

  it('rejects a neighbor window when the default "auto" mode resolves to hybrid for a code query', async () => {
    const manager = makeManager();
    const loadManagerForModel = jest.fn(async () => manager as never);
    const deps = makeDeps(manager, { loadManagerForModel });

    // A code/error-token query upgrades auto → hybrid, which cannot neighbor-expand.
    await expect(askKnowledge(
      { query: 'why does src/foo.ts throw TypeError?', knowledge_base_name: 'ops', context_before: 1 },
      deps,
    )).rejects.toThrow(/neighbor context expansion is only supported with dense/i);
    expect(loadManagerForModel).not.toHaveBeenCalled();
  });

  it('allows a neighbor window under default auto for a prose query (auto → dense)', async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);

    // Positive control: prose stays dense under auto, so the window is honored
    // rather than rejected — proving the guard keys on the effective mode.
    await askKnowledge(
      { query: 'How do we roll back a deploy safely?', knowledge_base_name: 'ops', context_window: 1 },
      deps,
    );

    expect(manager.expandWithNeighborContext).toHaveBeenCalledWith(
      expect.any(Array),
      { before: 1, after: 1 },
    );
  });

  it('rejects a malformed recency bound with a recency error, before any retrieval', async () => {
    const manager = makeManager();
    const loadManagerForModel = jest.fn(async () => manager as never);
    const deps = makeDeps(manager, { loadManagerForModel });

    await expect(askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', since: 'not-a-date' },
      deps,
    )).rejects.toThrow(/since|until|recency|date|duration/i);
    expect(loadManagerForModel).not.toHaveBeenCalled();
    expect(manager.similaritySearch).not.toHaveBeenCalled();
  });

  it('forwards filters to BOTH the dense and lexical legs in hybrid mode', async () => {
    const manager = makeManager();
    const listLexicalKbs = jest.fn(async (..._args: any[]) => [{ kbName: 'ops', kbPath: '/tmp/ops' }]);
    const runLexicalLeg = jest.fn(async (..._args: any[]) => ({ hits: [], refreshed: 0, failed: 0 }));
    const deps = makeDeps(manager, {
      listLexicalKbs: listLexicalKbs as unknown as RunAskCoreDeps['listLexicalKbs'],
      runLexicalLeg: runLexicalLeg as unknown as RunAskCoreDeps['runLexicalLeg'],
    });

    await askKnowledge(
      { query: 'rollback', knowledge_base_name: 'ops', search_mode: 'hybrid', path_glob: 'runbooks/**', timing: true },
      deps,
    );

    // Dense over-fetch leg carries the filters (5th positional arg)...
    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'rollback',
      expect.any(Number),
      Number.POSITIVE_INFINITY,
      'ops',
      expect.objectContaining({ pathGlob: 'runbooks/**' }),
      expect.anything(),
    );
    // ...and the BM25 leg applies the same filters before fusion.
    expect(runLexicalLeg).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ pathGlob: 'runbooks/**' }) }),
    );
  });
});
