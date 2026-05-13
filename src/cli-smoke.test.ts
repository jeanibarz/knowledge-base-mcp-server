import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

const SUBCOMMANDS = [
  'list',
  'search',
  'serve',
  'ask',
  'remember',
  'capture',
  'compare',
  'doctor',
  'stats',
  'eval',
  'explain',
  'stale-check',
  'superseded',
  'promote',
  'quarantine',
  'where',
  'models',
  'llm',
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

async function writeSmokeKb(): Promise<void> {
  kbRoot = path.join(tempDir, 'knowledge-bases');
  faissRoot = path.join(tempDir, 'faiss');
  homeDir = path.join(tempDir, 'home');
  await fsp.mkdir(path.join(kbRoot, 'alpha'), { recursive: true });
  await fsp.mkdir(homeDir, { recursive: true });
  await fsp.writeFile(
    path.join(kbRoot, 'alpha', 'note.md'),
    '# Alpha\n\nA stable smoke-test note without external references.\n',
    'utf-8',
  );
}

function runCli(args: string[], input?: string): RunResult {
  const result = spawnSync('node', [cliPath, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      KB_LOG_FORMAT: 'text',
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      FAISS_INDEX_PATH: faissRoot,
      EMBEDDING_PROVIDER: 'ollama',
      OLLAMA_MODEL: 'nomic-embed-text',
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
    await fsp.rm(tempDir, { recursive: true, force: true });
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
    assert: (result: RunResult) => void;
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
  ];

  describe.each(outputCases)('$name', ({ args, assert }) => {
    it('exercises the representative output path', () => {
      assert(runCli(args));
    });
  });

  const invalidArgCases: Array<{
    subcommand: Subcommand;
    args: string[];
    expected: string;
  }> = [
    { subcommand: 'list', args: ['list', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'search', args: ['search', 'alpha', '--threshold=nope'], expected: 'invalid --threshold' },
    { subcommand: 'serve', args: ['serve', '--bogus'], expected: 'unknown flag: --bogus' },
    { subcommand: 'ask', args: ['ask'], expected: 'missing <question>' },
    { subcommand: 'remember', args: ['remember'], expected: 'missing --kb=<name>' },
    { subcommand: 'capture', args: ['capture'], expected: 'missing --kb=<name>' },
    { subcommand: 'compare', args: ['compare', 'alpha'], expected: 'expected <query> <model_a> <model_b>' },
    { subcommand: 'doctor', args: ['doctor', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'stats', args: ['stats', '--format=xml'], expected: 'invalid --format' },
    { subcommand: 'eval', args: ['eval'], expected: 'missing <fixture>' },
    { subcommand: 'where', args: ['where'], expected: 'missing --topic=<query>' },
    { subcommand: 'promote', args: ['promote'], expected: 'missing --kb=<name>' },
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

  it.todo('cover live-index search markdown output without --timing after issue #332 fixes the current timing-disabled crash');
});
