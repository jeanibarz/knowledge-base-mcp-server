import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runBright, parseBrightArgs, type BrightRunDependencies } from './run.js';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirSearchBackend,
  type LoadSearchBackendInput,
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

  it('drives the real BEIR hybrid path with non-default RRF weights over materialised BRIGHT data', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-seam-'));
    const previousDense = process.env.KB_HYBRID_DENSE_WEIGHT;
    const previousLexical = process.env.KB_HYBRID_LEXICAL_WEIGHT;
    process.env.KB_HYBRID_DENSE_WEIGHT = '0';
    process.env.KB_HYBRID_LEXICAL_WEIGHT = '2';
    const deps: BrightRunDependencies = {
      loadTask: async () => TASK,
      gitSha: async () => 'test-sha',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
      // The injected runner is the genuine BEIR runner. Its backend calls the
      // production retrieval-eval hybrid path with deterministic dense and
      // lexical legs so the BRIGHT adapter, RRF weights, and scorer are all live.
      runBenchmark: (argv) => runBeirBenchmark(parseBeirArgs(argv), {
        gitSha: async () => 'test-sha',
        now: () => new Date('2026-06-08T00:00:00.000Z'),
        pythonVersion: async () => null,
        silenceServerLogger: async () => undefined,
        loadLexicalIndex: async () => { throw new Error('hybrid backend supplies its lexical leg'); },
        loadSearchBackend: async (input: LoadSearchBackendInput): Promise<BeirSearchBackend> => {
          const evalModule = await import('../../src/retrieval-eval.js');
          return {
            implementation: 'production retrieval-eval hybrid path with deterministic legs',
            prepare: async () => ({ files: TASK.documents.length, chunks: TASK.documents.length }),
            search: async (query, fetchK) => {
              const kbRoot = process.env.KNOWLEDGE_BASES_ROOT_DIR;
              if (kbRoot === undefined) throw new Error('BEIR workspace root was not configured');
              const kbPath = path.join(kbRoot, input.kbName);
              const files = await fsp.readdir(kbPath);
              const goldId = query.includes('light') ? 'd-bio-2' : 'd-bio-1';
              const goldFile = files.find((file) => file.includes(goldId));
              const distractorFile = files.find((file) => file.includes('d-bio-3'));
              if (goldFile === undefined || distractorFile === undefined) {
                throw new Error(`missing materialised BRIGHT files for ${goldId}`);
              }
              const makeDoc = (file: string, score: number) => ({
                pageContent: file,
                metadata: {
                  source: path.join(kbPath, file),
                  relativePath: `${input.kbName}/${file}`,
                  knowledgeBase: input.kbName,
                  chunkIndex: 0,
                },
                score,
              });
              const result = await evalModule.retrieveForRetrievalEvalCase({
                name: 'bright',
                query,
                kb: input.kbName,
                k: fetchK,
                threshold: Number.POSITIVE_INFINITY,
                requiredSources: [],
                forbiddenSources: [],
                expectedMetadata: [],
                stalePolicy: 'allow_stale',
              }, {
                defaultK: fetchK,
                defaultThreshold: Number.POSITIVE_INFINITY,
                manager: { similaritySearch: async () => [makeDoc(distractorFile, 0.1)] },
                retrieveLexical: async () => [makeDoc(goldFile, 10)],
              }, 'hybrid');
              return result.results.map((entry) => ({
                metadata: entry.metadata,
                score: entry.score ?? 0,
              }));
            },
          };
        },
      }),
    };

    let result: Awaited<ReturnType<typeof runBright>>;
    try {
      result = await runBright({
        tasks: ['biology'],
        modes: ['hybrid'],
        brightDir: '/unused',
        provider: 'fake',
        split: 'test',
        outputDir: path.join(root, 'out'),
        datasetsDir: path.join(root, 'datasets'),
        workspaceRoot: path.join(root, 'kb-beir-bright-seam'),
        cacheDir: path.join(root, 'cache'),
      }, deps);
    } finally {
      if (previousDense === undefined) delete process.env.KB_HYBRID_DENSE_WEIGHT;
      else process.env.KB_HYBRID_DENSE_WEIGHT = previousDense;
      if (previousLexical === undefined) delete process.env.KB_HYBRID_LEXICAL_WEIGHT;
      else process.env.KB_HYBRID_LEXICAL_WEIGHT = previousLexical;
    }

    // Dense is disabled and the lexical leg ranks each gold doc first, so the
    // production weighted fusion produces perfect nDCG through the real scorer.
    expect(result.points[0]).toMatchObject({ task: 'biology', mode: 'hybrid', ndcgAt10: 1, queriesEvaluated: 2 });

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
