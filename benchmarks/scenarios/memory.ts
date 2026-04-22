import * as path from 'path';
import type { MemoryScenarioResult, ScenarioContext } from '../types.js';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import { resetDirectory } from '../utils.js';

interface ManagerLike {
  initialize(): Promise<void>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
}

export async function runMemoryScenario(context: ScenarioContext): Promise<MemoryScenarioResult> {
  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files: 100,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 4,
    targetChunksPerFile: 5,
  });

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=memory-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  await manager.updateIndex(context.knowledgeBaseName);

  const usage = process.memoryUsage();

  return {
    chunk_count: fixture.chunkCount,
    files: fixture.files,
    heap_used_bytes: usage.heapUsed,
    rss_bytes: usage.rss,
  };
}
