import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  formatRerankerBakeoffMarkdown,
  runRerankerBakeoff,
  type RerankerBakeoffDependencies,
} from './reranker-bakeoff.js';
import type { BeirBenchmarkRunResult } from './run.js';

function stubResult(dataset: string, mode: string): BeirBenchmarkRunResult {
  const isBaseline = mode === 'hybrid';
  const ndcg = isBaseline ? 0.5 : 0.55;
  return {
    jsonPath: `/tmp/${dataset}-${mode}.json`,
    trecPath: `/tmp/${dataset}-${mode}.trec`,
    reportPath: `/tmp/${dataset}-${mode}.md`,
    report: {
      dataset: { name: dataset, split: 'test', queries_evaluated: 2 },
      mode,
      metrics: {
        judgedQueries: 2,
        ndcgAt10: ndcg,
        mapAt100: ndcg,
        precisionAt10: 0.1,
        recallAt10: ndcg,
        recallAt100: ndcg + 0.2,
      },
      latency: { queries: 2, p50Ms: 1, p95Ms: isBaseline ? 4 : 6, p99Ms: 6, meanMs: 2 },
      reranker_bakeoff: isBaseline ? null : {
        schema_version: 'kb.beir.reranker-bakeoff-summary.v1',
        enabled: true,
        strategy: 'listwise-attention',
        model: 'qr-style-token-attention-v1',
        top_n: 50,
        queries: 2,
        mean_candidates_in: 50,
        mean_candidates_reranked: 50,
        skipped_queries: 0,
        mean_latency_ms: 1.5,
      },
    } as unknown as BeirBenchmarkRunResult['report'],
  };
}

describe('reranker bakeoff report runner', () => {
  it('records hybrid baselines, skipped optional model rows, and win/loss deltas', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-reranker-bakeoff-test-'));
    const savedQwen = process.env.KB_RERANK_QWEN3_MODEL;
    const savedPrism = process.env.KB_RERANK_PRISM_MODEL;
    process.env.KB_RERANK_QWEN3_MODEL = '   ';
    delete process.env.KB_RERANK_PRISM_MODEL;
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const deps: RerankerBakeoffDependencies = {
      runBenchmark: async (argv, env) => {
        calls.push({ argv, env });
        const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? 'unknown';
        const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'hybrid';
        return stubResult(dataset, mode);
      },
      gitSha: async () => 'bakeoff-sha',
      now: () => new Date('2026-06-09T00:00:00.000Z'),
    };

    try {
      const { report, markdownPath } = await runRerankerBakeoff({
        datasets: ['scifact'],
        provider: 'fake',
        model: 'fake-embeddings',
        split: 'test',
        outputDir: path.join(root, 'out'),
        cacheDir: path.join(root, 'cache'),
        workspaceRoot: path.join(root, 'ws'),
        maxQueries: 2,
      }, deps);

      expect(report.cells.find((cell) => cell.variant === 'hybrid-baseline')).toMatchObject({
        dataset: 'scifact',
        status: 'ok',
        ndcgAt10: 0.5,
      });
      expect(report.cells.find((cell) => cell.variant === 'qwen3-reranker')).toMatchObject({
        status: 'skipped',
        error: expect.stringContaining('KB_RERANK_QWEN3_MODEL'),
      });
      expect(report.cells.find((cell) => cell.variant === 'prism-reranker')).toMatchObject({
        status: 'skipped',
        error: expect.stringContaining('KB_RERANK_PRISM_MODEL'),
      });
      expect(report.cells.map((cell) => `${cell.variant}:${cell.mode}:${cell.status}`)).toEqual([
        'hybrid-baseline:hybrid:ok',
        'current-cross-encoder:hybrid+rerank:ok',
        'qwen3-reranker:hybrid+rerank:skipped',
        'prism-reranker:hybrid+rerank:skipped',
        'listwise-attention:hybrid+listwise-rerank:ok',
        'hard-negative-head:hybrid+hard-negative-rerank:ok',
        'adaptive-listwise:hybrid+adaptive-rerank:ok',
      ]);
      expect(calls.map((call) => call.argv.find((arg) => arg.startsWith('--mode=')))).toEqual([
        '--mode=hybrid',
        '--mode=hybrid+rerank',
        '--mode=hybrid+listwise-rerank',
        '--mode=hybrid+hard-negative-rerank',
        '--mode=hybrid+adaptive-rerank',
      ]);
      expect(calls.every((call) => call.argv.includes('--provider=fake'))).toBe(true);
      expect(calls.every((call) => call.env === undefined)).toBe(true);
      expect(report.win_loss.find((row) => row.variant === 'listwise-attention')).toMatchObject({
        outcome: 'win',
        ndcgDelta: 0.05,
        latencyP95DeltaMs: 2,
      });
      expect(await fsp.readFile(markdownPath, 'utf-8')).toContain('hybrid-baseline');
      expect(formatRerankerBakeoffMarkdown(report)).toContain('Default change: none');
    } finally {
      if (savedQwen === undefined) delete process.env.KB_RERANK_QWEN3_MODEL;
      else process.env.KB_RERANK_QWEN3_MODEL = savedQwen;
      if (savedPrism === undefined) delete process.env.KB_RERANK_PRISM_MODEL;
      else process.env.KB_RERANK_PRISM_MODEL = savedPrism;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('passes configured optional model overrides through to cross-encoder cells', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-reranker-bakeoff-env-test-'));
    const savedQwen = process.env.KB_RERANK_QWEN3_MODEL;
    const savedPrism = process.env.KB_RERANK_PRISM_MODEL;
    process.env.KB_RERANK_QWEN3_MODEL = 'local/qwen-reranker';
    process.env.KB_RERANK_PRISM_MODEL = 'local/prism-reranker';
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const deps: RerankerBakeoffDependencies = {
      runBenchmark: async (argv, env) => {
        calls.push({ argv, env });
        const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? 'unknown';
        const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'hybrid';
        return stubResult(dataset, mode);
      },
      gitSha: async () => 'bakeoff-sha',
      now: () => new Date('2026-06-09T00:00:00.000Z'),
    };
    try {
      const { report } = await runRerankerBakeoff({
        datasets: ['scifact'],
        provider: 'fake',
        model: 'fake-embeddings',
        split: 'test',
        outputDir: path.join(root, 'out'),
        cacheDir: path.join(root, 'cache'),
        workspaceRoot: path.join(root, 'ws'),
      }, deps);
      expect(report.cells.find((cell) => cell.variant === 'qwen3-reranker')).toMatchObject({
        status: 'ok',
        model: 'local/qwen-reranker',
      });
      expect(report.cells.find((cell) => cell.variant === 'prism-reranker')).toMatchObject({
        status: 'ok',
        model: 'local/prism-reranker',
      });
      expect(calls.find((call) => call.env?.KB_RERANK_MODEL === 'local/qwen-reranker')).toBeDefined();
      expect(calls.find((call) => call.env?.KB_RERANK_MODEL === 'local/prism-reranker')).toBeDefined();
    } finally {
      if (savedQwen === undefined) delete process.env.KB_RERANK_QWEN3_MODEL;
      else process.env.KB_RERANK_QWEN3_MODEL = savedQwen;
      if (savedPrism === undefined) delete process.env.KB_RERANK_PRISM_MODEL;
      else process.env.KB_RERANK_PRISM_MODEL = savedPrism;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
