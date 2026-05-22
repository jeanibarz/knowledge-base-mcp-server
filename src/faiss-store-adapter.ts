import { FaissStore, type FaissLibArgs } from '@langchain/community/vectorstores/faiss';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { Document } from '@langchain/core/documents';
import { embeddingText } from './contextual-preface.js';
import { resolveFaissIndexType, type FaissIndexType } from './config/indexing.js';
import type { QueryCacheLookupStatus, QueryCacheTelemetry } from './query-cache.js';

type ScoredFaissDocument = [Document, number];

type FaissStoreWithEmbeddings = FaissStore & {
  embeddings: EmbeddingsInterface;
};

type FaissStoreWithVectorSearch = FaissStore & {
  similaritySearchVectorWithScore: (
    queryEmbedding: number[],
    k: number,
  ) => Promise<ScoredFaissDocument[]>;
};

type FaissIndexHandle = {
  ntotal: () => number;
  getDimension: () => number;
  isTrained?: () => boolean;
  train?: (vectors: number[]) => void;
};

type FaissNodeModule = {
  Index: {
    fromFactory: (dims: number, descriptor: string, metric?: number) => FaissIndexHandle;
  };
  MetricType: {
    METRIC_L2: number;
  };
};

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object; got ${describeShape(value)}`);
  }
}

function assertEmbeddingsSlot(store: FaissStore): asserts store is FaissStoreWithEmbeddings {
  assertObject(store, 'FAISS store');
  const candidate = store as Record<string, unknown>;
  if (!isObject(candidate.embeddings)) {
    throw new Error('FAISS store is missing an embeddings client');
  }
}

function getIndexHandle(store: FaissStore): FaissIndexHandle {
  assertObject(store, 'FAISS store');
  const index = (store as Record<string, unknown>).index;
  assertObject(index, 'FAISS store index');
  if (typeof index.ntotal !== 'function') {
    throw new Error('FAISS store index is missing ntotal()');
  }
  if (typeof index.getDimension !== 'function') {
    throw new Error('FAISS store index is missing getDimension()');
  }
  return index as FaissIndexHandle;
}

async function importFaissNode(): Promise<FaissNodeModule> {
  const mod = await import('faiss-node') as unknown as { default: FaissNodeModule };
  return mod.default;
}

function flattenVectors(vectors: readonly number[][]): number[] {
  return vectors.flatMap((vector) => vector);
}

async function createIndexForVectors(
  vectors: readonly number[][],
  indexType: FaissIndexType,
): Promise<FaissIndexHandle | undefined> {
  const dimension = vectors[0]?.length;
  if (dimension === undefined) return undefined;
  if (indexType === 'flat') return undefined;

  const faiss = await importFaissNode();
  const index = faiss.Index.fromFactory(dimension, 'SQ8', faiss.MetricType.METRIC_L2);
  if (index.isTrained?.() === false) {
    index.train?.(flattenVectors(vectors));
  }
  return index;
}

/**
 * RFC 017 §3 — invariant check after every `addVectors` call. The FAISS
 * native `index.add()` and the in-memory `docstore.add()` are NOT a single
 * atomic operation in @langchain/community: if `docstore.add` throws
 * mid-batch (OOM, key collision, etc.), the index has the vectors and the
 * docstore doesn't. This check catches the divergence so the caller can
 * refuse to persist the staging store.
 */
function assertIndexDocstoreParity(store: FaissStore, label: string): void {
  const ntotal = getIndexHandle(store).ntotal();
  const docstoreSize = getDocstoreMap(store).size;
  if (ntotal !== docstoreSize) {
    throw new Error(
      `${label}: FAISS index/docstore divergence after batch — ntotal=${ntotal}, docstore.size=${docstoreSize}. ` +
        'This indicates a partial addVectors failure; the staging index must not be persisted.',
    );
  }
}

function getDocstoreMap(store: FaissStore): Map<string, Document> {
  assertObject(store, 'FAISS store');
  const docstore = (store as Record<string, unknown>).docstore;
  assertObject(docstore, 'FAISS store docstore');
  const docs = docstore._docs;
  if (!(docs instanceof Map)) {
    throw new Error('FAISS store docstore is missing _docs Map');
  }
  return docs as Map<string, Document>;
}

function getVectorSearch(store: FaissStore): FaissStoreWithVectorSearch['similaritySearchVectorWithScore'] | null {
  assertObject(store, 'FAISS store');
  const vectorSearch = (store as Record<string, unknown>).similaritySearchVectorWithScore;
  return typeof vectorSearch === 'function'
    ? vectorSearch as FaissStoreWithVectorSearch['similaritySearchVectorWithScore']
    : null;
}

export interface FaissSearchTimingSink {
  embed_query_ms?: number;
  query_cache?: QueryCacheLookupStatus | 'unavailable';
  query_cache_telemetry?: QueryCacheTelemetry;
  faiss_search_ms?: number;
  query_search_ms?: number;
}

export interface QueryEmbeddingLookup {
  embedding: number[];
  status: QueryCacheLookupStatus;
  telemetry: QueryCacheTelemetry;
}

/**
 * Small boundary around @langchain/community's FaissStore.
 *
 * FaissStore exposes several public-looking fields that are effectively
 * runtime internals for this project: `embeddings`, `index`, `docstore._docs`,
 * and the optional vector-first search method. Keep those assumptions here so
 * FaissIndexManager remains the public orchestration facade.
 */
export class FaissStoreAdapter {
  private constructor(private readonly store: FaissStore) {}

  static fromStore(store: FaissStore): FaissStoreAdapter {
    return new FaissStoreAdapter(store);
  }

  static async fromDocuments(
    documents: readonly Document[],
    embeddings: EmbeddingsInterface,
    options: { indexType?: FaissIndexType } = {},
  ): Promise<FaissStoreAdapter> {
    // RFC 017 §3 — the embedding-input text MAY differ from the docstore
    // text. When `metadata.contextual_preface` is present, `embeddingText`
    // returns `"{preface}\n\n{chunk}"`; otherwise it returns the raw chunk.
    // We pre-compute embeddings against `embeddingText(doc)` and then store
    // the documents verbatim via `addVectors` — preserving caller-visible
    // pageContent byte-identical to today while enriching the vector.
    const texts = documents.map(embeddingText);
    const vectors = await embeddings.embedDocuments(texts);
    if (vectors.length !== documents.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vector(s) for ${documents.length} document(s)`,
      );
    }
    const indexType = options.indexType ?? resolveFaissIndexType();
    const index = await createIndexForVectors(vectors, indexType);
    const store = new FaissStore(embeddings, { ...(index ? { index } : {}) } as FaissLibArgs);
    await store.addVectors(vectors, [...documents]);
    // Post-batch invariant: the FaissStore.addVectors call must produce a
    // 1:1 docstore-to-vector ratio. RFC 017 §3 mandates this check to catch
    // a partial-failure where `index.add()` succeeded but `docstore.add()`
    // threw mid-batch.
    assertIndexDocstoreParity(store, 'FaissStoreAdapter.fromDocuments');
    return new FaissStoreAdapter(store);
  }

  /**
   * Persistence is still implemented by faiss-store-layout.ts; this is the
   * only intentional raw-store handoff left outside the adapter.
   */
  getStoreForPersistence(): FaissStore {
    return this.store;
  }

  restoreEmbeddings(embeddings: EmbeddingsInterface): void {
    assertEmbeddingsSlot(this.store);
    this.store.embeddings = embeddings;
  }

  async addDocumentsWithEmbeddings(
    documents: readonly Document[],
    embeddings: EmbeddingsInterface,
  ): Promise<void> {
    assertEmbeddingsSlot(this.store);
    // RFC 017 §3 — embed against `embeddingText(doc)` (preface-prepended
    // when present), then call `addVectors` with the original documents.
    // The `embeddings` argument here may be an `IndexingEmbeddingDeduper`
    // (see FaissIndexManager:1062); it normalizes strings before
    // delegating, so two chunks with identical text but different prefaces
    // are now correctly different inputs and produce different vectors.
    const texts = documents.map(embeddingText);
    const vectors = await embeddings.embedDocuments(texts);
    if (vectors.length !== documents.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vector(s) for ${documents.length} document(s)`,
      );
    }
    await this.store.addVectors(vectors, [...documents]);
    assertIndexDocstoreParity(this.store, 'FaissStoreAdapter.addDocumentsWithEmbeddings');
  }

  async similaritySearchUsingBestPath(options: {
    query: string;
    k: number;
    timing?: FaissSearchTimingSink;
    getQueryEmbedding: () => Promise<QueryEmbeddingLookup>;
  }): Promise<ScoredFaissDocument[]> {
    const vectorSearch = getVectorSearch(this.store);
    if (vectorSearch === null) {
      const queryStartedAt = Date.now();
      const out = await this.store.similaritySearchWithScore(options.query, options.k);
      if (options.timing) {
        options.timing.query_cache = 'unavailable';
        options.timing.query_search_ms =
          (options.timing.query_search_ms ?? 0) + (Date.now() - queryStartedAt);
      }
      return out;
    }

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

    const faissStartedAt = Date.now();
    const out = await vectorSearch.call(this.store, cached.embedding, options.k);
    if (options.timing) {
      options.timing.faiss_search_ms =
        (options.timing.faiss_search_ms ?? 0) + (Date.now() - faissStartedAt);
    }
    return out;
  }

  totalVectors(): number {
    return getIndexHandle(this.store).ntotal();
  }

  vectorDimension(): number {
    return getIndexHandle(this.store).getDimension();
  }

  docstoreDocuments(): Document[] {
    return Array.from(getDocstoreMap(this.store).values());
  }

  /**
   * Issue #283 — emit `[docstoreId, Document]` pairs in insertion order so
   * the metadata sidecar can persist a stable id keyed by exactly what the
   * langchain docstore uses internally.
   */
  docstoreEntries(): Array<[string, Document]> {
    return Array.from(getDocstoreMap(this.store).entries());
  }

  chunkCountsByKnowledgeBase(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const doc of getDocstoreMap(this.store).values()) {
      const kb = doc.metadata?.knowledgeBase;
      if (typeof kb === 'string') {
        counts[kb] = (counts[kb] ?? 0) + 1;
      }
    }
    return counts;
  }
}
