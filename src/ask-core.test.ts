import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { executeAsk, type AskExecutionArgs, type RunAskCoreDeps } from './ask-core.js';
import { AnswerCache } from './ask-answer-cache.js';

interface ManagerResult {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

function makeManager(content: string): { similaritySearch: jest.Mock } & Record<string, unknown> {
  return {
    modelDir: '/tmp/kb-ask-core-model',
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async (): Promise<ManagerResult[]> => [
      {
        pageContent: content,
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'deploys.md',
          loc: { lines: { from: 10, to: 18 } },
        },
        score: 0.1234,
      },
    ]),
  };
}

function makeDeps(
  answerCache: AnswerCache,
  manager: ReturnType<typeof makeManager>,
  callChatCompletion: jest.Mock,
): RunAskCoreDeps {
  return {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest') as RunAskCoreDeps['resolveActiveModel'],
    loadManagerForModel: jest.fn(async () => manager as never),
    loadReadOnlyIndex: jest.fn(async () => {}),
    withWriteLock: (jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action())) as RunAskCoreDeps['withWriteLock'],
    callChatCompletion: callChatCompletion as unknown as RunAskCoreDeps['callChatCompletion'],
    answerCache,
  };
}

function askArgs(question: string): AskExecutionArgs {
  return {
    question,
    kb: 'ops',
    k: 8,
    contextBudgetTokens: 6000,
    refresh: false,
    timing: true,
  };
}

describe('executeAsk answer cache read-through (#656)', () => {
  let dir: string;
  const prevEndpoint = process.env.KB_LLM_ENDPOINT;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ask-core-'));
    process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
  });

  afterEach(async () => {
    if (prevEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
    else process.env.KB_LLM_ENDPOINT = prevEndpoint;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('serves an identical call from cache and invokes the LLM only once', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'cached answer', model: 'qwen3', raw: {} }));

    const first = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('The deploy switched models.'), call), Date.now());
    expect(first.answer).toBe('cached answer');
    expect((first.timing as Record<string, unknown>).cache).toBe('miss');

    const second = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('The deploy switched models.'), call), Date.now());
    expect(second.answer).toBe('cached answer');
    expect(second.llm.model).toBe('qwen3');
    expect((second.timing as Record<string, unknown>).cache).toBe('hit');

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('misses when the retrieved context changes', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));

    await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Original context.'), call), Date.now());
    const second = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Completely different context.'), call), Date.now());

    expect((second.timing as Record<string, unknown>).cache).toBe('miss');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('is disabled by default — every call invokes the LLM', async () => {
    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));

    const first = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Same context.'), call), Date.now());
    const second = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Same context.'), call), Date.now());

    expect((first.timing as Record<string, unknown>).cache).toBe('disabled');
    expect((second.timing as Record<string, unknown>).cache).toBe('disabled');
    expect(call).toHaveBeenCalledTimes(2);
    expect(await fsp.readdir(path.join(dir, 'cache', 'answers')).catch(() => [])).toEqual([]);
  });
});
