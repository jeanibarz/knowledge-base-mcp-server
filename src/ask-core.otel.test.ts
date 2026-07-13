import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { executeAsk, type AskExecutionArgs, type RunAskCoreDeps } from './ask-core.js';
import { AnswerCache } from './ask-answer-cache.js';
import {
  resetOtelForTesting,
  setOtelTracerForTesting,
  type OtelSpanLike,
  type OtelTracerLike,
} from './otel-trace.js';

interface RecordedSpan {
  name: string;
  parent: string | null;
  attributes: Record<string, unknown>;
  ended: boolean;
}

function makeFakeTracer(): { tracer: OtelTracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const stack: RecordedSpan[] = [];
  const tracer: OtelTracerLike = {
    startActiveSpan<T>(name: string, fn: (span: OtelSpanLike) => T): T {
      const span: RecordedSpan = {
        name,
        parent: stack.length > 0 ? stack[stack.length - 1].name : null,
        attributes: {},
        ended: false,
      };
      spans.push(span);
      stack.push(span);
      const handle: OtelSpanLike = {
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        setStatus() { /* unused */ },
        recordException() { /* unused */ },
        end() {
          span.ended = true;
          const index = stack.lastIndexOf(span);
          if (index >= 0) stack.splice(index, 1);
        },
      };
      return fn(handle);
    },
  };
  return { tracer, spans };
}

interface ManagerResult {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

function makeManager(content: string): Record<string, unknown> {
  return {
    modelDir: '/tmp/kb-ask-otel-model',
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async (): Promise<ManagerResult[]> => [
      {
        pageContent: content,
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'deploys.md',
          source: path.join(process.cwd(), 'package.json'),
        },
        score: 0.1234,
      },
    ]),
  };
}

function makeDeps(
  answerCache: AnswerCache,
  manager: Record<string, unknown>,
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
    timing: false,
  };
}

describe('executeAsk OpenTelemetry spans (#647)', () => {
  let dir: string;
  const prevEndpoint = process.env.KB_LLM_ENDPOINT;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ask-otel-'));
    process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
  });

  afterEach(async () => {
    resetOtelForTesting();
    if (prevEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
    else process.env.KB_LLM_ENDPOINT = prevEndpoint;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('emits a nested root + stage span tree when tracing is enabled', async () => {
    const { tracer, spans } = makeFakeTracer();
    setOtelTracerForTesting(tracer);

    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'an answer', model: 'qwen3', raw: {} }));
    const result = await executeAsk(askArgs('How did the deploy change?'), makeDeps(cache, makeManager('The deploy switched models.'), call), Date.now());

    expect(result.answer).toBe('an answer');

    const byName = new Map(spans.map((s) => [s.name, s]));
    // Root + the dense/format/llm pipeline stages are present.
    expect(byName.has('kb.ask')).toBe(true);
    expect(byName.has('kb.ask.retrieve')).toBe(true);
    expect(byName.has('kb.ask.dense')).toBe(true);
    expect(byName.has('kb.ask.format')).toBe(true);
    expect(byName.has('kb.ask.llm')).toBe(true);

    // Nesting: retrieve under ask; dense under retrieve; format/llm under ask.
    expect(byName.get('kb.ask')?.parent).toBeNull();
    expect(byName.get('kb.ask.retrieve')?.parent).toBe('kb.ask');
    expect(byName.get('kb.ask.dense')?.parent).toBe('kb.ask.retrieve');
    expect(byName.get('kb.ask.format')?.parent).toBe('kb.ask');
    expect(byName.get('kb.ask.llm')?.parent).toBe('kb.ask');

    // Canonical-style attributes are attached; every span is closed.
    expect(byName.get('kb.ask')?.attributes).toMatchObject({ 'kb.scope': 'ops', 'kb.k': 8 });
    expect(byName.get('kb.ask.retrieve')?.attributes).toMatchObject({ 'kb.search_mode': 'dense' });
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it('never puts the query text or chunk content in any span attribute', async () => {
    const { tracer, spans } = makeFakeTracer();
    setOtelTracerForTesting(tracer);

    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'an answer', model: 'qwen3', raw: {} }));
    const query = 'a uniquely identifiable secret query string';
    const chunk = 'a uniquely identifiable secret chunk body';
    await executeAsk(askArgs(query), makeDeps(cache, makeManager(chunk), call), Date.now());

    const allValues = spans.flatMap((s) => Object.values(s.attributes).map(String));
    expect(allValues.some((v) => v.includes('secret query'))).toBe(false);
    expect(allValues.some((v) => v.includes('secret chunk'))).toBe(false);
  });

  it('adds no spans and behaves identically when tracing is disabled', async () => {
    setOtelTracerForTesting(null);

    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const call = jest.fn(async () => ({ content: 'an answer', model: 'qwen3', raw: {} }));
    const result = await executeAsk(askArgs('What changed?'), makeDeps(cache, makeManager('The deploy switched models.'), call), Date.now());

    expect(result.answer).toBe('an answer');
    expect(result.citations.length).toBeGreaterThan(0);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
