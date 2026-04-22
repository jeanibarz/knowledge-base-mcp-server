import * as fsp from 'fs/promises';
import * as path from 'path';
import { MarkdownTextSplitter } from 'langchain/text_splitter';
import type { ColdStartScenarioResult, ScenarioContext } from '../types.js';
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

export async function runColdStartScenario(context: ScenarioContext): Promise<ColdStartScenarioResult> {
  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);

  const fixture = await generateKnowledgeBaseFixture({
    files: 20,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 1,
    targetChunksPerFile: 5,
  });

  await createPersistedFixture(context);

  const start = process.hrtime.bigint();
  const modulePath = path.join(context.buildRoot, 'KnowledgeBaseServer.js');
  const moduleUrl = new URL(`file://${modulePath}?scenario=cold-start-${Date.now()}`);
  const imported = await import(moduleUrl.href) as {
    KnowledgeBaseServer: new () => object;
  };
  const server = new imported.KnowledgeBaseServer();
  const manager = Reflect.get(server, 'faissManager') as { initialize(): Promise<void> };
  await manager.initialize();
  const end = process.hrtime.bigint();

  return {
    fixture_documents: fixture.chunkCount,
    ms: Number(durationMs(start, end).toFixed(3)),
    rss_bytes: process.memoryUsage().rss,
  };
}

async function createPersistedFixture(context: ScenarioContext): Promise<void> {
  const filePath = path.join(context.faissIndexPath, 'faiss.index');
  const modelNamePath = path.join(context.faissIndexPath, 'model_name.txt');
  const kbPath = path.join(context.knowledgeBasesRootDir, context.knowledgeBaseName);
  const filePaths = (await fsp.readdir(kbPath)).map((entry) => path.join(kbPath, entry));
  const splitter = new MarkdownTextSplitter({
    chunkOverlap: 200,
    chunkSize: 1000,
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
    await vectorStore.save(filePath);
  } else {
    const { FaissIndexManager } = await import(new URL(`file://${path.join(context.buildRoot, 'FaissIndexManager.js')}?fixture=${Date.now()}`).href) as {
      FaissIndexManager: new () => { initialize(): Promise<void>; updateIndex(kb?: string): Promise<void> };
    };
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex(context.knowledgeBaseName);
  }

  await fsp.writeFile(modelNamePath, activeModelName(context.provider), 'utf-8');
}

function activeModelName(provider: ScenarioContext['provider']): string {
  if (provider === 'ollama') {
    return process.env.OLLAMA_MODEL ?? 'dengcao/Qwen3-Embedding-0.6B:Q8_0';
  }
  if (provider === 'openai') {
    return process.env.OPENAI_MODEL_NAME ?? 'text-embedding-ada-002';
  }
  return process.env.HUGGINGFACE_MODEL_NAME ?? 'sentence-transformers/all-MiniLM-L6-v2';
}
