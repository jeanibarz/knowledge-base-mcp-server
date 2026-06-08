import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runBright, parseBrightArgs, type BrightRunDependencies } from './run.js';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type LexicalIndexLike,
} from '../beir/run.js';
import { parseQrelsTsv } from '../beir/metrics.js';
import type { BrightTaskData } from './adapter.js';

const TASK: BrightTaskData = {
  documents: [
    { id: 'd-bio-1', content: 'Mitochondria generate ATP via oxidative phosphorylation in the cell.' },
    { id: 'd-bio-2', content: 'Photosynthesis converts light into chemical energy in chloroplasts.' },
    { id: 'd-bio-3', content: 'Ribosomes translate messenger RNA into proteins.' },
  ],
  examples: [
    { id: 'b1', query: 'where is ATP produced in the cell', gold_ids: ['d-bio-1'], excluded_ids: [] },
    { id: 'b2', query: 'how do plants make energy from light', gold_ids: ['d-bio-2'] },
  ],
};

describe('runBright', () => {
  it('materialises each task into a BEIR dataset dir and records a report point per (task × mode)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-run-'));
    const seen: Array<{ dataset?: string; datasetDir?: string; mode?: string }> = [];

    const deps: BrightRunDependencies = {
      loadTask: async () => TASK,
      gitSha: async () => 'test-sha',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
      runBenchmark: async (argv): Promise<BeirBenchmarkRunResult> => {
        const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
        const datasetDir = arg('dataset-dir')!;
        // The adapter must have produced a BEIR-shaped dataset dir the runner consumes.
        const corpus = await fsp.readFile(path.join(datasetDir, 'corpus.jsonl'), 'utf-8');
        const qrels = parseQrelsTsv(await fsp.readFile(path.join(datasetDir, 'qrels', 'test.tsv'), 'utf-8'));
        expect(corpus.trim().split('\n')).toHaveLength(3);
        expect(qrels.byQuery.size).toBe(2);
        seen.push({ dataset: arg('dataset'), datasetDir, mode: arg('mode') });
        return {
          jsonPath: '', trecPath: '', reportPath: '',
          report: {
            dataset: { queries_evaluated: 2 },
            metrics: { ndcgAt10: arg('mode') === 'hybrid+rerank' ? 0.6 : 0.4, precisionAt10: 0.1, recallAt10: 0.5 },
          } as unknown as BeirBenchmarkRunResult['report'],
        };
      },
    };

    const result = await runBright({
      tasks: ['biology'],
      modes: ['dense', 'hybrid+rerank'],
      brightDir: '/unused-because-loadTask-is-mocked',
      provider: 'ollama',
      model: 'nomic-embed-text',
      split: 'test',
      outputDir: path.join(root, 'out'),
      datasetsDir: path.join(root, 'datasets'),
      workspaceRoot: path.join(root, 'ws'),
      cacheDir: path.join(root, 'cache'),
    }, deps);

    expect(seen.map((s) => `${s.dataset}:${s.mode}`)).toEqual(['biology:dense', 'biology:hybrid+rerank']);
    expect(result.points).toEqual([
      expect.objectContaining({ task: 'biology', mode: 'dense', ndcgAt10: 0.4 }),
      expect.objectContaining({ task: 'biology', mode: 'hybrid+rerank', ndcgAt10: 0.6 }),
    ]);

    const reportJson = JSON.parse(await fsp.readFile(result.reportPath, 'utf-8'));
    expect(reportJson.schema_version).toBe('kb.bright-report.v1');
    const md = await fsp.readFile(path.join(root, 'out', 'bright-report.md'), 'utf-8');
    expect(md).toContain('hybrid+rerank vs dense');

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('records a failed point (never throws) when a task cannot be loaded', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-loadfail-'));
    const deps: BrightRunDependencies = {
      loadTask: async () => { throw new Error('no examples.jsonl'); },
      gitSha: async () => 'test-sha',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
      runBenchmark: async () => { throw new Error('runBenchmark should not be called when load fails'); },
    };
    const result = await runBright({
      tasks: ['biology'],
      modes: ['dense'],
      brightDir: '/missing',
      split: 'test',
      outputDir: path.join(root, 'out'),
      datasetsDir: path.join(root, 'datasets'),
      workspaceRoot: path.join(root, 'ws'),
      cacheDir: path.join(root, 'cache'),
    }, deps);
    expect(result.points[0].error).toContain('no examples.jsonl');
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('drives the REAL BEIR runner (lexical) over the materialised BRIGHT data — same runner seam', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-seam-'));
    const deps: BrightRunDependencies = {
      loadTask: async () => TASK,
      gitSha: async () => 'test-sha',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
      // The injected runner is the genuine runBeirBenchmark with a mocked lexical
      // index — so BRIGHT data flows through the production scorer, proving the
      // adapter output is consumable by the unchanged BEIR runner.
      runBenchmark: (argv) => runBeirBenchmark(parseBeirArgs(argv), {
        gitSha: async () => 'test-sha',
        now: () => new Date('2026-06-08T00:00:00.000Z'),
        pythonVersion: async () => null,
        silenceServerLogger: async () => undefined,
        loadSearchBackend: async () => { throw new Error('lexical mode must not load the dense backend'); },
        loadLexicalIndex: async (_buildRoot, _kbName, kbPath): Promise<LexicalIndexLike> => {
          const files = await fsp.readdir(kbPath);
          return {
            refresh: async () => ({ added: files.length, updated: 0, removed: 0, failed: 0, totalFiles: files.length, totalChunks: files.length }),
            save: async () => undefined,
            // Rank the gold document first for every query: the file whose name
            // carries the gold doc id. b1→d-bio-1, b2→d-bio-2.
            query: async (queryText) => {
              const goldId = queryText.includes('light') ? 'd-bio-2' : 'd-bio-1';
              const goldFile = files.find((f) => f.includes(goldId));
              if (goldFile === undefined) throw new Error(`no file for ${goldId}`);
              return [{ metadata: { source: path.join(kbPath, goldFile) }, score: 10 }];
            },
            numChunks: () => files.length,
            numFiles: () => files.length,
          };
        },
      }),
    };

    const result = await runBright({
      tasks: ['biology'],
      modes: ['lexical'],
      brightDir: '/unused',
      split: 'test',
      outputDir: path.join(root, 'out'),
      datasetsDir: path.join(root, 'datasets'),
      workspaceRoot: path.join(root, 'kb-beir-bright-seam'),
      cacheDir: path.join(root, 'cache'),
    }, deps);

    // Gold doc ranked first for both queries → perfect nDCG@10 through the real scorer.
    expect(result.points[0]).toMatchObject({ task: 'biology', mode: 'lexical', ndcgAt10: 1, queriesEvaluated: 2 });

    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('parseBrightArgs', () => {
  it('defaults to all 12 tasks and the dense + hybrid+rerank comparison', () => {
    const options = parseBrightArgs([]);
    expect(options.tasks).toHaveLength(12);
    expect(options.modes).toEqual(['dense', 'hybrid+rerank']);
  });

  it('parses an explicit task and mode selection', () => {
    const options = parseBrightArgs(['--tasks=biology,economics', '--modes=lexical,dense', '--bright-dir=/data/bright']);
    expect(options.tasks).toEqual(['biology', 'economics']);
    expect(options.modes).toEqual(['lexical', 'dense']);
    expect(options.brightDir).toBe('/data/bright');
  });

  it('rejects an unknown task', () => {
    expect(() => parseBrightArgs(['--tasks=not-a-task'])).toThrow(/unknown BRIGHT task/);
  });
});
