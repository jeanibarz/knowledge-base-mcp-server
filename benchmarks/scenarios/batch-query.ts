import * as path from 'path';
import type {
  BatchQueryRunResult,
  BatchQueryScenarioResult,
  ScenarioContext,
} from '../types.js';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import { durationMs, percentile, resetDirectory } from '../utils.js';

interface SearchResult {
  metadata: Record<string, unknown>;
  pageContent: string;
  score?: number;
}

interface ManagerLike {
  initialize(): Promise<void>;
  similaritySearch(query: string, k: number, threshold?: number): Promise<SearchResult[]>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
}

export interface BatchQueryScenarioOptions {
  concurrencies?: number[];
  repetitions?: number;
  files?: number;
  targetChunksPerFile?: number;
  queries?: string[];
}

const DEFAULT_CONCURRENCIES = [1, 4, 16];
const DEFAULT_REPETITIONS = 5;

/**
 * RFC 013 §4.13.3 — concurrency-sweep scenario. For each `concurrency=N`, fires
 * `Promise.all(query × N)` `repetitions` times against an already-loaded
 * manager and reports throughput (qps) + tail latency.
 */
export async function runBatchQueryScenario(
  context: ScenarioContext,
  options: BatchQueryScenarioOptions = {},
): Promise<BatchQueryScenarioResult> {
  const concurrencies = options.concurrencies ?? DEFAULT_CONCURRENCIES;
  const repetitions = options.repetitions ?? DEFAULT_REPETITIONS;
  const files = options.files ?? 100;
  const targetChunksPerFile = options.targetChunksPerFile ?? 5;

  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 5,
    targetChunksPerFile,
  });

  const queries = options.queries && options.queries.length > 0
    ? options.queries
    : [fixture.query];

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=batch-query-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  await manager.updateIndex(context.knowledgeBaseName);

  const runs: BatchQueryRunResult[] = [];

  for (const concurrency of concurrencies) {
    const latencies: number[] = [];
    const wallTimes: number[] = [];

    for (let r = 0; r < repetitions; r += 1) {
      const wallStart = process.hrtime.bigint();
      const promises = Array.from({ length: concurrency }, (_, i) => {
        const query = queries[(r * concurrency + i) % queries.length];
        const opStart = process.hrtime.bigint();
        return manager.similaritySearch(query, 10).then((results) => {
          const opEnd = process.hrtime.bigint();
          if (results.length === 0) {
            throw new Error(`Batch-query produced no results (query="${query.slice(0, 40)}…")`);
          }
          latencies.push(durationMs(opStart, opEnd));
        });
      });
      await Promise.all(promises);
      const wallEnd = process.hrtime.bigint();
      wallTimes.push(durationMs(wallStart, wallEnd));
    }

    const qps = wallTimes.map((wallMs) => (concurrency / wallMs) * 1000);

    runs.push({
      concurrency,
      qps_p50: percentile(qps, 50),
      qps_p95: percentile(qps, 95),
      latency_p50_ms: percentile(latencies, 50),
      latency_p95_ms: percentile(latencies, 95),
      latency_p99_ms: percentile(latencies, 99),
      total_queries: latencies.length,
    });
  }

  return { runs };
}
