import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildAskTranscriptMarkdown,
  createAskTranscriptNote,
  parseAskArgs,
  runAsk,
  type RunAskDeps,
} from './cli-ask.js';

describe('parseAskArgs', () => {
  it('parses retrieval and LLM options', () => {
    expect(parseAskArgs([
      'what changed?',
      '--kb=ops',
      '--model=ollama__nomic',
      '--llm-profile=local',
      '--endpoint=http://127.0.0.1:8080',
      '--k=4',
      '--refresh',
      '--format=json',
      '--timing',
      '--save-transcript',
      '--title=Incident answer',
      '--yes',
    ])).toEqual({
      question: 'what changed?',
      kb: 'ops',
      model: 'ollama__nomic',
      llmProfile: 'local',
      endpoint: 'http://127.0.0.1:8080',
      k: 4,
      refresh: true,
      stdin: false,
      format: 'json',
      timing: true,
      saveTranscript: true,
      title: 'Incident answer',
      yes: true,
    });
  });

  it('rejects invalid flags', () => {
    expect(() => parseAskArgs(['q', '--k=0'])).toThrow(/invalid --k/);
    expect(() => parseAskArgs(['q', '--format=yaml'])).toThrow(/invalid --format/);
    expect(() => parseAskArgs(['q', '--bad'])).toThrow(/unknown flag/);
    expect(() => parseAskArgs(['q', 'extra'])).toThrow(/unexpected argument/);
  });

  it('requires explicit confirmation and a target KB before saving transcripts', () => {
    expect(() => parseAskArgs(['q', '--save-transcript', '--kb=ops'])).toThrow(/requires --yes/);
    expect(() => parseAskArgs(['q', '--save-transcript', '--yes'])).toThrow(/requires --kb/);
    expect(() => parseAskArgs(['q', '--title=Incident answer'])).toThrow(/requires --save-transcript/);
  });
});

describe('ask transcript records', () => {
  it('renders question, answer, citations, chunk ids, and model provenance', () => {
    const markdown = buildAskTranscriptMarkdown({
      title: 'Incident answer',
      createdAt: '2026-05-18T00:00:00.000Z',
      question: 'What changed?',
      answer: 'The deployment switched models.',
      citations: [
        {
          knowledge_base: 'ops',
          path: 'deploys.md',
          score: 0.1234,
          chunk_id: 'ops/deploys.md#L10-L18',
        },
      ],
      llm: {
        endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
        profile: 'local',
        mode: 'external',
        source: 'profile',
        model: 'qwen3',
      },
      retrieval: {
        embedding_model: 'ollama__nomic-embed-text-latest',
        k: 4,
        refreshed: false,
        knowledge_base: 'ops',
      },
      timing: { retrieval_ms: 12, llm_total_ms: 34, total_ms: 56 },
    });

    expect(markdown).toContain('type: kb_ask_transcript');
    expect(markdown).toContain('# Incident answer');
    expect(markdown).toContain('## Question\n\nWhat changed?');
    expect(markdown).toContain('## Answer\n\nThe deployment switched models.');
    expect(markdown).toContain('`ops:deploys.md`');
    expect(markdown).toContain('chunks `ops/deploys.md#L10-L18`');
    expect(markdown).toContain('retrieval model: `ollama__nomic-embed-text-latest`');
    expect(markdown).toContain('LLM profile: `local`');
  });

  it('creates a new transcript note and refuses duplicate titles', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ask-transcript-'));
    try {
      await fsp.mkdir(path.join(root, 'ops'), { recursive: true });
      const relativePath = await createAskTranscriptNote(root, 'ops', 'Incident answer', '# Body\n');

      expect(relativePath).toBe('incident-answer.md');
      await expect(createAskTranscriptNote(root, 'ops', 'Incident answer', '# Body\n'))
        .rejects.toThrow(/refusing to overwrite existing transcript/);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('writes a transcript through the runAsk CLI path', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ask-run-'));
    const previousEndpoint = process.env.KB_LLM_ENDPOINT;
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
      process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
      await fsp.mkdir(path.join(root, 'ops'), { recursive: true });
      const manager = {
        modelDir: path.join(root, '.faiss', 'models', 'ollama__nomic'),
        initialize: jest.fn(async () => {}),
        updateIndex: jest.fn(async () => {}),
        similaritySearch: jest.fn(async () => [
          {
            pageContent: 'The deployment switched embedding models.',
            metadata: {
              knowledgeBase: 'ops',
              relativePath: 'deploys.md',
              loc: { lines: { from: 10, to: 18 } },
            },
            score: 0.1234,
          },
        ]),
      };
      const deps: RunAskDeps = {
        bootstrapLayout: jest.fn(async () => {}),
        resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest'),
        loadManagerForModel: jest.fn(async () => manager as never),
        loadWithJsonRetry: jest.fn(async () => {}),
        withWriteLock: jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action()) as RunAskDeps['withWriteLock'],
        callChatCompletion: jest.fn(async () => ({
          content: 'The deployment switched embedding models.',
          model: 'qwen3',
          raw: {},
        })),
        createTranscriptNote: createAskTranscriptNote,
        knowledgeBasesRootDir: root,
      };

      const code = await runAsk([
        'What changed?',
        '--kb=ops',
        '--format=json',
        '--save-transcript',
        '--title=Incident answer',
        '--yes',
      ], deps);

      expect(code).toBe(0);
      expect(stderr.join('')).toBe('');
      const payload = JSON.parse(stdout.join('')) as {
        answer: string;
        transcript?: { knowledge_base: string; path: string; title: string };
      };
      expect(payload.answer).toBe('The deployment switched embedding models.');
      expect(payload.transcript).toEqual({
        saved: true,
        knowledge_base: 'ops',
        path: 'incident-answer.md',
        title: 'Incident answer',
      });
      const transcript = await fsp.readFile(path.join(root, 'ops', 'incident-answer.md'), 'utf-8');
      expect(transcript).toContain('## Question\n\nWhat changed?');
      expect(transcript).toContain('## Answer\n\nThe deployment switched embedding models.');
      expect(transcript).toContain('chunks `ops/deploys.md#L10-L18`');
      expect(deps.callChatCompletion).toHaveBeenCalledTimes(1);
      expect(manager.similaritySearch).toHaveBeenCalledWith(
        'What changed?',
        8,
        undefined,
        'ops',
        undefined,
        undefined,
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (previousEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
      else process.env.KB_LLM_ENDPOINT = previousEndpoint;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
