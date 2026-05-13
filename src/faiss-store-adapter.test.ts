import { FaissStoreAdapter, type FaissSearchTimingSink } from './faiss-store-adapter.js';

function adapterFor(store: Record<string, unknown>): FaissStoreAdapter {
  return FaissStoreAdapter.fromStore(store as never);
}

describe('FaissStoreAdapter', () => {
  it('guards raw index access before reading totals', () => {
    expect(() => adapterFor({}).totalVectors()).toThrow(
      'FAISS store index must be an object; got undefined',
    );
    expect(() => adapterFor({ index: {} }).totalVectors()).toThrow(
      'FAISS store index is missing ntotal()',
    );
    expect(() => adapterFor({ index: { ntotal: () => 3 } }).vectorDimension()).toThrow(
      'FAISS store index is missing getDimension()',
    );
  });

  it('reads vector totals and dimensions from a guarded index handle', () => {
    const adapter = adapterFor({
      index: {
        ntotal: () => 7,
        getDimension: () => 384,
      },
    });

    expect(adapter.totalVectors()).toBe(7);
    expect(adapter.vectorDimension()).toBe(384);
  });

  it('guards docstore internals before reading documents', () => {
    expect(() => adapterFor({ docstore: {} }).docstoreDocuments()).toThrow(
      'FAISS store docstore is missing _docs Map',
    );
  });

  it('derives per-KB counts from docstore documents', () => {
    const docs = new Map([
      ['a', { pageContent: 'a', metadata: { knowledgeBase: 'alpha' } }],
      ['b', { pageContent: 'b', metadata: { knowledgeBase: 'alpha' } }],
      ['c', { pageContent: 'c', metadata: { knowledgeBase: 'beta' } }],
      ['d', { pageContent: 'd', metadata: { knowledgeBase: 42 } }],
    ]);

    expect(adapterFor({ docstore: { _docs: docs } }).chunkCountsByKnowledgeBase()).toEqual({
      alpha: 2,
      beta: 1,
    });
  });

  it('temporarily swaps embeddings for addDocuments and restores the original client', async () => {
    const originalEmbeddings = { embedDocuments: jest.fn(), embedQuery: jest.fn() };
    const indexingEmbeddings = { embedDocuments: jest.fn(), embedQuery: jest.fn() };
    const addDocuments = jest.fn(async function add(this: { embeddings: unknown }) {
      expect(this.embeddings).toBe(indexingEmbeddings);
    });
    const store = {
      embeddings: originalEmbeddings,
      addDocuments,
    };

    await adapterFor(store).addDocumentsWithEmbeddings(
      [{ pageContent: 'doc', metadata: {} }] as never,
      indexingEmbeddings as never,
    );

    expect(addDocuments).toHaveBeenCalledWith([{ pageContent: 'doc', metadata: {} }]);
    expect(store.embeddings).toBe(originalEmbeddings);
  });

  it('restores embeddings when addDocuments throws', async () => {
    const originalEmbeddings = { embedDocuments: jest.fn(), embedQuery: jest.fn() };
    const indexingEmbeddings = { embedDocuments: jest.fn(), embedQuery: jest.fn() };
    const store = {
      embeddings: originalEmbeddings,
      addDocuments: jest.fn(async () => {
        throw new Error('provider failed');
      }),
    };

    await expect(
      adapterFor(store).addDocumentsWithEmbeddings(
        [{ pageContent: 'doc', metadata: {} }] as never,
        indexingEmbeddings as never,
      ),
    ).rejects.toThrow('provider failed');
    expect(store.embeddings).toBe(originalEmbeddings);
  });

  it('uses vector-first search when LangChain exposes it', async () => {
    const vectorSearch = jest.fn(async () => [[{ pageContent: 'hit', metadata: {} }, 0.1]]);
    const getQueryEmbedding = jest.fn(async () => ({
      embedding: [1, 2, 3],
      status: 'miss' as const,
    }));
    const timing: FaissSearchTimingSink = {};

    const results = await adapterFor({
      similaritySearchVectorWithScore: vectorSearch,
      similaritySearchWithScore: jest.fn(),
    }).similaritySearchUsingBestPath({
      query: 'q',
      k: 5,
      timing,
      getQueryEmbedding,
    });

    expect(getQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(vectorSearch).toHaveBeenCalledWith([1, 2, 3], 5);
    expect(results[0][0].pageContent).toBe('hit');
    expect(timing.query_cache).toBe('miss');
    expect(typeof timing.embed_query_ms).toBe('number');
    expect(typeof timing.faiss_search_ms).toBe('number');
  });

  it('falls back to query search and marks query cache unavailable', async () => {
    const querySearch = jest.fn(async () => [[{ pageContent: 'hit', metadata: {} }, 0.1]]);
    const getQueryEmbedding = jest.fn();
    const timing: FaissSearchTimingSink = {};

    const results = await adapterFor({
      similaritySearchWithScore: querySearch,
    }).similaritySearchUsingBestPath({
      query: 'q',
      k: 3,
      timing,
      getQueryEmbedding,
    });

    expect(getQueryEmbedding).not.toHaveBeenCalled();
    expect(querySearch).toHaveBeenCalledWith('q', 3);
    expect(results[0][0].pageContent).toBe('hit');
    expect(timing.query_cache).toBe('unavailable');
    expect(typeof timing.query_search_ms).toBe('number');
  });
});
