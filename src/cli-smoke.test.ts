import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTestCorpus, type TestCorpus } from './test-support/corpus.js';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

const SUBCOMMANDS = [
  'list',
  'ls',
  'search',
  'open',
  'serve',
  'ask',
  'remember',
  'capture',
  'compare',
  'doctor',
  'logs',
  'stats',
  'eval',
  'eval-gate',
  'explain',
  'stale-check',
  'superseded',
  'tags',
  'tag',
  'promote',
  'quarantine',
  'where',
  'models',
  'llm',
  'reindex',
  'completion',
] as const;

type Subcommand = typeof SUBCOMMANDS[number];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let kbRoot: string;
let faissRoot: string;
let homeDir: string;
let corpus: TestCorpus;

async function writeSmokeKb(): Promise<void> {
  corpus = await createTestCorpus({
    prefix: 'kb-cli-smoke-corpus-',
    files: {
      'alpha/note.md': '# Alpha\n\nA stable smoke-test note without external references.\n',
    },
  });
  kbRoot = corpus.rootDir;
  faissRoot = path.join(tempDir, 'faiss');
  homeDir = path.join(tempDir, 'home');
  await fsp.mkdir(homeDir, { recursive: true });
}

function runCli(args: string[], input?: string, env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync('node', [cliPath, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      KB_LOG_FORMAT: 'text',
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      FAISS_INDEX_PATH: faissRoot,
      EMBEDDING_PROVIDER: 'ollama',
      OLLAMA_MODEL: 'nomic-embed-text',
      ...env,
    },
    encoding: 'utf-8',
    input,
    timeout: 8_000,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseStdoutJson(result: RunResult): unknown {
  expect(result.stdout).not.toBe('');
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('kb CLI smoke matrix without an embedding backend', () => {
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-smoke-'));
    await writeSmokeKb();
  });

  afterEach(async () => {
    await Promise.all([
      fsp.rm(tempDir, { recursive: true, force: true }),
      corpus.cleanup(),
    ]);
  });

  describe.each(SUBCOMMANDS)('kb %s help', (subcommand) => {
    it('prints command help without touching backend state', () => {
      const result = runCli([subcommand, '--help']);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`kb ${subcommand}`);
      expect(result.stdout).toContain('Usage:');
    });
  });

  const outputCases: Array<{
    name: string;
    subcommand: Subcommand;
    args: string[];
    setup?: () => void | Promise<void>;
    assert: (result: RunResult) => void | Promise<void>;
  }> = [
    {
      name: 'list emits a stable JSON array',
      subcommand: 'list',
      args: ['list', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(parseStdoutJson(result)).toEqual([{ name: 'alpha' }]);
      },
    },
    {
      name: 'ls emits a stable JSON document inventory',
      subcommand: 'ls',
      args: ['ls', 'alpha', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(parseStdoutJson(result)).toEqual({
          schemaVersion: 'kb.ls.v1',
          knowledgeBases: ['alpha'],
          prefix: null,
          documents: [{ knowledgeBase: 'alpha', path: 'note.md' }],
        });
      },
    },
    {
      name: 'ls long JSON includes frontmatter metadata',
      subcommand: 'ls',
      args: ['ls', 'alpha', '--long', '--format=json'],
      setup: async () => {
        await corpus.writeFile(
          'alpha/metadata.md',
          '---\ntier: durable\nstatus: active\ntype: note\n---\n# Metadata\n',
        );
      },
      assert: (result) => {
        expect(result.code).toBe(0);
        const body = parseStdoutJson(result) as {
          documents: Array<Record<string, unknown>>;
        };
        expect(body.documents).toHaveLength(2);
        expect(body.documents.find((document) => document.path === 'note.md')).toEqual(expect.objectContaining({
          knowledgeBase: 'alpha',
          path: 'note.md',
          tier: null,
          status: null,
          type: null,
          mtime: expect.any(String),
        }));
        expect(body.documents.find((document) => document.path === 'metadata.md')).toEqual(expect.objectContaining({
          knowledgeBase: 'alpha',
          path: 'metadata.md',
          tier: 'durable',
          status: 'active',
          type: 'note',
          mtime: expect.any(String),
        }));
      },
    },
    {
      name: 'search JSON returns a structured no-model error with timing disabled by default',
      subcommand: 'search',
      args: ['search', 'alpha', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(2);
        const body = parseStdoutJson(result) as { error?: { code?: string; category?: string } };
        expect(body.error).toMatchObject({
          code: 'ACTIVE_MODEL_UNRESOLVED',
          category: 'configuration',
        });
        expect(result.stdout).not.toContain('timing');
      },
    },
    {
      name: 'ask JSON returns the same structured no-model class before LLM calls',
      subcommand: 'ask',
      args: ['ask', 'alpha', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(2);
        const body = parseStdoutJson(result) as { error?: { code?: string; next_action?: string } };
        expect(body.error?.code).toBe('ACTIVE_MODEL_UNRESOLVED');
        expect(body.error?.next_action).toContain('kb models list');
      },
    },
    {
      name: 'remember suggest renders predictable markdown without reading stdin',
      subcommand: 'remember',
      args: ['remember', '--suggest', '--kb=alpha', '--title=Alpha', '--format=md'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Likely existing targets for "Alpha" in alpha:');
        expect(result.stdout).toContain('- note.md (heading: Alpha)');
      },
    },
    {
      name: 'capture appends command stdout and reports a JSON mutation summary',
      subcommand: 'capture',
      args: ['capture', '--kb=alpha', '--append=note.md', '--', 'node', '-e', 'console.log("captured")'],
      assert: (result) => {
        expect(result.code).toBe(0);
        const body = parseStdoutJson(result) as { action?: string; path?: string; exit_code?: number };
        expect(body).toMatchObject({
          action: 'capture',
          path: 'note.md',
          exit_code: 0,
        });
      },
    },
    {
      name: 'compare reports unregistered models before any provider call',
      subcommand: 'compare',
      args: ['compare', 'alpha', 'ollama__a', 'openai__b'],
      assert: (result) => {
        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Model "ollama__a" is not registered');
      },
    },
    {
      name: 'doctor JSON exposes aggregate check status',
      subcommand: 'doctor',
      args: ['doctor', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(1);
        const body = parseStdoutJson(result) as { status?: string; checks?: Array<{ name?: string }> };
        expect(body.status).toBe('error');
        expect(body.checks?.map((check) => check.name)).toEqual(expect.arrayContaining([
          'layout',
          'active_model',
          'index',
          'backend',
        ]));
      },
    },
    {
      name: 'stats JSON preserves structured configuration failures',
      subcommand: 'stats',
      args: ['stats', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(2);
        const body = parseStdoutJson(result) as { error?: { code?: string } };
        expect(body.error?.code).toBe('ACTIVE_MODEL_UNRESOLVED');
      },
    },
    {
      name: 'explain JSON preserves structured configuration failures',
      subcommand: 'explain',
      args: ['explain', 'alpha', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(2);
        const body = parseStdoutJson(result) as { error?: { code?: string; category?: string } };
        expect(body.error).toMatchObject({
          code: 'ACTIVE_MODEL_UNRESOLVED',
          category: 'configuration',
        });
      },
    },
    {
      name: 'stale-check reports a clean no-reference corpus',
      subcommand: 'stale-check',
      args: ['stale-check', '--kb=alpha', '--no-cache'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('No drift across 1 file(s) in 1 KB(s).');
      },
    },
    {
      name: 'superseded JSON falls back to lexical review when semantic neighbors are unavailable',
      subcommand: 'superseded',
      args: ['superseded', '--kb=alpha', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout) as { kb?: string; totals?: { filesScanned?: number }; candidates?: unknown[] };
        expect(body).toMatchObject({
          kb: 'alpha',
          totals: { filesScanned: 1 },
          candidates: [],
        });
        expect(result.stderr).toContain('semantic neighbor scan skipped');
      },
    },
    {
      name: 'tags JSON reports empty facet buckets for a frontmatter-free corpus',
      subcommand: 'tags',
      args: ['tags', '--kb=alpha', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        const body = parseStdoutJson(result) as {
          schemaVersion?: string;
          knowledgeBases?: string[];
          notesScanned?: number;
          facets?: Record<string, unknown[]>;
        };
        expect(body).toMatchObject({
          schemaVersion: 'kb.tags.v1',
          knowledgeBases: ['alpha'],
          notesScanned: 1,
          facets: { tags: [], status: [], type: [] },
        });
      },
    },
    {
      name: 'tag JSON previews a note mutation without an embedding backend',
      subcommand: 'tag',
      args: ['tag', 'alpha/note.md', '--add=smoke', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(parseStdoutJson(result)).toMatchObject({
          schemaVersion: 'kb.tag.v1',
          knowledgeBase: 'alpha',
          relativePath: 'note.md',
          applied: false,
          before: [],
          after: ['smoke'],
        });
      },
    },
    {
      name: 'quarantine list JSON emits an empty entries array',
      subcommand: 'quarantine',
      args: ['quarantine', 'list', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(parseStdoutJson(result)).toEqual({ entries: [] });
      },
    },
    {
      name: 'models list reports the no-model bootstrap state',
      subcommand: 'models',
      args: ['models', 'list'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('no models registered');
      },
    },
    {
      name: 'llm status JSON stays isolated from user machine profiles',
      subcommand: 'llm',
      args: ['llm', 'status', '--format=json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        expect(parseStdoutJson(result)).toEqual({ profiles: [] });
      },
    },
    {
      name: 'open resolves a KB-relative path to an absolute source path',
      subcommand: 'open',
      args: ['open', 'alpha/note.md', '--json'],
      assert: (result) => {
        expect(result.code).toBe(0);
        const body = parseStdoutJson(result) as {
          knowledgeBase?: string;
          relativePath?: string;
          path?: string;
        };
        expect(body).toMatchObject({
          knowledgeBase: 'alpha',
          relativePath: 'alpha/note.md',
        });
        expect(path.isAbsolute(body.path ?? '')).toBe(true);
        expect(body.path?.endsWith(path.join('alpha', 'note.md'))).toBe(true);
      },
    },
  ];

  describe.each(outputCases)('$name', ({ args, setup, assert }) => {
    it('exercises the representative output path', async () => {
      await setup?.();
      await assert(runCli(args));
    });
  });

  it('ls scopes a prefix and enumerates multiple KBs through the spawned CLI', async () => {
    await corpus.writeFile('alpha/projects/active/current.md', '# Current\n');
    await corpus.writeFile('alpha/projects/active-old/old.md', '# Old\n');
    await corpus.writeFile('beta/other.md', '# Other\n');

    const all = runCli(['ls', '--format=json']);
    expect(all.code).toBe(0);
    expect(parseStdoutJson(all)).toMatchObject({
      knowledgeBases: ['alpha', 'beta'],
      documents: [
        { knowledgeBase: 'alpha', path: 'note.md' },
        { knowledgeBase: 'alpha', path: 'projects/active-old/old.md' },
        { knowledgeBase: 'alpha', path: 'projects/active/current.md' },
        { knowledgeBase: 'beta', path: 'other.md' },
      ],
    });

    const scoped = runCli(['ls', 'alpha', '--prefix=projects/active', '--format=json']);
    expect(scoped.code).toBe(0);
    expect(parseStdoutJson(scoped)).toMatchObject({
      knowledgeBases: ['alpha'],
      prefix: 'projects/active',
      documents: [{ knowledgeBase: 'alpha', path: 'projects/active/current.md' }],
    });
  });

  it('ls reports unknown knowledge bases with exit code 1 and stderr', () => {
    const result = runCli(['ls', 'missing']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not found');
  });

  const invalidArgCases: Array<{
    subcommand: Subcommand;
    args: string[];
    expected: string;
  }> = [
    { subcommand: 'list', args: ['list', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'ls', args: ['ls', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'ls', args: ['ls', '../outside'], expected: 'invalid KB name' },
    { subcommand: 'search', args: ['search', 'alpha', '--threshold=nope'], expected: 'invalid --threshold' },
    { subcommand: 'open', args: ['open'], expected: 'missing <chunk-id' },
    { subcommand: 'serve', args: ['serve', '--bogus'], expected: 'unknown flag: --bogus' },
    { subcommand: 'ask', args: ['ask'], expected: 'missing <question>' },
    { subcommand: 'remember', args: ['remember'], expected: 'missing --kb=<name>' },
    { subcommand: 'capture', args: ['capture'], expected: 'missing --kb=<name>' },
    { subcommand: 'compare', args: ['compare', 'alpha'], expected: 'expected <query> <model_a> <model_b>' },
    { subcommand: 'doctor', args: ['doctor', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'logs', args: ['logs'], expected: 'missing action: expected recent or show' },
    { subcommand: 'stats', args: ['stats', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'eval', args: ['eval'], expected: 'missing <fixture>' },
    { subcommand: 'eval-gate', args: ['eval-gate'], expected: 'missing <fixture>' },
    { subcommand: 'where', args: ['where'], expected: 'missing --topic=<query>' },
    { subcommand: 'tags', args: ['tags', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'tag', args: ['tag'], expected: 'missing <chunk-id' },
    { subcommand: 'promote', args: ['promote'], expected: 'missing --kb=<name>' },
    { subcommand: 'reindex', args: ['reindex'], expected: '--with-context is required' },
    { subcommand: 'completion', args: ['completion'], expected: 'expected one shell' },
  ];

  describe.each(invalidArgCases)('kb $subcommand invalid args', ({ args, expected }) => {
    it('exits 2 with an actionable parser error', () => {
      const result = runCli(args);

      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(expected);
    });
  });

  it('keeps the matrix aligned with every registered subcommand', () => {
    const covered = new Set<Subcommand>([
      ...outputCases.map((testCase) => testCase.subcommand),
      ...invalidArgCases.map((testCase) => testCase.subcommand),
    ]);

    expect([...covered].sort()).toEqual([...SUBCOMMANDS].sort());
  });

  it('searches a live index in ranked markdown without timing fields by default', async () => {
    await corpus.writeFile('alpha/weather.md', '# Weather\n\nCloud forecasts and rainfall totals.\n');
    const modelId = 'fake__BAAI-bge-small-en-v1.5';
    const modelDir = path.join(faissRoot, 'models', modelId);
    await fsp.mkdir(modelDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(modelDir, 'model_name.txt'), 'BAAI/bge-small-en-v1.5'),
      fsp.writeFile(path.join(faissRoot, 'active.txt'), modelId),
    ]);

    const result = runCli(
      ['search', 'stable smoke-test note', '--refresh', '--format=md', '--no-freshness'],
      undefined,
      {
        EMBEDDING_PROVIDER: 'fake',
        KB_FAKE_DIM: '32',
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\*\*Result 1:\*\*[\s\S]*\*\*Source:\*\* \[alpha\/note\.md/);
    expect(result.stdout).toMatch(/\*\*Result 2:\*\*[\s\S]*\*\*Source:\*\* \[alpha\/weather\.md/);
    expect(result.stdout).not.toMatch(/timing/i);
  });
});
