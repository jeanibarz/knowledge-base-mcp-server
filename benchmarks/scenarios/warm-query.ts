import * as path from 'path';
import type { FixtureOverrides, ScenarioContext, WarmQueryScenarioResult } from '../types.js';
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

export async function runWarmQueryScenario(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides = {},
): Promise<WarmQueryScenarioResult> {
  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files: fixtureOverrides.files ?? 100,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 3,
    targetChunksPerFile: fixtureOverrides.targetChunksPerFile ?? 5,
    chunkSize: fixtureOverrides.chunkSize,
  });

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=warm-query-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  await manager.updateIndex(context.knowledgeBaseName);

  const measurements: number[] = [];
  for (let repetition = 0; repetition < 30; repetition += 1) {
    const start = process.hrtime.bigint();
    await manager.updateIndex(context.knowledgeBaseName);
    const results = await manager.similaritySearch(fixture.query, 10);
    const end = process.hrtime.bigint();

    if (results.length === 0) {
      throw new Error('Warm query scenario produced no results');
    }

    measurements.push(durationMs(start, end));
  }

  return {
    p50_ms: percentile(measurements, 50),
    p95_ms: percentile(measurements, 95),
    p99_ms: percentile(measurements, 99),
    repetitions: measurements.length,
  };
}
