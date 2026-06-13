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
  docstoreEntries(): Array<[string, Document]>;
  chunkCountsByKnowledgeBase(): Record<string, number>;
}
