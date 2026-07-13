import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import * as path from 'path';

import {
  executeAsk,
  type AskExecutionArgs,
  type RunAskCoreDeps,
} from './ask-core.js';
import { AnswerCache } from './ask-answer-cache.js';
import { hybridFetchK } from './hybrid-retrieval.js';
import { setRerankerFactoryForTests } from './reranker.js';

interface Doc {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

function denseDoc(source: string, content: string, score: number): Doc {
  const policySource = source.endsWith('/a.md')
    ? path.join(process.cwd(), 'src/ask-core.ts')
    : source.endsWith('/b.md')
      ? path.join(process.cwd(), 'src/ask-core.test.ts')
      : path.join(process.cwd(), 'src/ask-core.hybrid.test.ts');
  return {
    pageContent: content,
    metadata: { knowledgeBase: 'ops', relativePath: source, source: policySource, chunkIndex: 0 },
    score,
  };
}

function makeManager(denseResults: Doc[]): { similaritySearch: jest.Mock } & Record<string, unknown> {
  return {
    modelDir: '/tmp/kb-ask-hybrid-model',
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async () => denseResults),
  };
}

interface HybridDepsOverrides {
  manager: ReturnType<typeof makeManager>;
  lexicalHits?: Doc[];
  listLexicalKbs?: jest.Mock;
  runLexicalLeg?: jest.Mock;
  callChatCompletion?: jest.Mock;
}

function makeDeps(overrides: HybridDepsOverrides): RunAskCoreDeps {
  const listLexicalKbs = overrides.listLexicalKbs
    ?? jest.fn(async () => [{ kbName: 'ops', kbPath: '/tmp/ops' }]);
  const runLexicalLeg = overrides.runLexicalLeg
    ?? jest.fn(async () => ({ hits: overrides.lexicalHits ?? [], refreshed: 0, failed: 0 }));
  const callChatCompletion = overrides.callChatCompletion
    ?? jest.fn(async () => ({ content: 'grounded answer', model: 'qwen3', raw: {} }));
  return {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest') as RunAskCoreDeps['resolveActiveModel'],
    loadManagerForModel: jest.fn(async () => overrides.manager as never),
    loadReadOnlyIndex: jest.fn(async () => {}),
    withWriteLock: (jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action())) as RunAskCoreDeps['withWriteLock'],
    callChatCompletion: callChatCompletion as unknown as RunAskCoreDeps['callChatCompletion'],
    answerCache: new AnswerCache({ enabled: false, indexPath: '/tmp/kb-ask-hybrid-cache' }),
    listLexicalKbs: listLexicalKbs as unknown as RunAskCoreDeps['listLexicalKbs'],
    runLexicalLeg: runLexicalLeg as unknown as RunAskCoreDeps['runLexicalLeg'],
  };
}

function askArgs(question: string, overrides: Partial<AskExecutionArgs> = {}): AskExecutionArgs {
  return {
    question,
    kb: 'ops',
    k: 8,
    contextBudgetTokens: 6000,
    refresh: false,
    timing: true,
    ...overrides,
  };
}

describe('ask retrieval modes (#732)', () => {
  const prevEndpoint = process.env.KB_LLM_ENDPOINT;
  const prevRerank = process.env.KB_RERANK;

  beforeEach(() => {
    process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
    delete process.env.KB_RERANK;
  });

  afterEach(() => {
    if (prevEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
    else process.env.KB_LLM_ENDPOINT = prevEndpoint;
    if (prevRerank === undefined) delete process.env.KB_RERANK;
    else process.env.KB_RERANK = prevRerank;
  });

  it('mode=hybrid reaches the hybrid retrieval leg (dense over-fetch + lexical fusion)', async () => {
    const manager = makeManager([denseDoc('runbooks/a.md', 'Dense hit about rollback.', 0.1)]);
    const listLexicalKbs = jest.fn(async () => [{ kbName: 'ops', kbPath: '/tmp/ops' }]);
    const runLexicalLeg = jest.fn(async () => ({
      hits: [denseDoc('runbooks/b.md', 'Lexical hit about rollback.', 3.2)],
      refreshed: 0,
      failed: 0,
    }));
    const deps = makeDeps({ manager, listLexicalKbs, runLexicalLeg });

    const result = await executeAsk(askArgs('What changed?', { searchMode: 'hybrid' }), deps, Date.now());

    expect(result.retrieval.search_mode).toBe('hybrid');
    // Dense leg over-fetches with an unbounded threshold to give RRF room.
    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'What changed?',
      hybridFetchK(8),
      Number.POSITIVE_INFINITY,
      'ops',
      undefined,
      expect.anything(),
    );
    expect(listLexicalKbs).toHaveBeenCalledWith('ops');
    expect(runLexicalLeg).toHaveBeenCalledTimes(1);
    // Both legs' chunks are fused into the cited evidence.
    const citedPaths = result.citations.map((c) => c.path).sort();
    expect(citedPaths).toEqual(['runbooks/a.md', 'runbooks/b.md']);
  });

  it('mode=lexical runs the BM25 leg only (no dense FAISS search)', async () => {
    const manager = makeManager([]);
    const runLexicalLeg = jest.fn(async () => ({
      hits: [denseDoc('runbooks/only.md', 'Lexical-only hit.', 4.0)],
      refreshed: 0,
      failed: 0,
    }));
    const deps = makeDeps({ manager, runLexicalLeg });

    const result = await executeAsk(askArgs('INDEX_NOT_INITIALIZED', { searchMode: 'lexical' }), deps, Date.now());

    expect(result.retrieval.search_mode).toBe('lexical');
    expect(manager.similaritySearch).not.toHaveBeenCalled();
    expect(runLexicalLeg).toHaveBeenCalledTimes(1);
    expect(result.citations.map((c) => c.path)).toEqual(['runbooks/only.md']);
  });

  it('default mode stays dense for a prose query (backward compatible)', async () => {
    const manager = makeManager([denseDoc('runbooks/a.md', 'Dense answer.', 0.1)]);
    const listLexicalKbs = jest.fn(async () => [{ kbName: 'ops', kbPath: '/tmp/ops' }]);
    const runLexicalLeg = jest.fn(async () => ({ hits: [], refreshed: 0, failed: 0 }));
    const deps = makeDeps({ manager, listLexicalKbs, runLexicalLeg });

    const result = await executeAsk(askArgs('What changed during the deploy?'), deps, Date.now());

    expect(result.retrieval.search_mode).toBe('dense');
    // Dense signature: bounded top-k, no threshold, no lexical leg.
    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'What changed during the deploy?',
      8,
      undefined,
      'ops',
      undefined,
      expect.anything(),
    );
    expect(listLexicalKbs).not.toHaveBeenCalled();
    expect(runLexicalLeg).not.toHaveBeenCalled();
  });

  it('default mode=auto upgrades a code/error-token query to hybrid', async () => {
    const manager = makeManager([denseDoc('src/foo.md', 'Dense hit.', 0.1)]);
    const runLexicalLeg = jest.fn(async () => ({
      hits: [denseDoc('src/bar.md', 'Lexical hit.', 2.0)],
      refreshed: 0,
      failed: 0,
    }));
    const deps = makeDeps({ manager, runLexicalLeg });

    const result = await executeAsk(askArgs('why does src/foo.ts throw TypeError?'), deps, Date.now());

    expect(result.retrieval.search_mode).toBe('hybrid');
    expect(runLexicalLeg).toHaveBeenCalledTimes(1);
  });
});

describe('ask reranking is opt-in (#732)', () => {
  const prevEndpoint = process.env.KB_LLM_ENDPOINT;
  const prevRerank = process.env.KB_RERANK;
  let restoreReranker: (() => void) | null = null;
  let rerankSpy: jest.Mock<(query: string, candidates: string[]) => Promise<number[]>>;

  beforeEach(() => {
    process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
    delete process.env.KB_RERANK;
    rerankSpy = jest.fn<(query: string, candidates: string[]) => Promise<number[]>>(
      async (_query, candidates) => candidates.map((_c, index) => candidates.length - index),
    );
    restoreReranker = setRerankerFactoryForTests(async () => ({
      id: 'test-cross-encoder',
      rerank: rerankSpy,
    }));
  });

  afterEach(() => {
    restoreReranker?.();
    restoreReranker = null;
    if (prevEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
    else process.env.KB_LLM_ENDPOINT = prevEndpoint;
    if (prevRerank === undefined) delete process.env.KB_RERANK;
    else process.env.KB_RERANK = prevRerank;
  });

  it('does not rerank hybrid retrieval by default', async () => {
    const manager = makeManager([denseDoc('runbooks/a.md', 'Dense hit.', 0.1)]);
    const deps = makeDeps({
      manager,
      runLexicalLeg: jest.fn(async () => ({
        hits: [denseDoc('runbooks/b.md', 'Lexical hit.', 2.0)],
        refreshed: 0,
        failed: 0,
      })),
    });

    await executeAsk(askArgs('What changed?', { searchMode: 'hybrid' }), deps, Date.now());

    expect(rerankSpy).not.toHaveBeenCalled();
  });

  it('reranks hybrid retrieval when rerank=on is requested', async () => {
    const manager = makeManager([denseDoc('runbooks/a.md', 'Dense hit.', 0.1)]);
    const deps = makeDeps({
      manager,
      runLexicalLeg: jest.fn(async () => ({
        hits: [denseDoc('runbooks/b.md', 'Lexical hit.', 2.0)],
        refreshed: 0,
        failed: 0,
      })),
    });

    const result = await executeAsk(
      askArgs('What changed?', { searchMode: 'hybrid', rerank: 'on' }),
      deps,
      Date.now(),
    );

    expect(rerankSpy).toHaveBeenCalledTimes(1);
    expect(result.retrieval.rerank).toBe('on');
  });
});
