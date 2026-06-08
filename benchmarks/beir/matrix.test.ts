import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  captureRetrievalEnv,
  formatMatrixMarkdown,
  parseMatrixArgs,
  runBeirMatrix,
  type MatrixDependencies,
  type MatrixReport,
} from './matrix.js';
import type { BeirBenchmarkRunResult } from './run.js';

// Synthetic per-(dataset × mode) nDCG: hybrid beats lexical, and tuned datasets
// score higher than the reserved unseen set, so Δ_g is a clean positive number.
const SCORES: Record<string, Record<string, number>> = {
  scifact: { lexical: 0.60, hybrid: 0.80 },
  nfcorpus: { lexical: 0.50, hybrid: 0.70 },
  fiqa: { lexical: 0.40, hybrid: 0.60 }, // tuned mean: lexical .50, hybrid .70
  arguana: { lexical: 0.30, hybrid: 0.50 },
  scidocs: { lexical: 0.20, hybrid: 0.40 },
  'webis-touche2020': { lexical: 0.40, hybrid: 0.50 }, // unseen mean: lex .30, hyb .4667
};

function stubResult(dataset: string, mode: string): BeirBenchmarkRunResult {
  const ndcg = SCORES[dataset]?.[mode] ?? 0.1;
  return {
    jsonPath: `/tmp/${dataset}-${mode}.json`,
    trecPath: `/tmp/${dataset}-${mode}.trec`,
    reportPath: `/tmp/${dataset}-${mode}.md`,
    report: {
      git_sha: 'matrix-sha',
      dataset: { name: dataset, split: 'test', queries_evaluated: 10 },
      mode,
      embedding: mode === 'lexical' ? null : { provider: 'fake', model: 'fake-embeddings' },
      rerank: null,
      contextual: null,
      chunking: { KB_CHUNK_SIZE: null, KB_CHUNK_OVERLAP: null },
      metrics: {
        judgedQueries: 10,
        ndcgAt10: ndcg,
        mapAt100: ndcg * 0.9,
        precisionAt10: 0.1,
        recallAt10: ndcg + 0.1,
        recallAt100: ndcg + 0.2,
      },
      latency: { queries: 10, p50Ms: 5, p95Ms: 9, p99Ms: 11, meanMs: 6 },
    } as unknown as BeirBenchmarkRunResult['report'],
  };
}

function stubDeps(overrides: Partial<MatrixDependencies> = {}): {
  deps: MatrixDependencies;
  loggedRuns: string[];
  loggedMatrix: MatrixReport[];
} {
  const loggedRuns: string[] = [];
  const loggedMatrix: MatrixReport[] = [];
  const deps: MatrixDependencies = {
    runBenchmark: async (argv) => {
      const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? 'unknown';
      const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'lexical';
      return stubResult(dataset, mode);
    },
    gitSha: async () => 'matrix-sha',
    now: () => new Date('2026-06-08T00:00:00.000Z'),
    logRun: async (report) => { loggedRuns.push(`${report.dataset.name}:${report.mode}`); },
    logMatrix: async (report) => { loggedMatrix.push(report); },
    ...overrides,
  };
  return { deps, loggedRuns, loggedMatrix };
}

describe('captureRetrievalEnv', () => {
  it('records the full retrieval env, defaulting to production constants', () => {
    const env = captureRetrievalEnv({ provider: 'ollama', model: 'nomic-embed-text' }, {});
    expect(env).toEqual({
      embedding_provider: 'ollama',
      embedding_model: 'nomic-embed-text',
      rrf_c: '60',
      rerank_model: 'Xenova/ms-marco-MiniLM-L-6-v2',
      rerank_top_n: '40',
      chunk_size: '1000',
      chunk_overlap: '200',
      contextual: 'off',
      retrieval_views: null,
    });
  });

  it('reads overrides from env', () => {
    const env = captureRetrievalEnv({}, {
      EMBEDDING_PROVIDER: 'ollama',
      KB_RRF_C: '90',
      KB_RERANK_MODEL: 'BAAI/bge-reranker-v2-m3',
      KB_RERANK_TOP_N: '20',
      KB_CHUNK_SIZE: '1500',
      KB_CHUNK_OVERLAP: '300',
      KB_CONTEXTUAL_RETRIEVAL: 'on',
    });
    expect(env).toMatchObject({
      embedding_provider: 'ollama',
      rrf_c: '90',
      rerank_model: 'BAAI/bge-reranker-v2-m3',
      rerank_top_n: '20',
      chunk_size: '1500',
      chunk_overlap: '300',
      contextual: 'on',
    });
  });
});

describe('parseMatrixArgs', () => {
  it('defaults to the downloadable full set and lexical,hybrid', () => {
    const options = parseMatrixArgs([]);
    expect(options.modes).toEqual(['lexical', 'hybrid']);
    expect(options.datasets).toContain('scifact');
    expect(options.datasets).not.toContain('cqadupstack'); // no single-zip download
    expect(options.continueOnError).toBe(true);
  });

  it('parses overrides incl. --fail-fast', () => {
    const options = parseMatrixArgs([
      '--datasets=scifact,arguana', '--modes=lexical,hybrid,hybrid+rerank',
      '--provider=ollama', '--model=nomic-embed-text', '--retrieval-views=section,metadata', '--fail-fast',
    ]);
    expect(options).toMatchObject({
      datasets: ['scifact', 'arguana'],
      modes: ['lexical', 'hybrid', 'hybrid+rerank'],
      provider: 'ollama',
      model: 'nomic-embed-text',
      retrievalViews: 'section,metadata',
      continueOnError: false,
    });
  });

  it('rejects an unknown mode', () => {
    expect(() => parseMatrixArgs(['--modes=lexical,bogus'])).toThrow(/must be one of/);
  });
});

describe('runBeirMatrix', () => {
  it('produces one cell per (dataset × mode), the per-mode mean, Δ_g, and logs every run', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-matrix-test-'));
    const { deps, loggedRuns, loggedMatrix } = stubDeps();
    const datasets = ['scifact', 'nfcorpus', 'fiqa', 'arguana', 'scidocs', 'webis-touche2020'];

    const { report, reportPath, markdownPath } = await runBeirMatrix({
      datasets,
      modes: ['lexical', 'hybrid'],
      provider: 'fake',
      model: 'fake-embeddings',
      split: 'test',
      outputDir: path.join(root, 'out'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'kb-beir-ws'),
      continueOnError: true,
    }, deps);

    // 6 datasets × 2 modes = 12 cells, all ok.
    expect(report.cells).toHaveLength(12);
    expect(report.cells.every((c) => c.status === 'ok')).toBe(true);

    // Headline: hybrid mean over the 6 datasets = (.8+.7+.6+.5+.4+.5)/6 = 0.5833..
    const hybrid = report.perMode.find((m) => m.mode === 'hybrid');
    expect(hybrid?.datasetsEvaluated).toBe(6);
    expect(hybrid?.multiDomainMeanNdcgAt10).toBeCloseTo(0.583333, 5);

    // Δ_g for hybrid: seen mean .70, unseen mean .46667 → (.7-.46667)/.7 = .3333
    const hybridGen = report.generalization.modes.find((m) => m.mode === 'hybrid');
    expect(hybridGen?.deltaG.deltaG).toBeCloseTo(0.333333, 4);

    // Every run wired into the ledger; the matrix logged once.
    expect(loggedRuns).toHaveLength(12);
    expect(loggedRuns).toContain('scifact:hybrid');
    expect(loggedMatrix).toHaveLength(1);

    // Artifacts written; markdown carries the headline section.
    expect(JSON.parse(await fsp.readFile(reportPath, 'utf-8')).schema_version).toBe('kb.beir-matrix.v1');
    const md = await fsp.readFile(markdownPath, 'utf-8');
    expect(md).toContain('multi-domain mean nDCG@10');
    expect(md).toContain('Δ_g');

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('records a failed cell, excludes it from the mean, and keeps going', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-matrix-err-'));
    const { deps, loggedRuns } = stubDeps({
      runBenchmark: async (argv) => {
        const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? 'unknown';
        const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'lexical';
        if (dataset === 'nfcorpus') throw new Error('dataset not cached');
        return stubResult(dataset, mode);
      },
    });

    const { report } = await runBeirMatrix({
      datasets: ['scifact', 'nfcorpus', 'fiqa'],
      modes: ['hybrid'],
      provider: 'fake',
      model: 'fake-embeddings',
      split: 'test',
      outputDir: path.join(root, 'out'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'ws'),
      continueOnError: true,
    }, deps);

    const failed = report.cells.find((c) => c.dataset === 'nfcorpus');
    expect(failed?.status).toBe('error');
    expect(failed?.error).toMatch(/not cached/);
    // Mean over the 2 successful datasets only (scifact .8, fiqa .6 → .7).
    const hybrid = report.perMode.find((m) => m.mode === 'hybrid');
    expect(hybrid?.datasetsEvaluated).toBe(2);
    expect(hybrid?.multiDomainMeanNdcgAt10).toBeCloseTo(0.7, 6);
    // Failed runs are NOT logged to the ledger.
    expect(loggedRuns).toEqual(['scifact:hybrid', 'fiqa:hybrid']);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('forwards retrieval view flags to non-lexical BEIR cells', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-matrix-views-'));
    const seenArgv: string[][] = [];
    const { deps } = stubDeps({
      runBenchmark: async (argv) => {
        seenArgv.push(argv);
        const dataset = argv.find((a) => a.startsWith('--dataset='))?.split('=')[1] ?? 'unknown';
        const mode = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'lexical';
        return stubResult(dataset, mode);
      },
    });

    await runBeirMatrix({
      datasets: ['scifact'],
      modes: ['lexical', 'hybrid'],
      provider: 'fake',
      model: 'fake-embeddings',
      retrievalViews: 'section,metadata',
      split: 'test',
      outputDir: path.join(root, 'out'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'ws'),
      continueOnError: true,
    }, deps);

    expect(seenArgv.find((argv) => argv.includes('--mode=lexical'))).not.toContain('--retrieval-views=section,metadata');
    expect(seenArgv.find((argv) => argv.includes('--mode=hybrid'))).toContain('--retrieval-views=section,metadata');
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('--fail-fast (continueOnError=false) re-throws the first cell error', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-matrix-ff-'));
    const { deps } = stubDeps({
      runBenchmark: async () => { throw new Error('boom'); },
    });
    await expect(runBeirMatrix({
      datasets: ['scifact'],
      modes: ['hybrid'],
      split: 'test',
      outputDir: path.join(root, 'out'),
      cacheDir: path.join(root, 'cache'),
      workspaceRoot: path.join(root, 'ws'),
      continueOnError: false,
    }, deps)).rejects.toThrow(/boom/);
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('formatMatrixMarkdown', () => {
  it('renders the headline, contamination, and excluded-cell sections', () => {
    const report: MatrixReport = {
      schema_version: 'kb.beir-matrix.v1',
      generated_at: '2026-06-08T00:00:00.000Z',
      git_sha: 'abc',
      modes: ['hybrid'],
      datasets: ['scifact', 'nfcorpus'],
      env: captureRetrievalEnv({ provider: 'ollama', model: 'nomic-embed-text' }, {}),
      cells: [
        {
          dataset: 'scifact', domain: 'scientific fact-checking', mode: 'hybrid', status: 'ok',
          ndcgAt10: 0.8, precisionAt10: 0.2, mapAt100: 0.7, recallAt10: 0.9, recallAt100: 1,
          queriesEvaluated: 10, latencyP50Ms: 5, latencyP95Ms: 9, latencyP99Ms: 11,
          jsonPath: 'a.json', trecPath: 'a.trec',
        },
        {
          dataset: 'nfcorpus', domain: 'bio-medical', mode: 'hybrid', status: 'error',
          ndcgAt10: 0, precisionAt10: 0, mapAt100: 0, recallAt10: 0, recallAt100: 0,
          queriesEvaluated: 0, latencyP50Ms: 0, latencyP95Ms: 0, latencyP99Ms: 0,
          jsonPath: null, trecPath: null, error: 'not cached',
        },
      ],
      perMode: [{
        mode: 'hybrid', datasetsEvaluated: 1, datasetsRequested: 2,
        multiDomainMeanNdcgAt10: 0.8, multiDomainMeanPrecisionAt10: 0.2, multiDomainMeanRecallAt10: 0.9,
      }],
      generalization: {
        modes: [{
          mode: 'hybrid',
          domains: [{ domain: 'scientific fact-checking', datasets: ['scifact'], meanNdcgAt10: 0.8, meanPrecisionAt10: 0.2, queriesEvaluated: 10 }],
          deltaG: { mode: 'hybrid', seenDatasets: ['scifact'], unseenDatasets: [], seenMeanNdcgAt10: 0.8, unseenMeanNdcgAt10: null, deltaG: null },
        }],
        tunedDatasets: ['scifact', 'nfcorpus', 'fiqa'],
        unseenGeneralityDatasets: ['arguana', 'scidocs', 'webis-touche2020'],
      },
      contamination: [
        { dataset: 'scifact', knownInPretraining: false, qrels: 'expert', note: 'expert claims' },
        { dataset: 'nfcorpus', knownInPretraining: false, qrels: 'expert', note: 'medical' },
      ],
    };
    const md = formatMatrixMarkdown(report);
    expect(md).toContain('| hybrid | 1/2 | 0.8000 |');
    expect(md).toContain('Contamination notes');
    expect(md).toContain('Excluded cells');
    expect(md).toContain('not cached');
  });
});
