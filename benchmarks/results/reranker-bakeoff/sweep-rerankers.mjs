// Reranker model sweep for #1049 (one embedding index, many cross-encoders).
//
// Why this exists: `node build/benchmarks/beir/run.js` rebuilds the dense+lexical
// index on every invocation. A reranker sweep only changes the post-fusion
// cross-encoder, so re-embedding the corpus once per reranker would multiply the
// (Ollama-bound) cost by the number of candidates without changing a single
// retrieved candidate. This driver calls the same `runBeirBenchmark` entrypoint
// in-process and memoizes the search backend, so the index is built once per
// dataset and every variant (plain `hybrid` and each `hybrid+rerank` model)
// queries the very same index through the production `retrieveForRetrievalEvalCase`
// path. The rerank stage is the production `src/reranker.ts` path, selected per
// variant by KB_RERANK_MODEL / KB_RERANK_DTYPE.
//
// Usage (from the repo root, after `npm run build && npx tsc -p tsconfig.bench.json`):
//   KB_RERANK_DEVICE=cuda LD_LIBRARY_PATH=<cuda13 libs> \
//   node benchmarks/results/reranker-bakeoff/sweep-rerankers.mjs \
//     --dataset=scifact --out=<dir> --ws-root=<scratch dir> [--max-queries=N]
//
// Query-embedding cache: with KB_QUERY_CACHE on (the default), the `dense`
// variant embeds every query once and every later variant (hybrid and each
// rerank model) reads the cached vector, so their latencies all EXCLUDE the
// query embed and `variant p50 - hybrid p50` isolates the reranker. With
// KB_QUERY_CACHE=off every variant re-embeds; the difference is the same
// quantity but noisier. The report README records which setting each dataset used.

import * as path from 'path';
import * as fs from 'fs';
import { runBeirBenchmark, parseArgs, defaultRunDependencies } from '../../../build/benchmarks/beir/run.js';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s, 2)));
const dataset = argv.dataset;
const outRoot = argv.out;
const wsRoot = argv['ws-root'];
const model = argv.model ?? 'dengcao/Qwen3-Embedding-0.6B:Q8_0';
const only = argv.only ? new Set(argv.only.split(',')) : null;
if (!dataset || !outRoot || !wsRoot) throw new Error('need --dataset --out --ws-root');
// --reuse-index=1: the index already exists under <ws-root>/<dataset>-dense (a
// previous, interrupted sweep). The production modules read
// FAISS_INDEX_PATH / KNOWLEDGE_BASES_ROOT_DIR once, at first import, so import
// them now with the environment pointing at that workspace (run-sweep.sh sets
// it) and give every variant a fresh scratch workspace instead: nothing is
// re-embedded because the incremental update finds every file unchanged.
const reuseIndex = argv['reuse-index'] === '1';
if (reuseIndex) await import('../../../build/config/paths.js');

const VARIANTS = [
  // `dense` runs first and pays the one index build (its index_ms is the
  // embedding-throughput number for the default model in the #1047 table); the
  // later variants open a second backend over the same on-disk index, whose
  // incremental update finds nothing to embed.
  { id: 'dense', mode: 'dense' },
  { id: 'hybrid', mode: 'hybrid' },
  { id: 'minilm-l6', mode: 'hybrid+rerank', rerankModel: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'fp32' },
  { id: 'mxbai-xsmall-v1', mode: 'hybrid+rerank', rerankModel: 'mixedbread-ai/mxbai-rerank-xsmall-v1', dtype: 'fp32' },
  { id: 'jina-v1-turbo-en', mode: 'hybrid+rerank', rerankModel: 'jinaai/jina-reranker-v1-turbo-en', dtype: 'fp32' },
  { id: 'bge-base', mode: 'hybrid+rerank', rerankModel: 'Xenova/bge-reranker-base', dtype: 'fp32' },
  { id: 'mxbai-base-v1', mode: 'hybrid+rerank', rerankModel: 'mixedbread-ai/mxbai-rerank-base-v1', dtype: 'fp32' },
  // fp32 bge-reranker-v2-m3 ships as model.onnx + model.onnx_data (external data),
  // which the production loader does not request; the fp16 single-file export loads.
  { id: 'bge-v2-m3-fp16', mode: 'hybrid+rerank', rerankModel: 'onnx-community/bge-reranker-v2-m3-ONNX', dtype: 'fp16' },
];

// One backend per retrieval mode (dense / hybrid), each prepared once. All of
// them share the first variant's workspace because the production modules read
// FAISS_INDEX_PATH / KNOWLEDGE_BASES_ROOT_DIR once, at first import.
const backends = new Map();
const deps = {
  ...defaultRunDependencies,
  loadSearchBackend: async (input) => {
    if (!backends.has(input.mode)) {
      const backend = await defaultRunDependencies.loadSearchBackend(input);
      let prep = null;
      backends.set(input.mode, {
        ...backend,
        prepare: async () => {
          if (prep === null) prep = await backend.prepare();
          return prep;
        },
      });
    }
    return backends.get(input.mode);
  },
};

// Free each cross-encoder's ONNX session once its variant is done. The
// production provider cache keeps every model it ever loaded, which on a shared
// 24 GB GPU let later, larger models fail to allocate (CUDA OOM) — and the
// production reranker fails OPEN to the fused order, which would silently turn
// a rerank row into a copy of the hybrid row.
async function releaseReranker(v) {
  if (!v.rerankModel) return;
  const { getDefaultReranker } = await import('../../../build/reranker.js');
  const reranker = await getDefaultReranker({ enabled: true, model: v.rerankModel, topN: 40 });
  await reranker.model?.dispose?.();
}

// Load (and score one pair with) the cross-encoder BEFORE the timed variant,
// retrying on failure. On a shared GPU a CUDA OOM at session creation is
// transient; without this the first query's load failure makes the production
// reranker fail open and the whole variant silently equals hybrid.
async function ensureRerankerLoads(v) {
  const { getDefaultReranker } = await import('../../../build/reranker.js');
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const reranker = await getDefaultReranker({ enabled: true, model: v.rerankModel, topN: 40 });
      await reranker.rerank('warm up', ['warm up passage']);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
  }
  throw new Error(`reranker ${v.rerankModel} failed to load after retries: ${String(lastError).slice(0, 300)}`);
}

const summary = [];
for (const v of VARIANTS) {
  if (only !== null && !only.has(v.id)) continue;
  if (v.rerankModel) {
    process.env.KB_RERANK_MODEL = v.rerankModel;
    process.env.KB_RERANK_DTYPE = v.dtype;
  } else {
    delete process.env.KB_RERANK_MODEL;
  }
  // In --reuse-index mode the dense row only re-warms the query cache (its
  // latency excludes the query embed); keep it apart from the original build.
  const outDir = path.join(outRoot, dataset, reuseIndex && v.mode === 'dense' ? 'dense-reuse' : v.id);
  const ws = path.join(wsRoot, reuseIndex ? `${dataset}-r-${v.id}` : `${dataset}-${v.id}`);
  const runArgv = [
    `--dataset=${dataset}`,
    `--cache-dir=${process.env.HOME}/.cache/kb-beir-cache`,
    `--mode=${v.mode}`,
    '--provider=ollama',
    `--model=${model}`,
    `--output-dir=${outDir}`,
    `--workspace-root=${ws}`,
    // Keep every workspace: the memoized backend's FAISS/lexical state lives in
    // the FIRST variant's workspace, which must survive the later variants.
    '--keep-workspace',
  ];
  // --max-queries caps only the hybrid / rerank variants (the cross-encoder is
  // the expensive part); the dense row always scores every judged query so it
  // stays comparable with the other embedding models in the #1047 table.
  if (argv['max-queries'] && v.mode !== 'dense') runArgv.push(`--max-queries=${argv['max-queries']}`);
  // --chunk-k caps the fused candidate depth for the hybrid / rerank variants
  // (benchmarks/beir/reranker-bakeoff.ts uses 100). The runner default of 1000
  // makes the CPU-side hybrid fusion ~1.2 s/query on this host, which is what
  // dominated sweep time; the reranker only ever sees the top 40 either way.
  if (argv['chunk-k'] && v.mode !== 'dense') runArgv.push(`--chunk-k=${argv['chunk-k']}`);
  const started = Date.now();
  try {
    if (v.rerankModel) await ensureRerankerLoads(v);
    const result = await runBeirBenchmark(parseArgs(runArgv), deps);
    const r = result.report;
    const row = {
      variant: v.id,
      rerank_model: v.rerankModel ?? null,
      dtype: v.dtype ?? null,
      device: process.env.KB_RERANK_DEVICE ?? 'cpu',
      ndcg10: r.metrics.ndcgAt10,
      p50_ms: r.latency.p50Ms,
      p95_ms: r.latency.p95Ms,
      queries: r.dataset.queries_evaluated,
      index_ms: r.indexing.ms,
      chunks: r.indexing.chunks,
      wall_s: (Date.now() - started) / 1000,
      json: result.jsonPath,
    };
    summary.push(row);
    console.log(JSON.stringify(row));
    await releaseReranker(v);
    // Signal an external scheduler that the Ollama-bound part (corpus + query
    // embedding) is over: later variants hit the warmed query-embedding cache.
    if (v.mode === 'dense') fs.writeFileSync(path.join(outRoot, `${dataset}.dense-done`), '');
  } catch (error) {
    const row = { variant: v.id, rerank_model: v.rerankModel ?? null, error: String(error?.stack ?? error) };
    summary.push(row);
    console.log(JSON.stringify(row));
    // Every later variant depends on the dense variant's index (and, in
    // --reuse-index mode, on its module-level paths); continuing would silently
    // re-embed the corpus into a fresh workspace.
    if (v.mode === 'dense') break;
  }
}
fs.writeFileSync(path.join(outRoot, `${dataset}-sweep-summary.json`), JSON.stringify(summary, null, 2));
