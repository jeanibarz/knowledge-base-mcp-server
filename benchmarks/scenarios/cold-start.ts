import * as fsp from 'fs/promises';
import * as path from 'path';
import { MarkdownTextSplitter } from 'langchain/text_splitter';
import type { ColdStartScenarioResult, FixtureOverrides, ScenarioContext } from '../types.js';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import { durationMs, resetDirectory } from '../utils.js';

interface EmbeddingsLike {
  embedDocuments(texts: string[]): Promise<number[][]>;
}

interface VectorStoreLike {
  save(filePath: string): Promise<void>;
}

interface VectorStoreModule {
  FaissStore: {
    fromTexts(
      texts: string[],
      metadatas: Array<Record<string, unknown>>,
      embeddings: EmbeddingsLike,
    ): Promise<VectorStoreLike>;
  };
}

interface ManagerLike {
  initialize(): Promise<void>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
  readonly modelDir: string;
  readonly modelNameFile: string;
  readonly modelName: string;
}

interface ManagerModule {
  FaissIndexManager: new () => ManagerLike;
}

export async function runColdStartScenario(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides = {},
): Promise<ColdStartScenarioResult> {
  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);

  const fixture = await generateKnowledgeBaseFixture({
    // cold-start traditionally uses fewer files (20) than other scenarios (100).
    // Honor BENCH_FIXTURE_FILES if explicitly set, else keep the smaller default.
    files: fixtureOverrides.files ?? 20,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 1,
    targetChunksPerFile: fixtureOverrides.targetChunksPerFile ?? 5,
    chunkSize: fixtureOverrides.chunkSize,
  });

  await createPersistedFixture(context, fixtureOverrides);

  const start = process.hrtime.bigint();
  const moduleUrl = new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=cold-start-${Date.now()}`);
  const imported = await import(moduleUrl.href) as ManagerModule;
  const manager = new imported.FaissIndexManager();
  await manager.initialize();
  const end = process.hrtime.bigint();

  return {
    fixture_documents: fixture.chunkCount,
    ms: Number(durationMs(start, end).toFixed(3)),
    rss_bytes: process.memoryUsage().rss,
  };
}

async function createPersistedFixture(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides,
): Promise<void> {
  // RFC 013 layout: persist into ${FAISS_INDEX_PATH}/models/<id>/{faiss.index/, model_name.txt}.
  // Probe a manager once to discover the env-derived modelDir/modelNameFile so the
  // persisted fixture lands at the exact path the cold-start loader will read.
  const probeUrl = new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?scenario=cold-start-probe-${Date.now()}`);
  const probeModule = await import(probeUrl.href) as ManagerModule;
  const probe = new probeModule.FaissIndexManager();
  await fsp.mkdir(probe.modelDir, { recursive: true });
  const indexDir = path.join(probe.modelDir, 'faiss.index');

  const kbPath = path.join(context.knowledgeBasesRootDir, context.knowledgeBaseName);
  const filePaths = (await fsp.readdir(kbPath)).map((entry) => path.join(kbPath, entry));
  const chunkSize = fixtureOverrides.chunkSize && fixtureOverrides.chunkSize > 0 ? fixtureOverrides.chunkSize : 1000;
  const splitter = new MarkdownTextSplitter({
    chunkOverlap: Math.floor(chunkSize / 5),
    chunkSize,
    keepSeparator: false,
  });

  if (context.provider === 'stub') {
    const chunks = [];
    for (const filePathToRead of filePaths) {
      const content = await fsp.readFile(filePathToRead, 'utf-8');
      const documents = await splitter.createDocuments([content], [{ source: filePathToRead }]);
      chunks.push(...documents);
    }

    const faissModule = await import('@langchain/community/vectorstores/faiss') as VectorStoreModule;
    const hfModule = await import('@langchain/community/embeddings/hf') as {
      HuggingFaceInferenceEmbeddings: new (...args: unknown[]) => EmbeddingsLike;
    };
    const embeddings = new hfModule.HuggingFaceInferenceEmbeddings({
      apiKey: 'stub-key',
      model: 'bench-stub-model',
    });
    const vectorStore = await faissModule.FaissStore.fromTexts(
      chunks.map((document) => document.pageContent),
      chunks.map((document) => document.metadata as Record<string, unknown>),
      embeddings,
    );
    await vectorStore.save(indexDir);
  } else {
    const realUrl = new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?fixture=${Date.now()}`);
    const realModule = await import(realUrl.href) as ManagerModule;
    const manager = new realModule.FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex(context.knowledgeBaseName);
  }

  await fsp.writeFile(probe.modelNameFile, probe.modelName, 'utf-8');
}
