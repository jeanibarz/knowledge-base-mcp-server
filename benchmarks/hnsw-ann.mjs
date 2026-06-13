#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const faiss = require('faiss-node');
const { HierarchicalNSW } = require('hnswlib-node');

const dims = intEnv('KB_HNSW_BENCH_DIMS', 64);
const vectors = intEnv('KB_HNSW_BENCH_VECTORS', 3000);
const queries = intEnv('KB_HNSW_BENCH_QUERIES', 120);
const k = intEnv('KB_HNSW_BENCH_K', 10);
const clusters = intEnv('KB_HNSW_BENCH_CLUSTERS', 48);
const m = intEnv('KB_HNSW_M', 32);
const efConstruction = intEnv('KB_HNSW_EF_CONSTRUCTION', 200);
const efSearch = intEnv('KB_HNSW_EF_SEARCH', 100);
const seed = intEnv('KB_HNSW_RANDOM_SEED', 100);
const bootstrapIterations = intEnv('KB_HNSW_BENCH_BOOTSTRAP', 500);

const corpus = makeClusteredVectors({ count: vectors, dims, clusters });
const queryVectors = corpus.slice(0, queries).map((vector, i) =>
  perturb(vector, 0.01 + (i % 7) * 0.002),
);

const flat = new faiss.IndexFlatL2(dims);
flat.add(flatten(corpus));
const exact = measureQueries('flat', (query) => flat.search(query, k).labels);

const sq8 = faiss.Index.fromFactory(dims, 'SQ8', faiss.MetricType.METRIC_L2);
if (sq8.isTrained?.() === false) sq8.train(flatten(corpus));
sq8.add(flatten(corpus));
const sq8Result = measureQueries('sq8', (query) => sq8.search(query, k).labels);

const beforeHnswMemory = process.memoryUsage().rss;
const hnsw = new HierarchicalNSW('l2', dims);
hnsw.initIndex({ maxElements: corpus.length, m, efConstruction, randomSeed: seed });
hnsw.setEf(efSearch);
for (let i = 0; i < corpus.length; i += 1) hnsw.addPoint(corpus[i], i);
const afterHnswMemory = process.memoryUsage().rss;
const hnswResult = measureQueries('hnsw', (query) => hnsw.searchKnn(query, k).neighbors);

const report = {
  schema_version: 'kb.hnsw-ann-benchmark.v1',
  config: {
    vectors,
    queries,
    dims,
    k,
    clusters,
    hnsw: { m, efConstruction, efSearch, metric: 'l2', randomSeed: seed },
    bootstrap_iterations: bootstrapIterations,
  },
  baselines: {
    flat: summarize('flat', exact.labels, exact.labels, exact.latencies, 0),
    sq8: summarize('sq8', exact.labels, sq8Result.labels, sq8Result.latencies, 0),
  },
  hnsw: summarize(
    'hnsw',
    exact.labels,
    hnswResult.labels,
    hnswResult.latencies,
    afterHnswMemory - beforeHnswMemory,
  ),
};

console.log(JSON.stringify(report, null, 2));

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function makeClusteredVectors({ count, dims: vectorDims, clusters: clusterCount }) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const cluster = i % clusterCount;
    const vector = [];
    for (let d = 0; d < vectorDims; d += 1) {
      const base = Math.sin((cluster + 1) * (d + 3) * 0.017);
      const local = Math.cos((i + 11) * (d + 5) * 0.013) * 0.05;
      vector.push(base + local);
    }
    out.push(vector);
  }
  return out;
}

function perturb(vector, amount) {
  return vector.map((value, i) => value + Math.sin((i + 1) * 0.37) * amount);
}

function flatten(matrix) {
  return matrix.flatMap((row) => row);
}

function measureQueries(name, search) {
  const labels = [];
  const latencies = [];
  for (const query of queryVectors) {
    const started = performance.now();
    labels.push(search(query));
    latencies.push(performance.now() - started);
  }
  return { name, labels, latencies };
}

function summarize(name, exactLabels, candidateLabels, latencies, memoryBytes) {
  const recalls = candidateLabels.map((labels, i) => recallAtK(exactLabels[i], labels));
  const ndcgs = candidateLabels.map((labels, i) => ndcgAtK(exactLabels[i], labels));
  return {
    name,
    recall_at_k: mean(recalls),
    recall_at_k_ci95: bootstrapCi(recalls),
    ndcg_at_k: mean(ndcgs),
    ndcg_at_k_ci95: bootstrapCi(ndcgs),
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    memory_delta_bytes: memoryBytes,
  };
}

function recallAtK(exactLabels, candidateLabels) {
  const exactSet = new Set(exactLabels);
  let hits = 0;
  for (const label of candidateLabels) if (exactSet.has(label)) hits += 1;
  return hits / exactLabels.length;
}

function ndcgAtK(exactLabels, candidateLabels) {
  const exactRank = new Map(exactLabels.map((label, i) => [label, i]));
  let dcg = 0;
  for (let i = 0; i < candidateLabels.length; i += 1) {
    if (exactRank.has(candidateLabels[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < exactLabels.length; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[index];
}

function bootstrapCi(values) {
  const means = [];
  let state = 0x9e3779b9;
  for (let i = 0; i < bootstrapIterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      sum += values[state % values.length];
    }
    means.push(sum / values.length);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}
