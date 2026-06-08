import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  buildChunkSweepGrid,
  formatChunkSweepMarkdown,
  parseSweepArgs,
  runChunkSweep,
  type ChunkSweepDependencies,
  type ChunkSweepReport,
} from './sweep.js';
import type { BeirBenchmarkRunResult } from './run.js';

describe('chunk-size sweep grid', () => {
  it('builds the size×overlap cross-product, dropping overlap >= size', () => {
    const grid = buildChunkSweepGrid([500, 1000], [100, 200, 600]);
    expect(grid).toEqual([
      { chunkSize: 500, chunkOverlap: 100 },
      { chunkSize: 500, chunkOverlap: 200 },
      // overlap 600 >= size 500 dropped
      { chunkSize: 1000, chunkOverlap: 100 },
      { chunkSize: 1000, chunkOverlap: 200 },
      { chunkSize: 1000, chunkOverlap: 600 },
    ]);
  });

  it('matches the RFC default grid shape (4 sizes × 3 overlaps, all valid)', () => {
    const grid = buildChunkSweepGrid([500, 1000, 1500, 2000], [100, 200, 300]);
    expect(grid).toHaveLength(12);
  });
});

describe('parseSweepArgs', () => {
  it('defaults to the CI subset, the RFC grid, and hybrid mode', () => {
    const options = parseSweepArgs([]);
    expect(options.datasets).toEqual(['scifact', 'nfcorpus', 'fiqa']);
    expect(options.chunkSizes).toEqual([500, 1000, 1500, 2000]);
    expect(options.chunkOverlaps).toEqual([100, 200, 300]);
    expect(options.mode).toBe('hybrid');
  });

  it('parses overrides', () => {
    const options = parseSweepArgs([
      '--datasets=scifact,fiqa',
      '--chunk-sizes=256,512',
      '--chunk-overlaps=0,64',
      '--mode=dense',
      '--provider=ollama',
      '--model=nomic-embed-text',
    ]);
    expect(options).toMatchObject({
      datasets: ['scifact', 'fiqa'],
      chunkSizes: [256, 512],
      chunkOverlaps: [0, 64],
      mode: 'dense',
      provider: 'ollama',
      model: 'nomic-embed-text',
    });
  });
});

describe('runChunkSweep', () => {
  it('sets chunk env per cell, collects nDCG@10 + precision@10, and restores env', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-sweep-test-'));
    const seenEnv: Array<{ size?: string; overlap?: string }> = [];
    const beforeSize = process.env.KB_CHUNK_SIZE;
    const beforeOverlap = process.env.KB_CHUNK_OVERLAP;

    const deps: ChunkSweepDependencies = {
      gitSha: async () => 'sweep-sha',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
      setChunkEnv: (cell) => {
        process.env.KB_CHUNK_SIZE = String(cell.chunkSize);
        process.env.KB_CHUNK_OVERLAP = String(cell.chunkOverlap);
      },
      runBenchmark: async (argv): Promise<BeirBenchmarkRunResult> => {
        seenEnv.push({ size: process.env.KB_CHUNK_SIZE, overlap: process.env.KB_CHUNK_OVERLAP });
        const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? 'unknown';
        const size = Number(process.env.KB_CHUNK_SIZE);
        // Synthetic metric: bigger chunks -> higher nDCG, lower precision, so
        // the test can assert the curve is captured per cell.
        return {
          jsonPath: '/tmp/x.json',
          trecPath: '/tmp/x.trec',
          reportPath: '/tmp/x.md',
          report: {
            metrics: {
              judgedQueries: 5,
              ndcgAt10: size / 10000,
              mapAt100: 0,
              precisionAt10: 1000 / size / 10,
              recallAt10: 0.5,
              recallAt100: 0.6,
            },
            dataset: { name: dataset, queries_evaluated: 5 },
          } as BeirBenchmarkRunResult['report'],
        };
      },
    };

    const { report } = await runChunkSweep({
      datasets: ['scifact', 'fiqa'],
      chunkSizes: [500, 1000],
      chunkOverlaps: [100, 200],
      mode: 'hybrid',
      provider: 'ollama',
      model: 'nomic-embed-text',
      split: 'test',
      outputDir: path.join(root, 'out'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'kb-beir-ws'),
    }, deps);

    // 2 datasets × (2 sizes × 2 overlaps) = 8 points.
    expect(report.points).toHaveLength(8);
    expect(seenEnv).toHaveLength(8);
    // The env was actually set per cell when the benchmark ran.
    expect(seenEnv).toContainEqual({ size: '500', overlap: '100' });
    expect(seenEnv).toContainEqual({ size: '1000', overlap: '200' });
    // Metrics captured from the (synthetic) benchmark report.
    const scifact1000 = report.points.find(
      (p) => p.dataset === 'scifact' && p.chunkSize === 1000 && p.chunkOverlap === 100,
    );
    expect(scifact1000).toMatchObject({ ndcgAt10: 0.1, precisionAt10: 0.1, queriesEvaluated: 5 });

    // Env restored to its pre-sweep value.
    expect(process.env.KB_CHUNK_SIZE).toBe(beforeSize);
    expect(process.env.KB_CHUNK_OVERLAP).toBe(beforeOverlap);

    // The JSON + markdown artifacts were written.
    const written = await fsp.readFile(path.join(root, 'out', 'chunk-sweep-hybrid.json'), 'utf-8');
    expect(JSON.parse(written).schema_version).toBe('kb.beir-chunk-sweep.v1');
    const md = await fsp.readFile(path.join(root, 'out', 'chunk-sweep-hybrid.md'), 'utf-8');
    expect(md).toContain('nDCG@10');
    expect(md).toContain('precision@10');

    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('formatChunkSweepMarkdown', () => {
  it('renders one nDCG@10 and one precision@10 table per dataset', () => {
    const report: ChunkSweepReport = {
      schema_version: 'kb.beir-chunk-sweep.v1',
      generated_at: '2026-06-08T00:00:00.000Z',
      git_sha: 'abc',
      mode: 'hybrid',
      provider: 'ollama',
      model: 'nomic-embed-text',
      datasets: ['scifact'],
      chunk_sizes: [500, 1000],
      chunk_overlaps: [100, 200],
      points: [
        { dataset: 'scifact', chunkSize: 500, chunkOverlap: 100, ndcgAt10: 0.7, precisionAt10: 0.12, recallAt10: 0.8, queriesEvaluated: 5 },
        { dataset: 'scifact', chunkSize: 500, chunkOverlap: 200, ndcgAt10: 0.71, precisionAt10: 0.13, recallAt10: 0.8, queriesEvaluated: 5 },
        { dataset: 'scifact', chunkSize: 1000, chunkOverlap: 100, ndcgAt10: 0.74, precisionAt10: 0.11, recallAt10: 0.8, queriesEvaluated: 5 },
        { dataset: 'scifact', chunkSize: 1000, chunkOverlap: 200, ndcgAt10: 0.75, precisionAt10: 0.10, recallAt10: 0.8, queriesEvaluated: 5 },
      ],
    };
    const md = formatChunkSweepMarkdown(report);
    expect(md).toContain('## scifact');
    expect(md).toContain('### nDCG@10');
    expect(md).toContain('### precision@10');
    expect(md).toContain('0.7400');
    expect(md).toContain('0.1000');
  });
});
