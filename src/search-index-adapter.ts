import type { Document } from '@langchain/core/documents';
import type {
  EmbeddedDocumentsBatch,
  FaissSearchTimingSink,
  QueryEmbeddingLookup,
} from './faiss-store-adapter.js';

export type ScoredIndexDocument = [Document, number];

export interface SearchIndexAdapter {
  addEmbeddedDocuments(embedded: EmbeddedDocumentsBatch): Promise<void>;
  similaritySearchUsingBestPath(options: {
    query: string;
    k: number;
    timing?: FaissSearchTimingSink;
    getQueryEmbedding: () => Promise<QueryEmbeddingLookup>;
  }): Promise<ScoredIndexDocument[]>;
  totalVectors(): number;
  vectorDimension(): number;
  docstoreDocuments(): Document[];
  /**
   * Issue #882 — lazily scan docstore entries and short-circuit on the first
   * match, without materializing a full `Document[]` copy. Callers that only
   * need "does any document satisfy `predicate`?" must prefer this over
   * `docstoreDocuments().some(...)` so a warm daemon does not allocate (and GC)
   * a full corpus copy per query.
   */
  anyDocument(predicate: (doc: Document) => boolean): boolean;
  docstoreEntries(): Array<[string, Document]>;
  chunkCountsByKnowledgeBase(): Record<string, number>;
}
