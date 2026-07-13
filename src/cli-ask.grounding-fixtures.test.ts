import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createAskTranscriptNote,
  runAsk,
  type RunAskDeps,
} from './cli-ask.js';

const ELIGIBLE_SOURCE = path.join(process.cwd(), 'package.json');

type FakeRetrievalDoc = {
  pageContent: string;
  metadata: Record<string, unknown>;
  score?: number;
};

type JsonAskOutput = {
  answer: string;
  citations: Array<{
    knowledge_base: string | null;
    path: string;
    score: number | null;
    chunk_id?: string;
    chunk_ids?: string[];
  }>;
  context_packing: {
    included_chunks: number;
    excluded_chunks: number;
    truncated_chunks: number;
  };
  transcript?: {
    saved: true;
    knowledge_base: string;
    path: string;
    title: string;
  };
};

describe('kb ask grounding fixtures (#434)', () => {
  it('answers from retrieved snippets and preserves citation chunk ids', async () => {
    const fixture = createAskGroundingFixture([
      retrievalDoc({
        path: 'deploy-runbook.md',
        content: 'Rollback uses the blue/green switch and must keep the canary disabled until health checks pass.',
        score: 0.92,
        chunkId: 'ops/deploy-runbook.md#L10-L16',
      }),
    ]);

    const result = await runAskJson([
      'How should rollback be handled?',
      '--kb=ops',
      '--endpoint=http://fake-llm.local/v1/chat/completions',
    ], fixture.deps);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.payload.answer).toBe(
      'Rollback uses the blue/green switch and keeps the canary disabled until health checks pass. Source: ops/deploy-runbook.md#L10-L16.',
    );
    expect(result.payload.citations).toEqual([
      {
        knowledge_base: 'ops',
        path: 'deploy-runbook.md',
        score: 0.92,
        chunk_id: 'ops/deploy-runbook.md#L10-L16',
        chunk_ids: ['ops/deploy-runbook.md#L10-L16'],
      },
    ]);
    expect(result.payload.context_packing).toMatchObject({
      included_chunks: 1,
      excluded_chunks: 0,
      truncated_chunks: 0,
    });
    expect(fixture.callChatCompletion).toHaveBeenCalledTimes(1);
    expect(fixture.lastUserPrompt()).toContain('Rollback uses the blue/green switch');
    expect(fixture.lastUserPrompt()).toContain('deploy-runbook.md');
  });

  it('abstains when retrieval returns no snippets', async () => {
    const fixture = createAskGroundingFixture([]);

    const result = await runAskJson([
      'What is the production rollback plan?',
      '--endpoint=http://fake-llm.local/v1/chat/completions',
    ], fixture.deps);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.payload.answer).toBe(
      'I do not have enough retrieved context to answer that from the knowledge base.',
    );
    expect(result.payload.citations).toEqual([]);
    expect(result.payload.context_packing).toMatchObject({
      included_chunks: 0,
      excluded_chunks: 0,
      truncated_chunks: 0,
    });
    expect(fixture.lastUserPrompt()).toContain('(no snippets retrieved)');
  });

  it('qualifies weak or off-topic context without leaking unrelated snippets', async () => {
    const fixture = createAskGroundingFixture([
      retrievalDoc({
        path: 'holiday-calendar.md',
        content: 'The office closes on the last Friday in December.',
        score: 0.18,
        chunkId: 'ops/holiday-calendar.md#L1-L3',
      }),
    ]);

    const result = await runAskJson([
      'What is the database restore procedure?',
      '--kb=ops',
      '--endpoint=http://fake-llm.local/v1/chat/completions',
    ], fixture.deps);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.payload.answer).toBe(
      'The retrieved context does not describe a database restore procedure, so I cannot answer that from these snippets.',
    );
    expect(result.payload.answer).not.toContain('office closes');
    expect(result.payload.answer).not.toContain('December');
    expect(result.payload.citations).toEqual([
      {
        knowledge_base: 'ops',
        path: 'holiday-calendar.md',
        score: 0.18,
        chunk_id: 'ops/holiday-calendar.md#L1-L3',
        chunk_ids: ['ops/holiday-calendar.md#L1-L3'],
      },
    ]);
  });

  it('writes transcript provenance for a grounded fake-LLM answer', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ask-grounding-'));
    try {
      await fsp.mkdir(path.join(root, 'ops'), { recursive: true });
      const fixture = createAskGroundingFixture([
        retrievalDoc({
          path: 'deploy-runbook.md',
          content: 'Rollback uses the blue/green switch and must keep the canary disabled until health checks pass.',
          score: 0.92,
          chunkId: 'ops/deploy-runbook.md#L10-L16',
        }),
      ], root);

      const result = await runAskJson([
        'How should rollback be handled?',
        '--kb=ops',
        '--endpoint=http://fake-llm.local/v1/chat/completions',
        '--save-transcript',
        '--title=Rollback grounding fixture',
        '--yes',
      ], fixture.deps);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.payload.transcript).toEqual({
        saved: true,
        knowledge_base: 'ops',
        path: 'rollback-grounding-fixture.md',
        title: 'Rollback grounding fixture',
      });

      const transcript = await fsp.readFile(
        path.join(root, 'ops', 'rollback-grounding-fixture.md'),
        'utf-8',
      );
      expect(transcript).toContain('type: kb_ask_transcript');
      expect(transcript).toContain('## Answer');
      expect(transcript).toContain('Source: ops/deploy-runbook.md#L10-L16.');
      expect(transcript).toContain('`ops:deploy-runbook.md`');
      expect(transcript).toContain('chunks `ops/deploy-runbook.md#L10-L16`');
      expect(transcript).toContain('LLM endpoint: `http://fake-llm.local/v1/chat/completions`');
      expect(transcript).toContain('retrieval knowledge base: `ops`');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

function createAskGroundingFixture(
  docs: FakeRetrievalDoc[],
  knowledgeBasesRootDir = path.join(os.tmpdir(), 'kb-ask-grounding'),
) {
  let lastMessages: Parameters<RunAskDeps['callChatCompletion']>[0]['messages'] = [];
  const manager = {
    modelDir: path.join(knowledgeBasesRootDir, '.faiss', 'models', 'fake-embedding-model'),
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async () => docs),
  };
  const callChatCompletion = jest.fn(async (options: Parameters<RunAskDeps['callChatCompletion']>[0]) => {
    lastMessages = options.messages;
    return {
      content: fakeGroundedAnswer(options.messages),
      model: 'fake-grounding-llm',
      raw: {},
    };
  });
  const deps: RunAskDeps = {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'fake-embedding-model'),
    loadManagerForModel: jest.fn(async () => manager as never),
    loadWithJsonRetry: jest.fn(async () => {}),
    withWriteLock: jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action()) as RunAskDeps['withWriteLock'],
    callChatCompletion,
    createTranscriptNote: createAskTranscriptNote,
    knowledgeBasesRootDir,
  };
  return {
    deps,
    callChatCompletion,
    lastUserPrompt: () => lastMessages.find((message) => message.role === 'user')?.content ?? '',
  };
}

function fakeGroundedAnswer(messages: Parameters<RunAskDeps['callChatCompletion']>[0]['messages']): string {
  const system = messages.find((message) => message.role === 'system')?.content ?? '';
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  if (!system.includes('Answer only from the provided knowledge-base snippets')) {
    throw new Error('fake LLM fixture requires the grounding system instruction');
  }
  if (user.includes('(no snippets retrieved)')) {
    return 'I do not have enough retrieved context to answer that from the knowledge base.';
  }
  if (
    user.includes('Question:\nHow should rollback be handled?')
    && user.includes('Rollback uses the blue/green switch')
    && user.includes('ops/deploy-runbook.md#L10-L16')
  ) {
    return 'Rollback uses the blue/green switch and keeps the canary disabled until health checks pass. Source: ops/deploy-runbook.md#L10-L16.';
  }
  if (
    user.includes('Question:\nWhat is the database restore procedure?')
    && user.includes('The office closes on the last Friday in December.')
    && user.includes('ops/holiday-calendar.md#L1-L3')
  ) {
    return 'The retrieved context does not describe a database restore procedure, so I cannot answer that from these snippets.';
  }
  throw new Error('fake LLM fixture received an unexpected prompt');
}

function retrievalDoc(input: {
  path: string;
  content: string;
  score: number;
  chunkId: string;
}): FakeRetrievalDoc {
  const loc = locFromChunkId(input.chunkId);
  return {
    pageContent: input.content,
    metadata: {
      knowledgeBase: 'ops',
      relativePath: input.path,
      source: ELIGIBLE_SOURCE,
      loc: { lines: loc },
      chunk_id: input.chunkId,
    },
    score: input.score,
  };
}

function locFromChunkId(chunkId: string): { from: number; to: number } {
  const match = chunkId.match(/#L(\d+)-L(\d+)$/);
  if (match === null) return { from: 1, to: 1 };
  return { from: Number(match[1]), to: Number(match[2]) };
}

async function runAskJson(rest: string[], deps: RunAskDeps): Promise<{
  code: number;
  stderr: string;
  payload: JsonAskOutput;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const code = await runAsk([...rest, '--format=json'], deps);
    const stdoutText = stdout.join('');
    return {
      code,
      stderr: stderr.join(''),
      payload: JSON.parse(stdoutText) as JsonAskOutput,
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}
