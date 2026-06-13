#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const batches = positiveInteger(process.env.KB_INDEXING_BENCH_BATCHES, 12);
const batchSize = positiveInteger(process.env.KB_INDEXING_BENCH_BATCH_SIZE, 64);
const concurrency = Math.min(
  4,
  positiveInteger(process.env.KB_INDEXING_CONCURRENCY, 4),
);
const embedLatencyMs = positiveInteger(process.env.KB_INDEXING_BENCH_EMBED_MS, 80);
const insertLatencyMs = positiveInteger(process.env.KB_INDEXING_BENCH_INSERT_MS, 12);

function positiveInteger(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(index) {
  await sleep(embedLatencyMs);
  return {
    index,
    vectors: Array.from({ length: batchSize }, (_unused, i) => [index, i]),
  };
}

async function insertBatch(_embedded) {
  await sleep(insertLatencyMs);
}

async function runSequential() {
  const startedAt = performance.now();
  for (let i = 0; i < batches; i += 1) {
    const embedded = await embedBatch(i);
    await insertBatch(embedded);
  }
  return performance.now() - startedAt;
}

async function runPipelined() {
  const startedAt = performance.now();
  const inFlight = new Map();
  let nextToLaunch = 0;

  const launchMore = () => {
    while (nextToLaunch < batches && inFlight.size < concurrency) {
      const index = nextToLaunch;
      inFlight.set(index, embedBatch(index));
      nextToLaunch += 1;
    }
  };

  launchMore();
  for (let i = 0; i < batches; i += 1) {
    const embedded = await inFlight.get(i);
    inFlight.delete(i);
    launchMore();
    await insertBatch(embedded);
  }

  return performance.now() - startedAt;
}

const sequentialMs = await runSequential();
const pipelinedMs = await runPipelined();
const speedup = sequentialMs / pipelinedMs;

const result = {
  schema_version: 'kb.indexing-concurrency-bench.v1',
  batches,
  batch_size: batchSize,
  concurrency,
  embed_latency_ms: embedLatencyMs,
  serialized_insert_latency_ms: insertLatencyMs,
  sequential_ms: Math.round(sequentialMs),
  pipelined_ms: Math.round(pipelinedMs),
  speedup: Number(speedup.toFixed(2)),
};

console.log(JSON.stringify(result, null, 2));
