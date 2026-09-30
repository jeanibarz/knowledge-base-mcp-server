import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  executeAsk,
  resolveAskLlmTimeoutMs,
  DEFAULT_ASK_LLM_TIMEOUT_MS,
  MAX_ASK_LLM_TIMEOUT_MS,
  type AskExecutionArgs,
  type RunAskCoreDeps,
} from './ask-core.js';
import { AnswerCache } from './ask-answer-cache.js';
import { LlmCallMetrics } from './metrics.js';

interface ManagerResult {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

function makeManager(
  content: string,
  source: string | undefined,
  frontmatter: Record<string, unknown> = {},
): { similaritySearch: jest.Mock } & Record<string, unknown> {
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
          ...(source !== undefined ? { source } : {}),
          frontmatter,
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
  llmMetrics: LlmCallMetrics = new LlmCallMetrics(),
): RunAskCoreDeps {
  return {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest') as RunAskCoreDeps['resolveActiveModel'],
    loadManagerForModel: jest.fn(async () => manager as never),
    loadReadOnlyIndex: jest.fn(async () => {}),
    withWriteLock: (jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action())) as RunAskCoreDeps['withWriteLock'],
    callChatCompletion: callChatCompletion as unknown as RunAskCoreDeps['callChatCompletion'],
    answerCache,
    llmMetrics,
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
    await fsp.writeFile(path.join(dir, 'deploys.md'), '# Deploys\n', 'utf-8');
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
    const llmMetrics = new LlmCallMetrics();

    const source = path.join(dir, 'deploys.md');
    const first = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('The deploy switched models.', source), call, llmMetrics), Date.now());
    expect(first.answer).toBe('cached answer');
    expect((first.timing as Record<string, unknown>).cache).toBe('miss');

    const second = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('The deploy switched models.', source), call, llmMetrics), Date.now());
    expect(second.answer).toBe('cached answer');
    expect(second.llm.model).toBe('qwen3');
    expect((second.timing as Record<string, unknown>).cache).toBe('hit');

    expect(call).toHaveBeenCalledTimes(1);
    expect(llmMetrics.snapshot().ask).toMatchObject({
      count: 0,
      cache_outcomes: { hit: 1, miss: 1 },
      answer_impact: { used: 2 },
    });
  });

  it('misses when the retrieved context changes', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));
    const source = path.join(dir, 'deploys.md');

    await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Original context.', source), call), Date.now());
    const second = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Completely different context.', source), call), Date.now());

    expect((second.timing as Record<string, unknown>).cache).toBe('miss');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('is disabled by default — every call invokes the LLM', async () => {
    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));
    const source = path.join(dir, 'deploys.md');

    const first = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Same context.', source), call), Date.now());
    const second = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('Same context.', source), call), Date.now());

    expect((first.timing as Record<string, unknown>).cache).toBe('disabled');
    expect((second.timing as Record<string, unknown>).cache).toBe('disabled');
    expect(call).toHaveBeenCalledTimes(2);
    expect(await fsp.readdir(path.join(dir, 'cache', 'answers')).catch(() => [])).toEqual([]);
  });

  it('rechecks the source policy when indexed metadata is stale', async () => {
    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));
    const source = path.join(dir, 'deploys.md');
    await fsp.writeFile(source, '---\nkb_policy:\n  no_llm_context: true\n---\nSecret deploy details\n', 'utf-8');

    const result = await executeAsk(
      askArgs('What changed?'),
      makeDeps(
        cache,
        makeManager(
          'Secret deploy details',
          source,
          { kb_policy: { no_llm_context: false } },
        ),
        call,
      ),
      Date.now(),
    );

    expect(result.context_packing.policy_filtered_chunks).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    const callArgs = call.mock.calls as unknown as Array<[unknown]>;
    expect(JSON.stringify(callArgs[0][0])).not.toContain('Secret deploy details');
  });

  it('fails closed when retrieved evidence has no source provenance', async () => {
    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));

    const result = await executeAsk(
      askArgs('What changed?'),
      makeDeps(cache, makeManager('Unverified private context', undefined), call),
      Date.now(),
    );

    expect(result.context_packing).toMatchObject({
      included_chunks: 0,
      excluded_chunks: 1,
      policy_filtered_chunks: 1,
    });
    const callArgs = call.mock.calls as unknown as Array<[unknown]>;
    expect(JSON.stringify(callArgs[0][0])).not.toContain('Unverified private context');
  });

  it('passes the resolved KB_ASK_LLM_TIMEOUT_MS on the ask-generation call (#889)', async () => {
    const prev = process.env.KB_ASK_LLM_TIMEOUT_MS;
    process.env.KB_ASK_LLM_TIMEOUT_MS = '4500';
    try {
      const cache = new AnswerCache({ enabled: false, indexPath: dir });
      const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));
      const source = path.join(dir, 'deploys.md');

      await executeAsk(
        askArgs('What changed?'),
        makeDeps(cache, makeManager('The deploy switched models.', source), call),
        Date.now(),
      );

      expect(call).toHaveBeenCalledTimes(1);
      const callArgs = call.mock.calls as unknown as Array<[{ timeoutMs?: number }]>;
      expect(callArgs[0][0].timeoutMs).toBe(4500);
    } finally {
      if (prev === undefined) delete process.env.KB_ASK_LLM_TIMEOUT_MS;
      else process.env.KB_ASK_LLM_TIMEOUT_MS = prev;
    }
  });

  it('passes the default timeout on the ask-generation call when unset (#889)', async () => {
    const prev = process.env.KB_ASK_LLM_TIMEOUT_MS;
    delete process.env.KB_ASK_LLM_TIMEOUT_MS;
    try {
      const cache = new AnswerCache({ enabled: false, indexPath: dir });
      const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));
      const source = path.join(dir, 'deploys.md');

      await executeAsk(
        askArgs('What changed?'),
        makeDeps(cache, makeManager('The deploy switched models.', source), call),
        Date.now(),
      );

      const callArgs = call.mock.calls as unknown as Array<[{ timeoutMs?: number }]>;
      // Pin both the constant and its literal value so a wrong default is caught here.
      expect(callArgs[0][0].timeoutMs).toBe(DEFAULT_ASK_LLM_TIMEOUT_MS);
      expect(callArgs[0][0].timeoutMs).toBe(120_000);
    } finally {
      if (prev === undefined) delete process.env.KB_ASK_LLM_TIMEOUT_MS;
      else process.env.KB_ASK_LLM_TIMEOUT_MS = prev;
    }
  });

  it('still passes the timeout on the streaming ask-generation call (#889)', async () => {
    const prev = process.env.KB_ASK_LLM_TIMEOUT_MS;
    process.env.KB_ASK_LLM_TIMEOUT_MS = '7000';
    try {
      const cache = new AnswerCache({ enabled: false, indexPath: dir });
      const call = jest.fn(async () => ({ content: 'answer', model: 'qwen3', raw: {} }));
      const source = path.join(dir, 'deploys.md');

      await executeAsk(
        { ...askArgs('What changed?'), onAnswerToken: () => {} },
        makeDeps(cache, makeManager('The deploy switched models.', source), call),
        Date.now(),
      );

      const callArgs = call.mock.calls as unknown as Array<[{ timeoutMs?: number; stream?: unknown }]>;
      // The deadline must accompany the streaming path too — llm-client re-arms it
      // per token (idle-reset), so its presence is what keeps that behavior bounded.
      expect(callArgs[0][0].timeoutMs).toBe(7000);
      expect(callArgs[0][0].stream).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.KB_ASK_LLM_TIMEOUT_MS;
      else process.env.KB_ASK_LLM_TIMEOUT_MS = prev;
    }
  });
});

describe('resolveAskLlmTimeoutMs (#889)', () => {
  it('defaults to 120000ms when unset or empty', () => {
    expect(DEFAULT_ASK_LLM_TIMEOUT_MS).toBe(120_000);
    expect(resolveAskLlmTimeoutMs({})).toBe(120_000);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '' })).toBe(120_000);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '   ' })).toBe(120_000);
  });

  it('honors a positive integer override', () => {
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '1' })).toBe(1);
  });

  it('falls back to the default for non-positive, non-integer, or non-numeric values', () => {
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '0' })).toBe(120_000);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '-500' })).toBe(120_000);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '1.5' })).toBe(120_000);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: 'abc' })).toBe(120_000);
  });

  it('clamps a value above the Node 32-bit timer ceiling instead of overflowing to 1ms', () => {
    // 2^31 overflows Node's setTimeout and would silently become a 1ms abort.
    expect(MAX_ASK_LLM_TIMEOUT_MS).toBe(2_147_483_647);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '2147483648' })).toBe(MAX_ASK_LLM_TIMEOUT_MS);
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: '999999999999' })).toBe(MAX_ASK_LLM_TIMEOUT_MS);
    // At-or-below the ceiling passes through unchanged.
    expect(resolveAskLlmTimeoutMs({ KB_ASK_LLM_TIMEOUT_MS: String(MAX_ASK_LLM_TIMEOUT_MS) })).toBe(MAX_ASK_LLM_TIMEOUT_MS);
  });
});
