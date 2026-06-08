import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  runBeirBenchmark,
  type BeirSearchBackend,
  type LoadSearchBackendInput,
  type RunDependencies,
} from './run.js';

// RFC 020 M1 failure-mode test ("benchmark-only retrieval path drifts from
// production"): the `hybrid+rerank` and `hybrid+rerank+contextual` modes must
// drive the SHIPPED src/ paths — the cross-encoder in `src/reranker.ts` and the
// RFC 017 contextual-preface ingest in `buildChunkDocuments` — not a
// benchmark-only reimplementation. These tests run the production retrieval
// entrypoint with the deterministic `fake` embedding provider, inject a fake
// cross-encoder via the production `setRerankerFactoryForTests` seam (so no
// model downloads), and assert (a) the production reranker is invoked for the
// rerank modes and skipped for plain hybrid, and (b) the contextual ingest path
// generated prefaces via the production sidecar.
//
// As in run.dense.test.ts, every production-path run shares ONE workspace root:
// src/config/paths.ts freezes KNOWLEDGE_BASES_ROOT_DIR / FAISS_INDEX_PATH into
// module-level consts on first import.

const baseDeps = {
  gitSha: async () => 'test-sha',
  now: () => new Date('2026-06-08T00:00:00.000Z'),
  pythonVersion: async () => null,
  silenceServerLogger: async () => undefined,
  loadLexicalIndex: async () => {
    throw new Error('loadLexicalIndex should not be called for hybrid+rerank modes');
  },
} satisfies Omit<RunDependencies, 'loadSearchBackend'>;

async function writeTinyBeirDataset(root: string): Promise<string> {
  const datasetDir = path.join(root, 'tiny');
  await fsp.mkdir(path.join(datasetDir, 'qrels'), { recursive: true });
  await fsp.writeFile(path.join(datasetDir, 'corpus.jsonl'), [
    JSON.stringify({ _id: 'doc-alpha', title: 'Alpha', text: 'Alpha gravity wave detection evidence and analysis.' }),
    JSON.stringify({ _id: 'doc-beta', title: 'Beta', text: 'Beta culinary recipe for a hearty tomato soup.' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'queries.jsonl'), [
    JSON.stringify({ _id: 'q1', text: 'alpha gravity wave detection' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'qrels', 'test.tsv'), [
    'query-id corpus-id score',
    'q1 doc-alpha 1',
    '',
  ].join('\n'), 'utf-8');
  return datasetDir;
}

interface RerankProbe {
  calls: Array<{ query: string; candidates: string[] }>;
}

// A unique reranker id per backend load keeps the production rerank-score cache
// (`globalRerankScoreCache`, keyed by model id + query + candidate text) from
// masking a fresh invocation: the pageContent is byte-identical across modes
// (the contextual preface only changes the embedded text, not pageContent), so
// without a unique id the second rerank run would be an all-cache-hit and never
// call our probe.
let rerankerInstanceCounter = 0;

/**
 * Build the production fake backend AND install a fake cross-encoder through the
 * production `setRerankerFactoryForTests` seam. The returned `restore` undoes
 * the factory swap. `probe.calls` records every production rerank invocation so
 * a test can assert the shipped reranker actually ran.
 */
async function loadProductionRerankBackend(
  input: LoadSearchBackendInput,
  probe: RerankProbe,
): Promise<{ backend: BeirSearchBackend; restoreReranker: () => void }> {
  const fim = await import('../../src/FaissIndexManager.js');
  const evalModule = await import('../../src/retrieval-eval.js');
  const rerankerModule = await import('../../src/reranker.js');

  // A deterministic cross-encoder: it scores by candidate length so order is
  // stable, and records the call so the test can prove the production path
  // reached `src/reranker.ts`.
  rerankerInstanceCounter += 1;
  const rerankerId = `fake-cross-encoder-${rerankerInstanceCounter}`;
  const restoreReranker = rerankerModule.setRerankerFactoryForTests(async () => ({
    id: rerankerId,
    rerank: async (query: string, candidates: string[]): Promise<number[]> => {
      probe.calls.push({ query, candidates });
      return candidates.map((text) => 1 / (1 + text.length));
    },
  }));

  await fim.FaissIndexManager.bootstrapLayout();
  const manager = new fim.FaissIndexManager(
    { provider: 'fake', modelName: input.modelName } as unknown as ConstructorParameters<typeof fim.FaissIndexManager>[0],
  );
  await manager.initialize();

  const backend: BeirSearchBackend = {
    implementation: `production ${input.mode} path (src/retrieval-eval + FaissIndexManager, fake provider)`,
    prepare: async () => {
      await manager.updateIndex();
      const summary = manager.getLastIndexUpdateSummary();
      return { files: summary.files_scanned, chunks: summary.chunks_added };
    },
    search: async (query, fetchK) => {
      const result = await evalModule.retrieveForRetrievalEvalCase(
        {
          name: 'beir',
          query,
          kb: input.kbName,
          k: fetchK,
          threshold: Number.POSITIVE_INFINITY,
          requiredSources: [],
          forbiddenSources: [],
          expectedMetadata: [],
          stalePolicy: 'allow_stale',
        },
        { manager, defaultK: fetchK, defaultThreshold: Number.POSITIVE_INFINITY },
        input.mode,
      );
      return result.results.map((r) => ({
        metadata: r.metadata as Record<string, unknown>,
        score: typeof r.score === 'number' ? r.score : 0,
      }));
    },
  };
  return { backend, restoreReranker };
}

describe('BEIR runner hybrid+rerank / +contextual modes (production paths)', () => {
  let root: string;
  let datasetDir: string;
  let workspace: string;
  let savedLogLevel: string | undefined;
  let savedFake: string | undefined;

  beforeAll(async () => {
    savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'error';
    // The +contextual mode generates prefaces at ingest; the fake LLM keeps that
    // network-free and deterministic. The runner enables KB_CONTEXTUAL_RETRIEVAL
    // itself per mode, but the endpoint (here, the fake) comes from the env.
    savedFake = process.env.KB_LLM_FAKE;
    process.env.KB_LLM_FAKE = 'on';
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-rerank-'));
    datasetDir = await writeTinyBeirDataset(root);
    workspace = path.join(root, 'kb-beir-ws');
  });

  afterAll(async () => {
    if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLogLevel;
    if (savedFake === undefined) delete process.env.KB_LLM_FAKE;
    else process.env.KB_LLM_FAKE = savedFake;
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function runMode(mode: string, probe: RerankProbe) {
    let restoreReranker = (): void => undefined;
    const loadSearchBackend = async (input: LoadSearchBackendInput): Promise<BeirSearchBackend> => {
      const built = await loadProductionRerankBackend(input, probe);
      restoreReranker = built.restoreReranker;
      return built.backend;
    };
    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      `--mode=${mode}`,
      '--provider=fake',
      `--output-dir=${path.join(root, `out-${mode.replace(/\+/g, '_')}`)}`,
      `--workspace-root=${workspace}`,
      '--k=10',
      '--chunk-k=20',
      '--keep-workspace',
    ]);
    try {
      return await runBeirBenchmark(args, { ...baseDeps, loadSearchBackend });
    } finally {
      restoreReranker();
    }
  }

  it('drives the production src/reranker.ts cross-encoder for hybrid+rerank', async () => {
    const probe: RerankProbe = { calls: [] };
    const result = await runMode('hybrid+rerank', probe);

    // The shipped reranker was invoked through the production hybrid path.
    expect(probe.calls.length).toBeGreaterThan(0);
    expect(probe.calls[0].query).toBe('alpha gravity wave detection');
    expect(probe.calls[0].candidates.length).toBeGreaterThan(0);

    // Provenance reflects the rerank stage.
    expect(result.report.mode).toBe('hybrid+rerank');
    expect(result.report.rerank).toMatchObject({ enabled: true, topN: 40 });
    expect(result.report.contextual).toEqual({ enabled: false });
    expect(result.report.ranking.implementation).toContain('src/reranker.ts');
    expect(result.report.metrics.recallAt10).toBe(1);
  }, 60_000);

  it('does NOT rerank for plain hybrid (mode isolation of KB_RERANK)', async () => {
    const probe: RerankProbe = { calls: [] };
    const result = await runMode('hybrid', probe);
    expect(probe.calls.length).toBe(0);
    expect(result.report.rerank).toEqual({ enabled: false, model: expect.any(String), topN: 40 });
    expect(result.report.contextual).toEqual({ enabled: false });
  }, 60_000);

  it('drives the production reranker AND the RFC 017 contextual ingest for hybrid+rerank+contextual', async () => {
    const probe: RerankProbe = { calls: [] };
    const result = await runMode('hybrid+rerank+contextual', probe);

    expect(probe.calls.length).toBeGreaterThan(0);
    expect(result.report.mode).toBe('hybrid+rerank+contextual');
    expect(result.report.rerank?.enabled).toBe(true);
    expect(result.report.contextual).toEqual({ enabled: true });
    expect(result.report.ranking.implementation).toContain('contextual prefaces at ingest');

    // The contextual ingest path actually generated prefaces via the production
    // sidecar (proves it was the RFC 017 code, not a stub). Read through the
    // production aggregator so we depend on the shipped on-disk contract.
    const contextual = await import('../../src/contextual-preface.js');
    const stats = await contextual.aggregateContextualSidecarStats('tiny');
    expect(stats.sidecar_count).toBeGreaterThan(0);
    expect(stats.covered_chunks).toBeGreaterThan(0);
  }, 60_000);

  it('fails loudly when +contextual has no LLM endpoint configured', async () => {
    const saved = process.env.KB_LLM_FAKE;
    delete process.env.KB_LLM_FAKE;
    try {
      const args = parseArgs([
        '--dataset=tiny',
        `--dataset-dir=${datasetDir}`,
        '--mode=hybrid+rerank+contextual',
        '--provider=fake',
        `--output-dir=${path.join(root, 'out-noendpoint')}`,
        `--workspace-root=${workspace}`,
        '--k=10',
      ]);
      await expect(runBeirBenchmark(args, {
        ...baseDeps,
        loadSearchBackend: async () => {
          throw new Error('backend should not load when the contextual endpoint check fails');
        },
      })).rejects.toThrow(/needs an LLM endpoint/);
    } finally {
      if (saved === undefined) delete process.env.KB_LLM_FAKE;
      else process.env.KB_LLM_FAKE = saved;
    }
  });
});
