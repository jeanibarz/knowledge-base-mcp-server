import * as path from 'path';
import type { ColdIndexScenarioResult, ScenarioContext } from '../types.js';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import { durationMs, resetDirectory } from '../utils.js';

interface ManagerLike {
  initialize(): Promise<void>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
}

export async function runColdIndexScenario(context: ScenarioContext): Promise<ColdIndexScenarioResult> {
  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files: 100,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 2,
    targetChunksPerFile: 5,
  });

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=cold-index-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  const start = process.hrtime.bigint();
  await manager.updateIndex(context.knowledgeBaseName);
  const end = process.hrtime.bigint();
  const counters = context.stubController?.getCounters();

  return {
    add_documents_calls: counters?.addDocumentsCalls,
    chunks: fixture.chunkCount,
    files: fixture.files,
    from_texts_calls: counters?.fromTextsCalls,
    ms: Number(durationMs(start, end).toFixed(3)),
    save_calls: counters?.saveCalls,
  };
}
