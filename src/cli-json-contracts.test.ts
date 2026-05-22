import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { toJsonReport } from './cli-eval.js';
import { runWhere, type RunWhereDeps } from './cli-where.js';
import type { SearchResultDocument } from './FaissIndexManager.js';
import type { Staleness } from './search-core.js';
import {
  evaluateRetrievalCase,
  summarizeRetrievalEval,
  type RetrievalEvalCase,
} from './retrieval-eval.js';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');
const docsPath = path.join(process.cwd(), 'docs', 'cli-json-contracts.md');
const DOCUMENTED_COMMANDS = [
  'kb help',
  'kb search',
  'kb remember',
  'kb capture',
  'kb where',
  'kb doctor',
  'kb logs',
  'kb eval',
  'kb list',
  'kb models list',
] as const;

type DocumentedCommand = typeof DOCUMENTED_COMMANDS[number];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let kbRoot: string;
let faissRoot: string;
let homeDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-json-contracts-'));
  kbRoot = path.join(tempDir, 'knowledge-bases');
  faissRoot = path.join(tempDir, 'faiss');
  homeDir = path.join(tempDir, 'home');
  await fsp.mkdir(path.join(kbRoot, 'alpha'), { recursive: true });
  await fsp.mkdir(homeDir, { recursive: true });
  await fsp.writeFile(path.join(kbRoot, 'alpha', 'README.md'), '# Alpha KB\n', 'utf-8');
  await fsp.writeFile(path.join(kbRoot, 'alpha', 'note.md'), '# Note\n\nSeed note.\n', 'utf-8');
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

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
  return JSON.parse(result.stdout);
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function doc(kb: string, rel: string, score: number): SearchResultDocument {
  return {
    pageContent: `content from ${rel}`,
    score,
    metadata: {
      knowledgeBase: kb,
      relativePath: rel,
    },
  };
}

const FRESH: Staleness = {
  indexMtime: '2026-05-09T08:00:00.000Z',
  modifiedFiles: 0,
  newFiles: 0,
};

function fixtureCase(overrides: Partial<RetrievalEvalCase> = {}): RetrievalEvalCase {
  return {
    name: 'deployment runbook',
    query: 'rollback procedure',
    kb: 'work',
    requiredSources: [],
    forbiddenSources: [],
    expectedMetadata: [],
    relevanceJudgments: [],
    stalePolicy: 'fresh',
    ...overrides,
  };
}

function readDocumentedSections(markdown: string): Map<DocumentedCommand, string> {
  const sections = new Map<DocumentedCommand, string>();
  const pattern = /^## `([^`]+)`\n([\s\S]*?)(?=^## `|(?![\s\S]))/gm;
  for (const match of markdown.matchAll(pattern)) {
    const heading = match[1] as DocumentedCommand;
    if ((DOCUMENTED_COMMANDS as readonly string[]).includes(heading)) {
      sections.set(heading, match[2]);
    }
  }
  return sections;
}

function jsonExamples(section: string): unknown[] {
  return [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
}

const docAssertions: Record<DocumentedCommand, (examples: unknown[]) => void> = {
  'kb help': (examples) => {
    expect(examples).toHaveLength(2);
    const topLevel = record(examples[0]);
    expect(topLevel).toMatchObject({
      schema_version: 'kb.help.v1',
      command: 'kb',
      stability: 'stable',
    });
    expect(topLevel.usage).toEqual(expect.any(Array));
    expect(topLevel.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'search' })]));

    const commandSpecific = record(examples[1]);
    expect(commandSpecific.schema_version).toBe('kb.help.v1');
    expect(record(commandSpecific.command)).toMatchObject({ name: 'search', stability: 'stable' });
  },
  'kb search': (examples) => {
    expect(examples).toHaveLength(4);
    expect(record(examples[0])).toMatchObject({
      results: expect.any(Array),
      stale: expect.any(Boolean),
      global_stale: expect.any(Boolean),
    });
    expect(record(examples[1])).toMatchObject({ mode: 'lexical', results: expect.any(Array) });
    expect(record(examples[2])).toMatchObject({ mode: 'hybrid', retrievers: expect.any(Object) });
    expect(record(record(examples[3]).error)).toMatchObject({
      code: expect.any(String),
      category: expect.any(String),
      message: expect.any(String),
      next_action: expect.any(String),
    });
  },
  'kb remember': (examples) => {
    expect(examples).toHaveLength(3);
    expect(record(examples[0])).toMatchObject({
      knowledge_base_name: expect.any(String),
      path: expect.any(String),
      action: expect.any(String),
      refreshed: expect.any(Boolean),
    });
    expect(record(examples[1])).toMatchObject({
      action: 'similarity-check',
      write_performed: false,
      candidates: expect.any(Array),
    });
    expect(record(examples[2])).toMatchObject({
      action: 'lesson-validation',
      write_performed: false,
      lesson: true,
      missing_sections: expect.any(Array),
    });
  },
  'kb capture': (examples) => {
    expect(examples).toHaveLength(1);
    expect(record(examples[0])).toMatchObject({
      knowledge_base_name: expect.any(String),
      path: expect.any(String),
      action: 'capture',
      truncated: expect.any(Boolean),
      bytes_elided: expect.any(Number),
      exit_code: expect.any(Number),
      refreshed: expect.any(Boolean),
      redaction_summary: expect.any(Object),
    });
  },
  'kb where': (examples) => {
    expect(examples).toHaveLength(2);
    expect(record(examples[0])).toMatchObject({
      recommended_kb: expect.any(String),
      existing_target: expect.any(String),
      confidence: expect.any(Number),
      suggested_invocation: expect.any(String),
    });
    expect(record(examples[1])).toEqual({ recommended_kb: null, results: [] });
  },
  'kb doctor': (examples) => {
    expect(examples).toHaveLength(4);
    expect(record(examples[0])).toMatchObject({
      status: expect.any(String),
      checks: expect.any(Array),
      active_model: expect.any(Object),
      index: expect.any(Object),
      backend: expect.any(Object),
      cli: expect.any(Object),
      last_index_update: expect.any(Object),
    });
    expect(record(examples[1])).toMatchObject({
      schema_version: 'kb.doctor.locks.v1',
      status: expect.any(String),
      faiss_index_path: expect.any(String),
      models_root: expect.any(String),
      stale_threshold_ms: expect.any(Number),
      summary: expect.objectContaining({
        total: expect.any(Number),
        held: expect.any(Number),
        stale_suspected: expect.any(Number),
        unknown: expect.any(Number),
      }),
      locks: expect.any(Array),
    });
    expect(record(examples[2])).toMatchObject({
      schema_version: 'kb.doctor.bug_report.v1',
      bundle_dir: expect.any(String),
      created_at: expect.any(String),
      files: expect.any(Array),
      redaction_summary: expect.any(Object),
    });
    expect(record(examples[3])).toMatchObject({
      schema_version: 'kb.doctor.endpoints.v1',
      status: expect.any(String),
      endpoints: expect.arrayContaining([
        expect.objectContaining({
          name: expect.any(String),
          kind: expect.any(String),
          status: expect.any(String),
          configured: expect.any(Boolean),
          detail: expect.any(String),
        }),
      ]),
    });
  },
  'kb logs': (examples) => {
    expect(examples).toHaveLength(1);
    expect(record(examples[0])).toMatchObject({
      schema_version: 'kb.logs.v1',
      action: 'show',
      source: expect.any(String),
      filters: expect.any(Object),
      result_count: expect.any(Number),
      events: expect.any(Array),
    });
  },
  'kb eval': (examples) => {
    expect(examples).toHaveLength(1);
    expect(record(examples[0])).toMatchObject({
      total: expect.any(Number),
      passed: expect.any(Number),
      failed: expect.any(Number),
      gate_failed: expect.any(Number),
      cases: expect.any(Array),
    });
  },
  'kb list': (examples) => {
    expect(examples).toHaveLength(2);
    expect(examples[0]).toEqual([expect.objectContaining({ name: expect.any(String) })]);
    expect(examples[1]).toEqual([
      expect.objectContaining({ name: expect.any(String), description: expect.any(String) }),
    ]);
  },
  'kb models list': (examples) => {
    expect(examples).toEqual([]);
  },
};

describe('documented CLI JSON contracts', () => {
  it('has one golden assertion for every documented CLI JSON section', async () => {
    const sections = readDocumentedSections(await fsp.readFile(docsPath, 'utf-8'));

    expect([...sections.keys()]).toEqual([...DOCUMENTED_COMMANDS]);
    expect(Object.keys(docAssertions)).toEqual([...DOCUMENTED_COMMANDS]);
  });

  it.each(DOCUMENTED_COMMANDS)('%s examples stay parseable and keep their stable fields', async (command) => {
    const sections = readDocumentedSections(await fsp.readFile(docsPath, 'utf-8'));
    const section = sections.get(command);
    expect(section).toBeDefined();

    docAssertions[command](jsonExamples(section!));
  });
});

describe('CLI JSON contract golden outputs', () => {
  it('kb help --format=json emits the documented manifest envelope', () => {
    const result = runCli(['help', '--format=json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(record(parseStdoutJson(result))).toMatchObject({
      schema_version: 'kb.help.v1',
      command: 'kb',
      usage: expect.any(Array),
      commands: expect.arrayContaining([expect.objectContaining({ name: 'search' })]),
      environment: expect.any(Array),
      exit_codes: expect.any(Array),
      stability: 'stable',
    });
  });

  it('kb search --format=json preserves the structured dense error envelope', () => {
    const result = runCli(['search', 'alpha', '--format=json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(record(record(parseStdoutJson(result)).error)).toMatchObject({
      code: 'ACTIVE_MODEL_UNRESOLVED',
      category: 'configuration',
      message: expect.any(String),
      next_action: expect.any(String),
    });
  });

  it('kb remember writes the documented success JSON fields', () => {
    const result = runCli([
      'remember',
      '--kb=alpha',
      '--title=Golden Contract',
      '--stdin',
      '--yes',
      '--no-check-similar',
    ], '# Golden Contract\n\nBody.\n');

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(record(parseStdoutJson(result))).toMatchObject({
      knowledge_base_name: 'alpha',
      path: 'golden-contract.md',
      action: 'create',
      refreshed: false,
    });
  });

  it('kb capture writes the documented capture summary fields', () => {
    const result = runCli([
      'capture',
      '--kb=alpha',
      '--append=note.md',
      '--',
      'node',
      '-e',
      'process.stdout.write("captured\\n")',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(record(parseStdoutJson(result))).toMatchObject({
      knowledge_base_name: 'alpha',
      path: 'note.md',
      action: 'capture',
      truncated: false,
      bytes_elided: 0,
      exit_code: 0,
      refreshed: false,
      redaction_summary: expect.objectContaining({
        enabled: true,
        total: 0,
        by_type: {},
      }),
    });
  });

  it('kb where --format=json emits the documented recommendation envelope', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: RunWhereDeps = {
      bootstrapLayout: async () => {},
      resolveActiveModel: async () => 'ollama__nomic-embed-text',
      loadManagerForModel: async () => ({
        similaritySearch: async () => [
          doc('alpha', 'notes/loose.md', 1.2),
          doc('beta', 'runbooks/deploy.md', 0.4),
        ],
      }),
      loadWithJsonRetry: async () => {},
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };

    const code = await runWhere(['--topic=deployment', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toEqual({
      recommended_kb: 'beta',
      existing_target: 'runbooks/deploy.md',
      confidence: 0.4,
      suggested_invocation: 'kb remember --kb=beta \\\n             --append=runbooks/deploy.md \\\n             --stdin --yes',
    });
  });

  it('kb doctor --format=json emits a report-shaped error instead of stderr text', () => {
    const result = runCli(['doctor', '--format=json']);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(record(parseStdoutJson(result))).toMatchObject({
      status: 'error',
      checks: expect.any(Array),
      active_model: expect.any(Object),
      index: expect.any(Object),
      backend: expect.any(Object),
      cli: expect.any(Object),
      last_index_update: expect.any(Object),
    });
  });

  it('kb logs recent --format=json emits the documented log report envelope', async () => {
    const logFile = path.join(tempDir, 'kb.log');
    await fsp.writeFile(
      logFile,
      `${JSON.stringify({
        schema_version: 'kb-canonical.v1',
        ts: '2026-05-18T20:00:00.000Z',
        request_id: 'req-1',
        process: 'cli',
        cmd: 'kb search',
        query_sha256: 'abc123',
        took_ms: 42,
        result_count: 3,
      })}\n`,
      'utf-8',
    );

    const result = runCli(['logs', 'recent', '--format=json', `--file=${logFile}`]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(record(parseStdoutJson(result))).toMatchObject({
      schema_version: 'kb.logs.v1',
      action: 'recent',
      source: logFile,
      result_count: 1,
      events: [expect.objectContaining({ request_id: 'req-1', result_count: 3 })],
    });
  });

  it('kb eval JSON report formatter keeps the documented aggregate and case fields', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({ requiredSources: ['runbooks/deploy.md'] }),
      [doc('work', 'runbooks/deploy.md', 0.1)],
      FRESH,
    );
    const payload = record(toJsonReport(summarizeRetrievalEval([result])));

    expect(payload).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      gate_failed: 0,
      cases: [
        expect.objectContaining({
          name: 'deployment runbook',
          query: 'rollback procedure',
          kb: 'work',
          gate: false,
          passed: true,
          failures: [],
          warnings: [],
          result_count: 1,
          duplicate_groups: 0,
        }),
      ],
    });
  });

  it('kb list --describe --format=json emits documented list entries', () => {
    const result = runCli(['list', '--describe', '--format=json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseStdoutJson(result)).toEqual([{ name: 'alpha', description: 'Alpha KB' }]);
  });

  it('kb models list remains a negative JSON contract', () => {
    const result = runCli(['models', 'list']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('no models registered');
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});
