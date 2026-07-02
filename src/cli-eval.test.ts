import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCompareEval } from './cli-eval-compare.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { runEval, parseEvalArgs } from './cli-eval.js';

jest.mock('./FaissIndexManager.js', () => ({
  FaissIndexManager: {
    bootstrapLayout: jest.fn(async () => undefined),
  },
}));

jest.mock('./active-model.js', () => ({
  ActiveModelResolutionError: class ActiveModelResolutionError extends Error {},
  resolveActiveModel: jest.fn(async () => 'fake__model'),
}));

jest.mock('./cli-shared.js', () => {
  const actual = jest.requireActual<typeof import('./cli-shared.js')>('./cli-shared.js');
  return {
    ...actual,
    loadManagerForModel: jest.fn(),
    loadWithJsonRetry: jest.fn(),
  };
});

jest.mock('./search-core.js', () => {
  const actual = jest.requireActual<typeof import('./search-core.js')>('./search-core.js');
  return {
    ...actual,
    computeStaleness: jest.fn(async () => ({
      indexMtime: '2026-05-09T08:00:00.000Z',
      modifiedFiles: 0,
      newFiles: 0,
    })),
  };
});

jest.mock('./cli-eval-compare.js', () => ({
  formatCompareReportMarkdown: jest.fn(() => '# kb eval --compare-index\n'),
  resolveIndexVersionPath: jest.fn((arg: string, modelDir: string) => `${modelDir}/${arg}`),
  runCompareEval: jest.fn(),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  jest.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('parseEvalArgs', () => {
  it('accepts delimited output formats for eval runs', () => {
    expect(parseEvalArgs(['fixture.yml', '--format=csv'])).toMatchObject({
      action: 'run',
      fixturePath: 'fixture.yml',
      format: 'csv',
    });
    expect(parseEvalArgs(['fixture.yml', '--format=tsv'])).toMatchObject({
      format: 'tsv',
    });
    expect(parseEvalArgs(['fixture.yml', '--format=ndjson'])).toMatchObject({
      format: 'ndjson',
    });
  });

  it('continues to reject --format for scaffold', () => {
    expect(() => parseEvalArgs(['scaffold', 'rollback', '--format=csv'])).toThrow(
      /--format is not supported for scaffold/,
    );
  });
});

describe('runEval delimited output', () => {
  it('prints normal eval results as CSV rows', async () => {
    mockManagerSearch([{
      pageContent: 'rollback runbook',
      score: 0.1,
      metadata: {
        knowledgeBase: 'ops',
        relativePath: 'runbook.md',
      },
    }]);
    const fixture = await writeFixture({
      gate: false,
      cases: [{
        name: 'deployment runbook',
        query: 'rollback procedure',
        kb: 'ops',
        required_sources: ['runbook.md'],
        stale_policy: 'fresh',
      }],
    });

    const captured = await captureEvalOutput(() => runEval([fixture, '--format=csv']));

    expect(captured.code).toBe(0);
    expect(captured.stderr).toBe('');
    const lines = captured.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe([
      'name',
      'query',
      'kb',
      'gate',
      'requested_mode',
      'effective_mode',
      'passed',
      'failure_count',
      'warning_count',
      'result_count',
      'duplicate_groups',
      'failures',
      'warnings',
      'diversity_metrics',
      'ranked_metrics',
    ].join(','));
    expect(lines[1]).toContain('deployment runbook,rollback procedure,ops,false,dense,dense,true,0,0,1,0');
  });

  it('prints compare-index results as NDJSON rows', async () => {
    mockManagerSearch([]);
    jest.mocked(runCompareEval).mockResolvedValue({
      schema_version: 'kb-eval-compare.v1',
      before_path: '/models/fake/index.v1',
      after_path: '/models/fake/index.v2',
      case_count: 1,
      cases: [{
        name: 'deployment runbook',
        query: 'rollback procedure',
        kb: 'ops',
        mode: 'dense',
        before: {
          result_count: 1,
          top_sources: ['old.md'],
          top_scores: [0.4],
          mean_score: 0.4,
        },
        after: {
          result_count: 2,
          top_sources: ['new.md', 'old.md'],
          top_scores: [0.1, 0.3],
          mean_score: 0.2,
        },
        changes: {
          result_count_delta: 1,
          mean_score_delta: -0.2,
          new_sources: ['new.md'],
          dropped_sources: [],
          rank_changes: [{ source: 'old.md', before_rank: 1, after_rank: 2, rank_delta: -1 }],
        },
      }],
      aggregate: {
        mean_result_count_delta: 1,
        mean_score_delta: -0.2,
        new_sources_per_case: 1,
        dropped_sources_per_case: 0,
        cases_with_top1_change: 1,
      },
    });
    const fixture = await writeFixture({
      gate: false,
      cases: [{
        name: 'deployment runbook',
        query: 'rollback procedure',
        kb: 'ops',
        stale_policy: 'fresh',
      }],
    });

    const captured = await captureEvalOutput(() => runEval([
      fixture,
      '--compare-index',
      '--before=1',
      '--after=2',
      '--format=ndjson',
    ]));

    expect(captured.code).toBe(0);
    expect(captured.stderr).toBe('');
    expect(captured.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{
      name: 'deployment runbook',
      query: 'rollback procedure',
      kb: 'ops',
      mode: 'dense',
      before_result_count: 1,
      after_result_count: 2,
      result_count_delta: 1,
      before_mean_score: 0.4,
      after_mean_score: 0.2,
      mean_score_delta: -0.2,
      new_sources: ['new.md'],
      dropped_sources: [],
      rank_changes: [{ source: 'old.md', before_rank: 1, after_rank: 2, rank_delta: -1 }],
    }]);
  });
});

function mockManagerSearch(results: unknown[]): void {
  jest.mocked(loadManagerForModel).mockResolvedValue({
    modelDir: '/models/fake',
    similaritySearch: jest.fn(async () => results),
  } as never);
  jest.mocked(loadWithJsonRetry).mockResolvedValue(undefined as never);
}

async function writeFixture(fixture: unknown): Promise<string> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-eval-test-'));
  tempDirs.push(tempDir);
  const fixturePath = path.join(tempDir, 'fixture.json');
  await fsp.writeFile(fixturePath, JSON.stringify(fixture), 'utf-8');
  return fixturePath;
}

async function captureEvalOutput(fn: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
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
    return {
      code: await fn(),
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}
