import * as path from 'path';
import type { FixtureOverrides, MemoryScenarioResult, ScenarioContext } from '../types.js';
import { prepareCorpus } from './external-corpus.js';

interface ManagerLike {
  initialize(): Promise<void>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
}

export async function runMemoryScenario(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides = {},
): Promise<MemoryScenarioResult> {
  const prepared = await prepareCorpus(context, fixtureOverrides, { seedOffset: 4 });
  const fixture = prepared.fixture;

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=memory-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  await manager.updateIndex(prepared.knowledgeBaseName);

  const usage = process.memoryUsage();

  return {
    chunk_count: fixture.chunkCount,
    files: fixture.files,
    heap_used_bytes: usage.heapUsed,
    rss_bytes: usage.rss,
  };
}
