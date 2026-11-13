// Isolated rerank-stage latency probe for #1049.
//
// Why: in the BEIR sweep, "variant p50 - hybrid p50" mixes the reranker's cost
// with whatever else the shared host was doing during each variant (several
// sweeps and other tenants' GPU jobs ran at once), so that difference is noisy
// and can even come out negative. This probe times ONLY the production rerank
// stage (`applyRerankerIfEnabled` in src/reranker.ts — the same call the search
// path makes, including the cross-encoder tokenization and the forward pass) on
// realistic inputs: for each query, its top-40 hybrid documents from the
// committed sweep TREC run, each cut to 1000 characters (the default chunk size).
// Each model is warmed with one call first so model load is not counted.
//
// Usage (repo root, after the build):
//   KB_RERANK_DEVICE=cuda LD_LIBRARY_PATH=<cuda13 libs> node \
//     benchmarks/results/reranker-bakeoff/rerank-latency-probe.mjs \
//     <dataset_dir> <hybrid trec run> <n_queries> <out.json>

import * as fs from 'fs';
import * as path from 'path';
import { applyRerankerIfEnabled } from '../../../build/reranker.js';

const [datasetDir, trecPath, nQueriesRaw, outPath] = process.argv.slice(2);
const nQueries = Number(nQueriesRaw);
const MODELS = [
  { id: 'minilm-l6', model: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'fp32' },
  { id: 'mxbai-xsmall-v1', model: 'mixedbread-ai/mxbai-rerank-xsmall-v1', dtype: 'fp32' },
  { id: 'jina-v1-turbo-en', model: 'jinaai/jina-reranker-v1-turbo-en', dtype: 'fp32' },
  { id: 'bge-base', model: 'Xenova/bge-reranker-base', dtype: 'fp32' },
  { id: 'mxbai-base-v1', model: 'mixedbread-ai/mxbai-rerank-base-v1', dtype: 'fp32' },
  { id: 'bge-v2-m3-fp16', model: 'onnx-community/bge-reranker-v2-m3-ONNX', dtype: 'fp16' },
];

const docs = new Map();
for (const line of fs.readFileSync(path.join(datasetDir, 'corpus.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  docs.set(row._id, `${row.title ?? ''}\n\n${row.text ?? ''}`.trim().slice(0, 1000));
}
const queries = new Map();
for (const line of fs.readFileSync(path.join(datasetDir, 'queries.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  queries.set(row._id, row.text);
}
const ranked = new Map();
for (const line of fs.readFileSync(trecPath, 'utf8').split('\n')) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) continue;
  const [qid, , docId, rank] = parts;
  if (!ranked.has(qid)) ranked.set(qid, []);
  if (Number(rank) <= 40) ranked.get(qid).push(docId);
}
const qids = [...ranked.keys()].filter((q) => queries.has(q)).slice(0, nQueries);

function pct(values, q) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

const results = {};
for (const m of MODELS) {
  process.env.KB_RERANK_DTYPE = m.dtype;
  const config = { enabled: true, model: m.model, topN: 40 };
  const mk = (qid) => ranked.get(qid).map((d, i) => ({ pageContent: docs.get(d) ?? '', metadata: { id: d }, score: 1 / (i + 1) }));
  const warm = await applyRerankerIfEnabled({ query: 'warm up', results: mk(qids[0]), k: 10, config });
  if (warm.degraded) {
    results[m.id] = { model: m.model, error: String(warm.degradeReason).slice(0, 300) };
    console.log(JSON.stringify({ id: m.id, error: warm.degradeReason }));
    continue;
  }
  const took = [];
  let degraded = 0;
  for (const qid of qids) {
    const t0 = process.hrtime.bigint();
    const out = await applyRerankerIfEnabled({ query: queries.get(qid), results: mk(qid), k: 10, config });
    took.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (out.degraded) degraded += 1;
  }
  results[m.id] = {
    model: m.model,
    dtype: m.dtype,
    device: process.env.KB_RERANK_DEVICE ?? 'cpu',
    queries: took.length,
    p50_ms: Number(pct(took, 0.5).toFixed(1)),
    p95_ms: Number(pct(took, 0.95).toFixed(1)),
    mean_ms: Number((took.reduce((a, b) => a + b, 0) / took.length).toFixed(1)),
    degraded,
  };
  console.log(JSON.stringify({ id: m.id, ...results[m.id] }));
  // Free the ONNX session before the next model (the provider cache keeps them).
  const { getDefaultReranker } = await import('../../../build/reranker.js');
  const loaded = await getDefaultReranker(config);
  await loaded.model?.dispose?.();
}
fs.writeFileSync(outPath, JSON.stringify({
  schema: 'kb.reranker-bakeoff.rerank-latency-probe.v1',
  dataset_dir: path.basename(datasetDir),
  trec: path.basename(trecPath),
  candidates_per_query: 40,
  candidate_chars: 1000,
  results,
}, null, 2));
