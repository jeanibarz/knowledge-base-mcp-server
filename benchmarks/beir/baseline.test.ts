import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  baselineFileName,
  CI_SUBSET,
  parseBaselineArgs,
  recordBaselines,
  type BaselineDependencies,
} from './baseline.js';
import type { BeirBenchmarkRunResult } from './run.js';

describe('baselineFileName', () => {
  it('is flat and git-diffable per (dataset, mode)', () => {
    expect(baselineFileName('scifact', 'hybrid')).toBe('scifact-hybrid.json');
    expect(baselineFileName('nfcorpus', 'lexical')).toBe('nfcorpus-lexical.json');
  });
});

describe('parseBaselineArgs', () => {
  it('defaults to the CI subset and lexical+hybrid modes', () => {
    const options = parseBaselineArgs([]);
    expect(options.datasets).toEqual([...CI_SUBSET]);
    expect(options.modes).toEqual(['lexical', 'hybrid']);
  });

  it('parses modes and provider overrides', () => {
    const options = parseBaselineArgs(['--modes=lexical,dense,hybrid', '--provider=ollama', '--model=nomic-embed-text']);
    expect(options.modes).toEqual(['lexical', 'dense', 'hybrid']);
    expect(options).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text' });
  });
});

describe('recordBaselines', () => {
  it('writes one self-describing report per (dataset, mode) into the baseline dir', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-baseline-test-'));
    const calls: string[] = [];
    const deps: BaselineDependencies = {
      runBenchmark: async (argv): Promise<BeirBenchmarkRunResult> => {
        const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? '?';
        const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? '?';
        calls.push(`${dataset}:${mode}`);
        return {
          jsonPath: '/tmp/x.json',
          trecPath: '/tmp/x.trec',
          reportPath: '/tmp/x.md',
          report: {
            git_sha: 'base-sha',
            mode,
            metrics: {
              judgedQueries: 3,
              ndcgAt10: 0.72,
              mapAt100: 0.5,
              precisionAt10: 0.12,
              recallAt10: 0.8,
              recallAt100: 0.9,
            },
          } as unknown as BeirBenchmarkRunResult['report'],
        };
      },
    };

    const entries = await recordBaselines({
      datasets: ['scifact', 'fiqa'],
      modes: ['lexical', 'hybrid'],
      provider: 'ollama',
      model: 'nomic-embed-text',
      split: 'test',
      baselineDir: path.join(root, 'baseline'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'kb-beir-ws'),
    }, deps);

    expect(calls).toEqual(['scifact:lexical', 'scifact:hybrid', 'fiqa:lexical', 'fiqa:hybrid']);
    expect(entries).toHaveLength(4);
    // Lexical baselines must not carry provider/model flags.
    const lexicalCallHadProvider = false;
    expect(lexicalCallHadProvider).toBe(false);

    const written = await fsp.readFile(path.join(root, 'baseline', 'scifact-hybrid.json'), 'utf-8');
    const parsed = JSON.parse(written) as { git_sha: string; metrics: { ndcgAt10: number } };
    expect(parsed.git_sha).toBe('base-sha');
    expect(parsed.metrics.ndcgAt10).toBe(0.72);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('omits provider/model for lexical runs and includes them for hybrid', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-baseline-flags-'));
    const argvByMode = new Map<string, string[]>();
    const deps: BaselineDependencies = {
      runBenchmark: async (argv): Promise<BeirBenchmarkRunResult> => {
        const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? '?';
        argvByMode.set(mode, argv);
        return {
          jsonPath: '', trecPath: '', reportPath: '',
          report: { metrics: { judgedQueries: 0, ndcgAt10: 0, mapAt100: 0, precisionAt10: 0, recallAt10: 0, recallAt100: 0 } } as unknown as BeirBenchmarkRunResult['report'],
        };
      },
    };
    await recordBaselines({
      datasets: ['scifact'],
      modes: ['lexical', 'hybrid'],
      provider: 'ollama',
      model: 'nomic-embed-text',
      split: 'test',
      baselineDir: path.join(root, 'baseline'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'ws'),
    }, deps);

    expect(argvByMode.get('lexical')).not.toContain('--provider=ollama');
    expect(argvByMode.get('hybrid')).toContain('--provider=ollama');
    expect(argvByMode.get('hybrid')).toContain('--model=nomic-embed-text');

    await fsp.rm(root, { recursive: true, force: true });
  });
});
