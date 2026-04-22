import * as fsp from 'fs/promises';
import * as path from 'path';
import { Document } from '@langchain/core/documents';
import type { BenchmarkCounterState, StubController } from './types.js';
import { sleep } from './utils.js';

interface StoredRecord {
  metadata: Record<string, unknown>;
  pageContent: string;
  vector: number[];
}

interface StubEmbeddingHost {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

const counters: BenchmarkCounterState = {
  addDocumentsCalls: 0,
  embeddedDocuments: 0,
  embeddedQueries: 0,
  fromTextsCalls: 0,
  loadCalls: 0,
  saveCalls: 0,
};

let installed = false;

class StubFaissStore {
  constructor(
    private readonly embeddings: StubEmbeddingHost,
    private readonly records: StoredRecord[],
  ) {}

  static async fromTexts(
    texts: string[],
    metadatas: Array<Record<string, unknown>>,
    embeddings: StubEmbeddingHost,
  ): Promise<StubFaissStore> {
    counters.fromTextsCalls += 1;
    const vectors = await embeddings.embedDocuments(texts);
    const records = texts.map((text, index) => ({
      metadata: metadatas[index] ?? {},
      pageContent: text,
      vector: vectors[index],
    }));
    return new StubFaissStore(embeddings, records);
  }

  static async load(filePath: string, embeddings: StubEmbeddingHost): Promise<StubFaissStore> {
    counters.loadCalls += 1;
    const contents = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(contents) as { records: StoredRecord[] };
    return new StubFaissStore(embeddings, parsed.records);
  }

  async addDocuments(documents: Document[]): Promise<void> {
    counters.addDocumentsCalls += 1;
    const texts = documents.map((document) => document.pageContent);
    const vectors = await this.embeddings.embedDocuments(texts);

    documents.forEach((document, index) => {
      this.records.push({
        metadata: document.metadata as Record<string, unknown>,
        pageContent: document.pageContent,
        vector: vectors[index],
      });
    });
  }

  async save(filePath: string): Promise<void> {
    counters.saveCalls += 1;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify({ format: 'stub-faiss-v1', records: this.records }), 'utf-8');
  }

  async similaritySearchWithScore(
    query: string,
    k: number,
    filter?: { score?: { $lte?: number } },
  ): Promise<Array<[Document, number]>> {
    const threshold = filter?.score?.$lte ?? Number.POSITIVE_INFINITY;
    const queryVector = await this.embeddings.embedQuery(query);

    return this.records
      .map((record) => [
        new Document({
          metadata: record.metadata,
          pageContent: record.pageContent,
        }),
        euclideanDistance(queryVector, record.vector),
      ] as [Document, number])
      .filter(([, score]) => score <= threshold)
      .sort((left, right) => left[1] - right[1])
      .slice(0, k);
  }
}

export async function installStubProvider(): Promise<StubController> {
  if (!installed) {
    await patchEmbeddings();
    await patchFaissStore();
    installed = true;
  }

  return {
    getCounters: () => ({ ...counters }),
    resetCounters: () => {
      counters.addDocumentsCalls = 0;
      counters.embeddedDocuments = 0;
      counters.embeddedQueries = 0;
      counters.fromTextsCalls = 0;
      counters.loadCalls = 0;
      counters.saveCalls = 0;
    },
  };
}

function euclideanDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

async function patchEmbeddings(): Promise<void> {
  const embeddingModules = await Promise.all([
    import('@langchain/community/embeddings/hf'),
    import('@langchain/ollama'),
    import('@langchain/openai'),
  ]);

  for (const module of embeddingModules) {
    const exported = Object.values(module).find((value) => typeof value === 'function');
    if (!exported) {
      continue;
    }

    const embeddingClass = exported as {
      prototype: {
        embedDocuments: (texts: string[]) => Promise<number[][]>;
        embedQuery: (text: string) => Promise<number[]>;
      };
    };

    embeddingClass.prototype.embedDocuments = async function embedDocuments(texts: string[]): Promise<number[][]> {
      counters.embeddedDocuments += texts.length;
      const millisecondsPerInput = Number(process.env.BENCH_STUB_EMBED_MS_PER_INPUT ?? '20');
      await sleep(millisecondsPerInput * texts.length);
      return texts.map((text) => vectorize(text));
    };

    embeddingClass.prototype.embedQuery = async function embedQuery(text: string): Promise<number[]> {
      counters.embeddedQueries += 1;
      return vectorize(text);
    };
  }
}

async function patchFaissStore(): Promise<void> {
  const faissModule = await import('@langchain/community/vectorstores/faiss');
  const mutableFaissStore = faissModule.FaissStore as unknown as {
    fromTexts: typeof StubFaissStore.fromTexts;
    load: typeof StubFaissStore.load;
  };

  mutableFaissStore.fromTexts = StubFaissStore.fromTexts;
  mutableFaissStore.load = StubFaissStore.load;
}

function vectorize(text: string): number[] {
  const vector = Array.from({ length: 64 }, () => 0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);

  for (const token of tokens) {
    const bucket = fnv1a(token) % vector.length;
    vector[bucket] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
