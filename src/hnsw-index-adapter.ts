import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import type { HierarchicalNSW as HierarchicalNSWHandle, SpaceName } from 'hnswlib-node';
import type { HnswIndexConfig } from './config/indexing.js';
import type {
  EmbeddedDocumentsBatch,
  FaissSearchTimingSink,
  QueryEmbeddingLookup,
} from './faiss-store-adapter.js';
import type {
  ScoredIndexDocument,
  SearchIndexAdapter,
} from './search-index-adapter.js';

export const HNSW_INDEX_FILENAME = 'hnsw.index';
export const HNSW_DOCSTORE_FILENAME = 'docstore.json';
export const HNSW_DOCSTORE_SCHEMA_VERSION = 'kb.hnsw-docstore.v1';

interface HnswDocstorePayload {
  schema_version: typeof HNSW_DOCSTORE_SCHEMA_VERSION;
  documents: Array<{
    id: string;
    pageContent: string;
    metadata: Record<string, unknown>;
  }>;
}

type HnswlibModule = {
  HierarchicalNSW: new (spaceName: SpaceName, numDimensions: number) => HierarchicalNSWHandle;
};

async function importHnswlib(): Promise<HnswlibModule> {
  return await import('hnswlib-node') as HnswlibModule;
}

function assertVectorShape(vectors: readonly number[][]): number {
  const dimension = vectors[0]?.length;
  if (dimension === undefined || dimension <= 0) {
    throw new Error('HNSW index requires at least one non-empty vector');
  }
  for (const vector of vectors) {
    if (vector.length !== dimension) {
      throw new Error('HNSW index requires equal-length vectors');
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new Error('HNSW index received a non-finite vector value');
    }
  }
  return dimension;
}

function toDocument(entry: HnswDocstorePayload['documents'][number]): Document {
  return {
    pageContent: entry.pageContent,
    metadata: entry.metadata ?? {},
  } as Document;
}

function asDocstorePayload(documents: readonly Document[]): HnswDocstorePayload {
  return {
    schema_version: HNSW_DOCSTORE_SCHEMA_VERSION,
    documents: documents.map((document, index) => ({
      id: `doc-${index}`,
      pageContent: document.pageContent,
      metadata: { ...(document.metadata as Record<string, unknown> | undefined) },
    })),
  };
}

export class HnswIndexAdapter implements SearchIndexAdapter {
  private constructor(
    private readonly index: HierarchicalNSWHandle,
    private readonly documents: Document[],
    private readonly config: HnswIndexConfig,
  ) {}

  static async fromEmbeddedDocuments(
    embedded: EmbeddedDocumentsBatch,
    config: HnswIndexConfig,
  ): Promise<HnswIndexAdapter> {
    const dimension = assertVectorShape(embedded.vectors);
    const { HierarchicalNSW } = await importHnswlib();
    const index = new HierarchicalNSW(config.metric, dimension);
    index.initIndex({
      maxElements: Math.max(1, embedded.vectors.length),
      m: config.m,
      efConstruction: config.efConstruction,
      randomSeed: config.randomSeed,
      allowReplaceDeleted: false,
    });
    index.setEf(config.efSearch);
    const adapter = new HnswIndexAdapter(index, [], config);
    await adapter.addEmbeddedDocuments(embedded);
    return adapter;
  }

  static async load(
    directory: string,
    config: HnswIndexConfig,
    dimensions: number,
  ): Promise<HnswIndexAdapter> {
    const rawDocstore = await fsp.readFile(
      path.join(directory, HNSW_DOCSTORE_FILENAME),
      'utf-8',
    );
    const parsed = JSON.parse(rawDocstore) as HnswDocstorePayload;
    if (parsed.schema_version !== HNSW_DOCSTORE_SCHEMA_VERSION || !Array.isArray(parsed.documents)) {
      throw new Error('HNSW docstore has an unsupported schema');
    }
    const documents = parsed.documents.map(toDocument);
    const { HierarchicalNSW } = await importHnswlib();
    const index = new HierarchicalNSW(config.metric, dimensions);
    await index.readIndex(path.join(directory, HNSW_INDEX_FILENAME), false);
    index.setEf(config.efSearch);
    if (index.getCurrentCount() !== documents.length) {
      throw new Error(
        `HNSW index/docstore divergence after load: count=${index.getCurrentCount()}, ` +
          `docstore.size=${documents.length}`,
      );
    }
    return new HnswIndexAdapter(index, documents, config);
  }

  async save(directory: string): Promise<void> {
    await fsp.mkdir(directory, { recursive: true });
    await this.index.writeIndex(path.join(directory, HNSW_INDEX_FILENAME));
    await fsp.writeFile(
      path.join(directory, HNSW_DOCSTORE_FILENAME),
      `${JSON.stringify(asDocstorePayload(this.documents), null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  }

  async addEmbeddedDocuments(embedded: EmbeddedDocumentsBatch): Promise<void> {
    if (embedded.documents.length === 0) return;
    const dimension = assertVectorShape(embedded.vectors);
    if (dimension !== this.index.getNumDimensions()) {
      throw new Error(
        `HNSW vector dimension mismatch: index=${this.index.getNumDimensions()}, vectors=${dimension}`,
      );
    }
    const nextTotal = this.documents.length + embedded.documents.length;
    if (nextTotal > this.index.getMaxElements()) {
      this.index.resizeIndex(nextTotal);
    }
    for (let i = 0; i < embedded.documents.length; i += 1) {
      const label = this.documents.length;
      this.index.addPoint(embedded.vectors[i], label, false);
      this.documents.push(embedded.documents[i]);
    }
    if (this.index.getCurrentCount() !== this.documents.length) {
      throw new Error(
        `HNSW index/docstore divergence after batch: count=${this.index.getCurrentCount()}, ` +
          `docstore.size=${this.documents.length}`,
      );
    }
  }

  async similaritySearchUsingBestPath(options: {
    query: string;
    k: number;
    timing?: FaissSearchTimingSink;
    getQueryEmbedding: () => Promise<QueryEmbeddingLookup>;
  }): Promise<ScoredIndexDocument[]> {
    if (this.documents.length === 0 || options.k <= 0) return [];

    const embedStartedAt = Date.now();
    const cached = await options.getQueryEmbedding();
    if (options.timing) {
      if (options.timing.embed_query_ms === undefined) {
        options.timing.embed_query_ms = Date.now() - embedStartedAt;
      }
      if (options.timing.query_cache === undefined) {
        options.timing.query_cache = cached.status;
      }
      if (options.timing.query_cache_telemetry === undefined) {
        options.timing.query_cache_telemetry = cached.telemetry;
      }
    }

    const searchStartedAt = Date.now();
    if (cached.embedding.length !== this.index.getNumDimensions()) {
      throw new Error(
        `HNSW query dimension mismatch: index=${this.index.getNumDimensions()}, ` +
          `query=${cached.embedding.length}`,
      );
    }
    this.index.setEf(this.config.efSearch);
    const result = this.index.searchKnn(cached.embedding, Math.min(options.k, this.documents.length));
    if (options.timing) {
      options.timing.faiss_search_ms =
        (options.timing.faiss_search_ms ?? 0) + (Date.now() - searchStartedAt);
    }
    return result.neighbors.map((label, i) => {
      const document = this.documents[label];
      if (document === undefined) {
        throw new Error(`HNSW search returned missing docstore label ${label}`);
      }
      return [document, result.distances[i]] as ScoredIndexDocument;
    });
  }

  totalVectors(): number {
    return this.index.getCurrentCount();
  }

  vectorDimension(): number {
    return this.index.getNumDimensions();
  }

  docstoreDocuments(): Document[] {
    return [...this.documents];
  }

  docstoreEntries(): Array<[string, Document]> {
    return this.documents.map((document, index) => [`doc-${index}`, document]);
  }

  chunkCountsByKnowledgeBase(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const doc of this.documents) {
      const kb = doc.metadata?.knowledgeBase;
      if (typeof kb === 'string') {
        counts[kb] = (counts[kb] ?? 0) + 1;
      }
    }
    return counts;
  }
}
