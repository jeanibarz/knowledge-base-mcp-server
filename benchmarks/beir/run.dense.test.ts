import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  resolveEmbeddingSpec,
  runBeirBenchmark,
  type BeirSearchBackend,
  type LoadSearchBackendInput,
  type RunDependencies,
} from './run.js';

// IMPORTANT: this file must never *statically* import anything from `src/`.
// `src/config/paths.ts` resolves KNOWLEDGE_BASES_ROOT_DIR / FAISS_INDEX_PATH
// into `const`s at module-load time, so the production code must be imported
// only AFTER the runner has called configureBenchmarkEnvironment (which sets
// those env vars). The default dense backend achieves this with a runtime
// dynamic import of `build/`; these tests do the same with a dynamic import of
// `src/` (resolved by ts-jest), which keeps the self-test hermetic and free of
// any compiled-artifact dependency.

const baseDeps = {
  gitSha: async () => 'test-sha',
  now: () => new Date('2026-06-08T00:00:00.000Z'),
  pythonVersion: async () => null,
  silenceServerLogger: async () => undefined,
  loadLexicalIndex: async () => {
    throw new Error('loadLexicalIndex should not be called for dense/hybrid mode');
  },
} satisfies Omit<RunDependencies, 'loadSearchBackend'>;

async function writeTinyBeirDataset(root: string): Promise<string> {
  const datasetDir = path.join(root, 'tiny');
  await fsp.mkdir(path.join(datasetDir, 'qrels'), { recursive: true });
  await fsp.writeFile(path.join(datasetDir, 'corpus.jsonl'), [
    JSON.stringify({ _id: 'doc-alpha', title: 'Alpha', text: 'Alpha gravity wave detection evidence.' }),
    JSON.stringify({ _id: 'doc-beta', title: 'Beta', text: 'Beta culinary recipe for tomato soup.' }),
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

/**
 * A faithful port of the default dense backend that loads the PRODUCTION
 * `src/` retrieval entrypoints (FaissIndexManager + retrieveForRetrievalEvalCase)
 * with the deterministic `fake` provider. `onRetrieve` lets a test spy on the
 * production search entrypoint to prove the runner drives it.
 */
async function loadProductionFakeBackend(
  input: LoadSearchBackendInput,
  onRetrieve?: (mode: string, query: string) => void,
): Promise<BeirSearchBackend> {
  const fim = await import('../../src/FaissIndexManager.js');
  const evalModule = await import('../../src/retrieval-eval.js');
  await fim.FaissIndexManager.bootstrapLayout();
  // `fake` is accepted at the FaissIndexManager runtime boundary (issue #204)
  // but is intentionally absent from the strict EmbeddingProvider union, so the
  // options object is cast — exactly as production callers that flow `fake`
  // through do.
  const manager = new fim.FaissIndexManager(
    { provider: 'fake', modelName: input.modelName } as unknown as ConstructorParameters<typeof fim.FaissIndexManager>[0],
  );
  await manager.initialize();
  return {
    implementation: `production ${input.mode} path (src/retrieval-eval + FaissIndexManager, fake provider)`,
    prepare: async () => {
      await manager.updateIndex();
      const summary = manager.getLastIndexUpdateSummary();
      return { files: summary.files_scanned, chunks: summary.chunks_added };
    },
    search: async (query, fetchK) => {
      onRetrieve?.(input.mode, query);
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
}

describe('BEIR runner dense/hybrid modes', () => {
  it('fails loudly when a dense/hybrid run has no embedding provider configured', () => {
    const saved = process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    try {
      expect(() => resolveEmbeddingSpec({ mode: 'dense' } as never)).toThrow(/requires an embedding provider/);
      expect(() => resolveEmbeddingSpec({ mode: 'hybrid' } as never)).toThrow(/--provider=fake/);
    } finally {
      if (saved === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = saved;
    }
  });

  it('fails loudly when a real provider has no model configured', () => {
    const savedProvider = process.env.EMBEDDING_PROVIDER;
    const savedModel = process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_MODEL;
    try {
      expect(() => resolveEmbeddingSpec({ mode: 'dense', provider: 'ollama' } as never))
        .toThrow(/requires an embedding model/);
    } finally {
      if (savedProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = savedProvider;
      if (savedModel === undefined) delete process.env.OLLAMA_MODEL;
      else process.env.OLLAMA_MODEL = savedModel;
    }
  });

  it('defaults the fake provider model and accepts --provider/--model on the CLI', () => {
    expect(resolveEmbeddingSpec({ mode: 'dense', provider: 'fake' } as never))
      .toEqual({ provider: 'fake', model: 'fake-embeddings' });
    const args = parseArgs(['--mode=hybrid', '--provider=fake', '--model=custom-embed']);
    expect(args).toMatchObject({ mode: 'hybrid', provider: 'fake', model: 'custom-embed' });
  });

  it('delegates retrieval to the injected search backend (no benchmark-only reimplementation)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-dense-delegate-'));
    const datasetDir = await writeTinyBeirDataset(root);
    // The corpus files are written by prepareCorpus with hashed names; resolve
    // the real relative paths so the doc-id mapping in the runner succeeds.
    const search = jest.fn(async (_query: string, _fetchK: number) => {
      const kbDir = path.join(process.env.KNOWLEDGE_BASES_ROOT_DIR ?? '', 'tiny');
      const files = await fsp.readdir(kbDir);
      const alpha = files.find((f) => f.includes('doc-alpha'));
      const beta = files.find((f) => f.includes('doc-beta'));
      return [
        { metadata: { relativePath: `tiny/${alpha}` }, score: 0.9 },
        { metadata: { relativePath: `tiny/${beta}` }, score: 0.1 },
      ];
    });
    const prepare = jest.fn(async () => ({ files: 2, chunks: 2 }));
    const loadSearchBackend = jest.fn(async (input: LoadSearchBackendInput): Promise<BeirSearchBackend> => {
      expect(input.mode).toBe('dense');
      expect(input.provider).toBe('fake');
      return { implementation: 'spy backend', prepare, search };
    });

    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      '--mode=dense',
      '--provider=fake',
      `--output-dir=${path.join(root, 'out')}`,
      `--workspace-root=${path.join(root, 'kb-beir-ws')}`,
      '--k=10',
      '--chunk-k=20',
    ]);

    // docId mapping needs the real relative paths the corpus prep produced; the
    // spy returns by relativePath which prepareCorpus records, so collapse maps.
    const result = await runBeirBenchmark(args, { ...baseDeps, loadSearchBackend });

    expect(loadSearchBackend).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('alpha gravity wave detection', 20);
    expect(result.report.mode).toBe('dense');
    expect(result.report.embedding).toEqual({ provider: 'fake', model: 'fake-embeddings' });
    expect(result.report.ranking.unit).toBe('chunk');
    // doc-alpha (the relevant doc) was returned first -> nDCG@10 = 1.
    expect(result.report.metrics.ndcgAt10).toBe(1);
    expect(result.report.metrics.precisionAt10).toBeCloseTo(0.1, 6);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('persists query decomposition traces for hybrid+decompose runs', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-decompose-'));
    const datasetDir = await writeTinyBeirDataset(root);
    const search = jest.fn(async (query: string, _fetchK: number) => {
      const kbDir = path.join(process.env.KNOWLEDGE_BASES_ROOT_DIR ?? '', 'tiny');
      const files = await fsp.readdir(kbDir);
      const alpha = files.find((f) => f.includes('doc-alpha'));
      const beta = files.find((f) => f.includes('doc-beta'));
      return query.includes('tomato')
        ? [{ metadata: { relativePath: `tiny/${beta}` }, score: 0.5 }]
        : [{ metadata: { relativePath: `tiny/${alpha}` }, score: 0.9 }];
    });
    const loadSearchBackend = jest.fn(async (input: LoadSearchBackendInput): Promise<BeirSearchBackend> => {
      expect(input.mode).toBe('hybrid');
      return {
        implementation: 'spy hybrid backend',
        prepare: async () => ({ files: 2, chunks: 2 }),
        search,
      };
    });
    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      '--mode=hybrid+decompose',
      '--provider=fake',
      `--output-dir=${path.join(root, 'out')}`,
      `--workspace-root=${path.join(root, 'kb-beir-ws')}`,
      '--k=10',
      '--chunk-k=20',
    ]);

    const result = await runBeirBenchmark(args, {
      ...baseDeps,
      loadSearchBackend,
      loadQueryDecompositionRuntime: async () => ({
        createRuleBasedQueryDecomposer: () => ({ name: 'rule' }),
        defaultQueryDecompositionBudget: (overrides?: Record<string, number>) => overrides ?? {},
        queryDecompositionTraceToJson: (trace: unknown) => trace as Record<string, unknown>,
        runQueryDecomposition: async (options) => {
          const first = await options.retrieveSubquery(options.query, 20);
          const second = await options.retrieveSubquery('tomato soup', 20);
          return {
            results: [...first, ...second],
            trace: {
              schema_version: 'kb.search.query-decomposition.v1',
              provider: 'rule',
              stop_reason: 'sufficient',
              retrieval_calls: 2,
            },
          };
        },
      }),
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(result.report.mode).toBe('hybrid+decompose');
    expect(result.report.query_decomposition).toMatchObject({
      schema_version: 'kb.beir.query-decomposition.v1',
      provider: 'rule',
      retrieval_calls_mean: 2,
      stop_reasons: { sufficient: 1 },
    });
    const tracePath = result.report.query_decomposition?.trace_path;
    expect(tracePath).toBeDefined();
    const traceJson = JSON.parse(await fsp.readFile(tracePath as string, 'utf-8')) as {
      traces: Array<{ query_id: string; trace: { stop_reason: string; retrieval_calls: number } }>;
    };
    expect(traceJson.traces).toEqual([
      { query_id: 'q1', trace: expect.objectContaining({ stop_reason: 'sufficient', retrieval_calls: 2 }) },
    ]);
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Hermetic end-to-end run over the PRODUCTION src/ retrieval path with the
  // deterministic fake provider. Proves dense + hybrid both work through the
  // shipped code and that the runner invokes retrieveForRetrievalEvalCase.
  //
  // All production-path runs in this file MUST share one workspace root:
  // src/config/paths.ts resolves KNOWLEDGE_BASES_ROOT_DIR / FAISS_INDEX_PATH
  // into module-level consts on first import, so two runs with different
  // workspaces would make the second use the first's (now wiped) directory.
  // A real `node build/...` invocation gets a fresh process and avoids this;
  // in-process we keep the path stable and let resetDirectory rebuild it.
  describe('production retrieval entrypoint (fake provider)', () => {
    let prodRoot: string;
    let prodDatasetDir: string;
    let prodWorkspace: string;
    let savedLogLevel: string | undefined;

    beforeAll(async () => {
      // Quiet the production FaissIndexManager INFO logs. LOG_LEVEL is captured
      // at src/logger import time, and the first src import happens below (inside
      // loadProductionFakeBackend), so setting it here takes effect.
      savedLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'error';
      prodRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-prod-'));
      prodDatasetDir = await writeTinyBeirDataset(prodRoot);
      prodWorkspace = path.join(prodRoot, 'kb-beir-ws');
    });

    afterAll(async () => {
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLogLevel;
      await fsp.rm(prodRoot, { recursive: true, force: true });
    });

    for (const mode of ['dense', 'hybrid'] as const) {
      it(`runs ${mode} mode through the production retrieval entrypoint`, async () => {
        const retrieveCalls: Array<{ mode: string; query: string }> = [];
        const loadSearchBackend = (input: LoadSearchBackendInput): Promise<BeirSearchBackend> =>
          loadProductionFakeBackend(input, (m, q) => retrieveCalls.push({ mode: m, query: q }));

        const args = parseArgs([
          '--dataset=tiny',
          `--dataset-dir=${prodDatasetDir}`,
          `--mode=${mode}`,
          '--provider=fake',
          `--output-dir=${path.join(prodRoot, `out-${mode}`)}`,
          `--workspace-root=${prodWorkspace}`,
          '--k=10',
          '--chunk-k=20',
          '--keep-workspace',
        ]);

        const result = await runBeirBenchmark(args, { ...baseDeps, loadSearchBackend });

        // The runner drove the production entrypoint for this mode.
        expect(retrieveCalls).toContainEqual({ mode, query: 'alpha gravity wave detection' });
        expect(result.report.mode).toBe(mode);
        expect(result.report.embedding).toEqual({ provider: 'fake', model: 'fake-embeddings' });
        // Both corpus docs fit in the top-10, so the relevant doc is always
        // recalled regardless of fake-embedding geometry.
        expect(result.report.metrics.recallAt10).toBe(1);
        expect(result.report.metrics.precisionAt10).toBeCloseTo(0.1, 6);
        expect(result.report.metrics.ndcgAt10).toBeGreaterThan(0);
        expect(result.report.indexing.chunks).toBeGreaterThan(0);

        const trec = await fsp.readFile(result.trecPath, 'utf-8');
        expect(trec).toContain('q1 Q0 doc-alpha');
      }, 60_000);
    }
  });
});
