import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  parseDiffIndexArgs,
  parseQueriesText,
  runDiffIndexCli,
  type RunDiffIndexCliDeps,
} from './cli-diff-index.js';
import type { DiffIndexOptions, DiffIndexReport } from './diff-index-core.js';

function minimalReport(overrides: Partial<DiffIndexReport> = {}): DiffIndexReport {
  return {
    schema_version: 'kb.diff-index.v1',
    before_path: '/models/active/index.v1',
    after_path: '/models/active/index.v2',
    top_k: 5,
    threshold: 1.5,
    query_count: 1,
    queries: [],
    summary: {
      mean_stability_score: 1,
      mean_churn_score: 0,
      stable_queries: 1,
      moved_queries: 0,
      top1_changed_queries: 0,
      mean_new_chunks: 0,
      mean_dropped_chunks: 0,
      by_kb: { ops: { queries: 1, mean_stability_score: 1, mean_churn_score: 0 } },
    },
    ...overrides,
  };
}

function createCliDeps(opts: {
  report?: DiffIndexReport;
  runError?: Error;
  captureRunOpts?: (runOpts: DiffIndexOptions) => void;
  stdout: string[];
  stderr: string[];
}): RunDiffIndexCliDeps {
  return {
    async bootstrapLayout() {},
    async resolveActiveModel() {
      return 'huggingface__test';
    },
    async loadManagerForModel() {
      return {
        modelDir: '/models/active',
        async loadFromVersionDir() {},
        async similaritySearch() {
          return [];
        },
      };
    },
    async loadWithJsonRetry() {},
    async runDiffIndex(runOpts) {
      opts.captureRunOpts?.(runOpts);
      if (opts.runError) throw opts.runError;
      return opts.report ?? minimalReport();
    },
    stdout(text) {
      opts.stdout.push(text);
    },
    stderr(text) {
      opts.stderr.push(text);
    },
  };
}

describe('parseDiffIndexArgs', () => {
  it('parses required versions, query source, and tuning options', () => {
    expect(parseDiffIndexArgs([
      '--before=3',
      '--after=index.v4',
      '--queries=queries.txt',
      '--model=ollama__nomic-embed-text',
      '--kb=ops',
      '--top-k=25',
      '--threshold=1.5',
      '--format=json',
    ])).toEqual({
      before: '3',
      after: 'index.v4',
      source: { kind: 'queries', path: 'queries.txt' },
      model: 'ollama__nomic-embed-text',
      kb: 'ops',
      topK: 25,
      threshold: 1.5,
      format: 'json',
    });
  });

  it('rejects multiple query sources', () => {
    expect(() => parseDiffIndexArgs([
      '--before=1',
      '--after=2',
      '--queries=queries.txt',
      '--fixture=fixture.yml',
    ])).toThrow(/exactly one query source/);
  });

  it('rejects log sampling because canonical logs do not preserve plaintext queries', () => {
    expect(() => parseDiffIndexArgs([
      '--before=1',
      '--after=2',
      '--sample-logs=10',
    ])).toThrow(/canonical logs store query hashes/);
  });
});

describe('parseQueriesText', () => {
  it('keeps non-empty non-comment lines and applies the default KB', () => {
    expect(parseQueriesText('\n# comment\nrollback procedure\n\nembedding timeout\n', 'ops')).toEqual([
      { query: 'rollback procedure', kb: 'ops' },
      { query: 'embedding timeout', kb: 'ops' },
    ]);
  });
});

describe('runDiffIndexCli', () => {
  it('passes parsed versions and query options into the diff-index engine', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-diff-index-cli-'));
    try {
      const queriesPath = path.join(tmp, 'queries.txt');
      await fsp.writeFile(queriesPath, 'rollback procedure\n# ignored\nembedding timeout\n', 'utf-8');
      const stdout: string[] = [];
      const stderr: string[] = [];
      let captured: DiffIndexOptions | undefined;
      const deps = createCliDeps({
        stdout,
        stderr,
        report: minimalReport({
          before_path: '/models/active/index.v1',
          after_path: '/models/active/index.v2',
          top_k: 5,
          threshold: 1.5,
          query_count: 2,
        }),
        captureRunOpts(runOpts) {
          captured = runOpts;
        },
      });

      const code = await runDiffIndexCli([
        '--before=1',
        '--after=index.v2',
        `--queries=${queriesPath}`,
        '--kb=ops',
        '--top-k=5',
        '--threshold=1.5',
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(stderr.join('')).toBe('');
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        schema_version: 'kb.diff-index.v1',
        before_path: '/models/active/index.v1',
        after_path: '/models/active/index.v2',
        top_k: 5,
        threshold: 1.5,
        query_count: 2,
      });
      expect(captured).toMatchObject({
        before: '/models/active/index.v1',
        after: '/models/active/index.v2',
        topK: 5,
        threshold: 1.5,
        queries: [
          { query: 'rollback procedure', kb: 'ops' },
          { query: 'embedding timeout', kb: 'ops' },
        ],
      });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns argv status when required versions are missing', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runDiffIndexCli([
      '--query=rollback procedure',
      '--after=2',
    ], createCliDeps({ stdout, stderr }));

    expect(code).toBe(2);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('--before and --after are required');
  });

  it('returns runtime failure status when the diff-index engine fails', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runDiffIndexCli([
      '--before=1',
      '--after=2',
      '--query=rollback procedure',
    ], createCliDeps({
      stdout,
      stderr,
      runError: new Error('index version directory not found'),
    }));

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('index version directory not found');
  });
});
