import * as path from 'path';
import type { ColdIndexScenarioResult, FixtureOverrides, ScenarioContext } from '../types.js';
import { prepareCorpus } from './external-corpus.js';
import { durationMs } from '../utils.js';

interface ManagerLike {
  initialize(): Promise<void>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
}

export async function runColdIndexScenario(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides = {},
): Promise<ColdIndexScenarioResult> {
  const prepared = await prepareCorpus(context, fixtureOverrides, { seedOffset: 2 });
  const fixture = prepared.fixture;

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=cold-index-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  const start = process.hrtime.bigint();
  await manager.updateIndex(prepared.knowledgeBaseName);
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
