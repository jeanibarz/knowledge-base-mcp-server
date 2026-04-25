import * as fsp from 'fs/promises';
import * as path from 'path';
import type { IndexStorageScenarioResult, ScenarioContext } from '../types.js';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import { resetDirectory } from '../utils.js';

interface ManagerLike {
  initialize(): Promise<void>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
  readonly modelDir: string;
}

/**
 * RFC 013 §4.13.3 — on-disk storage scenario. After cold-index, sums byte
 * sizes of `${PATH}/models/<id>/faiss.index/{faiss.index, docstore.json}` and
 * computes bytes/vector. Cheap; runs in the same process as cold-index would.
 */
export async function runIndexStorageScenario(
  context: ScenarioContext,
  options: { files?: number; targetChunksPerFile?: number } = {},
): Promise<IndexStorageScenarioResult> {
  const files = options.files ?? 100;
  const targetChunksPerFile = options.targetChunksPerFile ?? 5;

  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 6,
    targetChunksPerFile,
  });

  const { FaissIndexManager } = await import(
    new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=index-storage-${Date.now()}`).href,
  ) as {
    FaissIndexManager: new () => ManagerLike;
  };

  const manager = new FaissIndexManager();
  await manager.initialize();
  await manager.updateIndex(context.knowledgeBaseName);

  const indexDir = path.join(manager.modelDir, 'faiss.index');
  const vectorBytes = await safeStatSize(path.join(indexDir, 'faiss.index'));
  const docstoreBytes = await safeStatSize(path.join(indexDir, 'docstore.json'));
  const totalBytes = vectorBytes + docstoreBytes;
  const bytesPerVector = fixture.chunkCount > 0
    ? Number((totalBytes / fixture.chunkCount).toFixed(2))
    : 0;

  return {
    vector_binary_bytes: vectorBytes,
    docstore_bytes: docstoreBytes,
    total_bytes: totalBytes,
    bytes_per_vector: bytesPerVector,
    vectors: fixture.chunkCount,
  };
}

async function safeStatSize(filePath: string): Promise<number> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}
