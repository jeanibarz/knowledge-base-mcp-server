import { describe, expect, it, jest } from '@jest/globals';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import {
  buildHistoryContext,
  createReplSession,
  formatSourcesBlock,
  parseReplLine,
  runAskRepl,
  type SaveTranscriptInput,
  type SaveTranscriptResult,
} from './ask-repl.js';
import { AnswerCache } from './ask-answer-cache.js';
import type { AskExecutionArgs, AskKnowledgeResult, RunAskCoreDeps } from './ask-core.js';
import type { ChatCompletionOptions, ChatCompletionResult } from './llm-client.js';

const ELIGIBLE_SOURCE = path.join(process.cwd(), 'package.json');

// --- fixtures (mirrors the manager/deps shape in ask-core.test.ts) ----------

function makeManager(): { similaritySearch: jest.Mock } & Record<string, unknown> {
  return {
    modelDir: '/tmp/kb-ask-repl-model',
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async () => [
      {
        pageContent: 'The deploy switched the embedding model.',
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'deploys.md',
          source: ELIGIBLE_SOURCE,
          loc: { lines: { from: 10, to: 18 } },
        },
        score: 0.1234,
      },
    ]),
  };
}

type ChatMock = jest.MockedFunction<(options: ChatCompletionOptions) => Promise<ChatCompletionResult>>;

function staticAnswer(content = 'A grounded answer.'): ChatMock {
  return jest.fn(async () => ({ content, model: 'qwen3', raw: {} })) as unknown as ChatMock;
}

function makeCoreDeps(manager: ReturnType<typeof makeManager>, call: ChatMock): RunAskCoreDeps {
  return {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest') as RunAskCoreDeps['resolveActiveModel'],
    loadManagerForModel: jest.fn(async () => manager as never),
    loadReadOnlyIndex: jest.fn(async () => {}),
    withWriteLock: (jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action())) as RunAskCoreDeps['withWriteLock'],
    callChatCompletion: call as unknown as RunAskCoreDeps['callChatCompletion'],
    answerCache: new AnswerCache({ enabled: false }),
  };
}

function baseArgs(kb?: string): AskExecutionArgs {
  return {
    question: '',
    ...(kb !== undefined ? { kb } : {}),
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    k: 8,
    contextBudgetTokens: 6000,
    refresh: false,
    timing: false,
  };
}

function scripted(lines: string[]): Readable {
  return Readable.from(lines.map((line) => `${line}\n`));
}

function sink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

interface ReplHarness {
  manager: ReturnType<typeof makeManager>;
  call: ChatMock;
  out: ReturnType<typeof sink>;
  err: ReturnType<typeof sink>;
}

async function runScript(
  lines: string[],
  options: {
    kb?: string;
    call?: ChatMock;
    saveTranscript?: (input: SaveTranscriptInput) => Promise<SaveTranscriptResult>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ReplHarness & { code: number }> {
  const manager = makeManager();
  const call = options.call ?? staticAnswer();
  const out = sink();
  const err = sink();
  const code = await runAskRepl({
    baseArgs: baseArgs(options.kb),
    coreDeps: makeCoreDeps(manager, call),
    input: scripted(lines),
    output: out.stream,
    errOutput: err.stream,
    env: options.env ?? { NO_COLOR: '1' },
    ...(options.saveTranscript !== undefined ? { saveTranscript: options.saveTranscript } : {}),
  });
  return { manager, call, out, err, code };
}

// --- pure helpers -----------------------------------------------------------

describe('parseReplLine', () => {
  it('treats non-slash lines as questions and blanks as empty', () => {
    expect(parseReplLine('what changed?')).toEqual({ type: 'question', text: 'what changed?' });
    expect(parseReplLine('   ')).toEqual({ type: 'empty' });
  });

  it('parses meta-commands with and without arguments', () => {
    expect(parseReplLine('/sources')).toEqual({ type: 'sources' });
    expect(parseReplLine('/kb ops')).toEqual({ type: 'kb', name: 'ops' });
    expect(parseReplLine('/kb')).toEqual({ type: 'kb', name: null });
    expect(parseReplLine('/save My Title')).toEqual({ type: 'save', title: 'My Title' });
    expect(parseReplLine('/save')).toEqual({ type: 'save' });
    expect(parseReplLine('/refresh')).toEqual({ type: 'refresh' });
    expect(parseReplLine('/reset')).toEqual({ type: 'reset' });
    expect(parseReplLine('/help')).toEqual({ type: 'help' });
    expect(parseReplLine('/exit')).toEqual({ type: 'exit' });
    expect(parseReplLine('/quit')).toEqual({ type: 'exit' });
  });

  it('flags unknown commands without confusing them for questions', () => {
    expect(parseReplLine('/bogus now')).toEqual({ type: 'unknown', command: 'bogus' });
  });
});

describe('buildHistoryContext', () => {
  it('returns empty for no history and bounds to the most recent turns', () => {
    expect(buildHistoryContext([], 6)).toBe('');
    const turns = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    const ctx = buildHistoryContext(turns, 2);
    expect(ctx).toContain('q3');
    expect(ctx).toContain('q4');
    expect(ctx).not.toContain('q0');
  });
});

describe('formatSourcesBlock', () => {
  it('lists citations, and reports none when empty', () => {
    const withCites = { citations: [{ knowledge_base: 'ops', path: 'deploys.md', score: 0.12, chunk_id: 'c1' }] } as AskKnowledgeResult;
    expect(formatSourcesBlock(withCites)).toContain('ops:deploys.md');
    const empty = { citations: [] } as unknown as AskKnowledgeResult;
    expect(formatSourcesBlock(empty)).toMatch(/none/);
  });
});

describe('createReplSession', () => {
  it('normalizes a blank KB to undefined', () => {
    expect(createReplSession('  ').kb).toBeUndefined();
    expect(createReplSession('ops').kb).toBe('ops');
  });
});

// --- loop behavior ----------------------------------------------------------

describe('runAskRepl loop', () => {
  it('retrieves once and reuses evidence for follow-up turns', async () => {
    const h = await runScript(['first question', 'a follow up', '/exit'], { kb: 'ops' });
    expect(h.code).toBe(0);
    // Retrieval ran once; both turns answered (evidence reused on the follow-up).
    expect(h.manager.similaritySearch).toHaveBeenCalledTimes(1);
    expect(h.call).toHaveBeenCalledTimes(2);
    expect(h.out.text()).toContain('A grounded answer.');
  });

  it('re-retrieves after /refresh', async () => {
    const h = await runScript(['q1', '/refresh', 'q2', '/exit'], { kb: 'ops' });
    expect(h.manager.similaritySearch).toHaveBeenCalledTimes(2);
    expect(h.err.text()).toMatch(/re-retrieves/);
  });

  it('re-retrieves after switching the KB with /kb', async () => {
    const h = await runScript(['q1', '/kb other', 'q2', '/exit'], { kb: 'ops' });
    expect(h.manager.similaritySearch).toHaveBeenCalledTimes(2);
    expect(h.err.text()).toContain('Switched to knowledge base: other');
  });

  it('serves /sources from the last answer and handles unknown commands', async () => {
    const h = await runScript(['q1', '/sources', '/bogus', '/exit'], { kb: 'ops' });
    expect(h.err.text()).toContain('Sources:');
    expect(h.err.text()).toContain('ops:deploys.md');
    expect(h.err.text()).toContain('Unknown command: /bogus');
  });

  it('reports no sources before any question', async () => {
    const h = await runScript(['/sources', '/exit'], { kb: 'ops' });
    expect(h.err.text()).toContain('No sources yet');
    expect(h.manager.similaritySearch).not.toHaveBeenCalled();
  });

  it('/reset clears evidence and history so the next question re-retrieves', async () => {
    const h = await runScript(['q1', '/reset', 'q2', '/exit'], { kb: 'ops' });
    expect(h.err.text()).toContain('Session reset.');
    expect(h.manager.similaritySearch).toHaveBeenCalledTimes(2);
  });

  it('streams answer tokens to stdout when the endpoint streams', async () => {
    const streaming = jest.fn(async (options: ChatCompletionOptions) => {
      if (options.stream) {
        options.stream.onFirstToken?.();
        await options.stream.onToken('AN');
        await options.stream.onToken('SWER');
      }
      return { content: 'ANSWER', model: 'qwen3', raw: {} };
    }) as unknown as ChatMock;
    const h = await runScript(['q1', '/exit'], { kb: 'ops', call: streaming });
    // Streamed once (not double-written from the final content).
    expect(h.out.text()).toBe('ANSWER\n');
  });

  it('keeps the session alive when a turn fails', async () => {
    const flaky = jest.fn<(options: ChatCompletionOptions) => Promise<ChatCompletionResult>>()
      .mockRejectedValueOnce(new Error('llm offline'))
      .mockResolvedValueOnce({ content: 'recovered', model: 'qwen3', raw: {} }) as unknown as ChatMock;
    const h = await runScript(['q1', 'q2', '/exit'], { kb: 'ops', call: flaky });
    expect(h.code).toBe(0);
    expect(h.err.text()).toContain('ask failed: llm offline');
    expect(h.out.text()).toContain('recovered');
  });

  it('honors NO_COLOR by emitting no ANSI escapes in the chrome', async () => {
    const h = await runScript(['q1', '/exit'], { kb: 'ops', env: { NO_COLOR: '1' } });
    // eslint-disable-next-line no-control-regex
    expect(h.err.text()).not.toMatch(/\x1b\[/);
  });

  it('emits an ANSI prompt when color is enabled', async () => {
    const h = await runScript(['/exit'], { kb: 'ops', env: {} });
    // eslint-disable-next-line no-control-regex
    expect(h.err.text()).toMatch(/\x1b\[1m/);
  });
});

describe('runAskRepl /save', () => {
  it('persists the last exchange through the save callback', async () => {
    const saveTranscript = jest.fn(async (input: SaveTranscriptInput): Promise<SaveTranscriptResult> => ({
      kb: input.kb,
      path: 'ask-transcript.md',
    }));
    const h = await runScript(['q1', '/save', '/exit'], { kb: 'ops', saveTranscript });
    expect(saveTranscript).toHaveBeenCalledTimes(1);
    expect(saveTranscript.mock.calls[0]![0]).toMatchObject({ kb: 'ops', question: 'q1' });
    expect(h.err.text()).toContain('Saved transcript: ops:ask-transcript.md');
  });

  it('refuses /save without a knowledge base', async () => {
    const saveTranscript = jest.fn(async (input: SaveTranscriptInput): Promise<SaveTranscriptResult> => ({
      kb: input.kb,
      path: 'x.md',
    }));
    const h = await runScript(['q1', '/save', '/exit'], { saveTranscript });
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(h.err.text()).toContain('needs a knowledge base');
  });

  it('refuses /save before any answer', async () => {
    const h = await runScript(['/save', '/exit'], { kb: 'ops' });
    expect(h.err.text()).toContain('Nothing to save yet');
  });
});
