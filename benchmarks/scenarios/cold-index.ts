import * as path from 'path';
import type { ColdIndexScenarioResult, FixtureOverrides, ScenarioContext } from '../types.js';
import { prepareCorpus, readIndexedCounts } from './external-corpus.js';
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

  // For an external corpus, report the counts the production FaissIndexManager
  // actually recorded in last-index-update.json rather than prepareCorpus's
  // pre-index estimate from countCorpusChunks (issue #1067) — the estimate uses
  // a naive MarkdownTextSplitter that does not match the real ingest chunker.
  // Synthetic fixtures keep the generator's exact counts. Fall back to the
  // estimate when the manifest is absent or reports zero (indexing wrote no
  // summary), so this never regresses to worse data.
  let chunks = fixture.chunkCount;
  let files = fixture.files;
  if (prepared.external) {
    const indexed = await readIndexedCounts(context.faissIndexPath);
    if (indexed.files > 0) files = indexed.files;
    if (indexed.chunks > 0) chunks = indexed.chunks;
  }

  return {
    add_documents_calls: counters?.addDocumentsCalls,
    chunks,
    files,
    from_texts_calls: counters?.fromTextsCalls,
    ms: Number(durationMs(start, end).toFixed(3)),
    save_calls: counters?.saveCalls,
  };
}
