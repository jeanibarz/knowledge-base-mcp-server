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

  // RFC 017 §3 — `addDocumentsWithEmbeddings` no longer routes through
  // `FaissStore.addDocuments`; instead it embeds via the passed-in
  // `embeddings` (the IndexingEmbeddingDeduper at the production call
  // site) and then calls `store.addVectors(vectors, documents)`. The
  // documents are stored verbatim while the embedding input may differ
  // when `metadata.contextual_preface` is present.
  it('embeds upstream and calls addVectors with original documents', async () => {
    const indexingEmbeddings = {
      embedDocuments: jest.fn(async (texts: string[]) =>
        texts.map((_t, i) => Array(4).fill(i + 1)),
      ),
      embedQuery: jest.fn(),
    };
    const addVectors = jest.fn(async () => {});
    const ntotal = jest.fn(() => 2);
    const docsMap = new Map<string, unknown>([
      ['id-0', { pageContent: 'a', metadata: {} }],
      ['id-1', { pageContent: 'b', metadata: {} }],
    ]);
    const store = {
      embeddings: { embedDocuments: jest.fn(), embedQuery: jest.fn() },
      addVectors,
      index: { ntotal, getDimension: () => 4 },
      docstore: { _docs: docsMap },
    };
    const docs = [
      { pageContent: 'a', metadata: {} },
      { pageContent: 'b', metadata: {} },
    ];

    await adapterFor(store).addDocumentsWithEmbeddings(docs as never, indexingEmbeddings as never);

    // Both embedding texts came from doc.pageContent (no preface metadata).
    expect(indexingEmbeddings.embedDocuments).toHaveBeenCalledWith(['a', 'b']);
    // The original docs are what landed in the store, byte-for-byte.
    expect(addVectors).toHaveBeenCalledWith([[1, 1, 1, 1], [2, 2, 2, 2]], docs);
  });

  it('can embed a batch before serialized insertion', async () => {
    const indexingEmbeddings = {
      embedDocuments: jest.fn(async (texts: string[]) =>
        texts.map((_t, i) => [i + 1, i + 2]),
      ),
      embedQuery: jest.fn(),
    };
    const docs = [
      { pageContent: 'a', metadata: {} },
      { pageContent: 'b', metadata: {} },
    ];

    const embedded = await FaissStoreAdapter.embedDocumentsForIndexing(
      docs as never,
      indexingEmbeddings as never,
    );

    expect(embedded.documents).toBe(docs);
    expect(embedded.vectors).toEqual([[1, 2], [2, 3]]);

    const addVectors = jest.fn(async () => {});
    const store = {
      embeddings: { embedDocuments: jest.fn(), embedQuery: jest.fn() },
      addVectors,
      index: { ntotal: () => 2, getDimension: () => 2 },
      docstore: {
        _docs: new Map<string, unknown>([
          ['id-0', { pageContent: 'a', metadata: {} }],
          ['id-1', { pageContent: 'b', metadata: {} }],
        ]),
      },
    };

    await adapterFor(store).addEmbeddedDocuments(embedded);

    expect(addVectors).toHaveBeenCalledWith([[1, 2], [2, 3]], docs);
    expect(indexingEmbeddings.embedDocuments).toHaveBeenCalledTimes(1);
  });

  it('uses the preface-prepended form for embedding when metadata.contextual_preface is set', async () => {
    const indexingEmbeddings = {
      embedDocuments: jest.fn(async (texts: string[]) =>
        texts.map(() => [0, 0, 0, 0]),
      ),
      embedQuery: jest.fn(),
    };
    const store = {
      embeddings: { embedDocuments: jest.fn(), embedQuery: jest.fn() },
      addVectors: jest.fn(async () => {}),
      index: { ntotal: () => 1, getDimension: () => 4 },
      docstore: {
        _docs: new Map<string, unknown>([['id-0', { pageContent: 'chunk', metadata: {} }]]),
      },
    };
    const docs = [
      {
        pageContent: 'chunk',
        metadata: { contextual_preface: 'In Section 3, this chunk discusses pinning to CPU.' },
      },
    ];

    await adapterFor(store).addDocumentsWithEmbeddings(docs as never, indexingEmbeddings as never);

    // Embedding input is preface + "\n\n" + chunk, NOT the raw chunk.
    expect(indexingEmbeddings.embedDocuments).toHaveBeenCalledWith([
      'In Section 3, this chunk discusses pinning to CPU.\n\nchunk',
    ]);
  });

  it('rejects an embedding/document length mismatch', async () => {
    const indexingEmbeddings = {
      embedDocuments: jest.fn(async () => [[1, 2, 3]]), // 1 vector
      embedQuery: jest.fn(),
    };
    const store = {
      embeddings: { embedDocuments: jest.fn(), embedQuery: jest.fn() },
      addVectors: jest.fn(),
    };

    await expect(
      adapterFor(store).addDocumentsWithEmbeddings(
        [
          { pageContent: 'a', metadata: {} },
          { pageContent: 'b', metadata: {} },
        ] as never,
        indexingEmbeddings as never,
      ),
    ).rejects.toThrow(/Embedding provider returned 1 vector\(s\) for 2 document\(s\)/);
    expect(store.addVectors).not.toHaveBeenCalled();
  });

  it('rejects post-batch when ntotal !== docstore.size', async () => {
    // Simulate the partial-batch failure: addVectors "succeeds" but the
    // docstore ends up smaller than the index. Per RFC 017 §3, the
    // adapter must throw rather than allow a corrupted store to persist.
    const indexingEmbeddings = {
      embedDocuments: jest.fn(async () => [
        [1, 1, 1, 1],
        [2, 2, 2, 2],
      ]),
      embedQuery: jest.fn(),
    };
    const store = {
      embeddings: { embedDocuments: jest.fn(), embedQuery: jest.fn() },
      addVectors: jest.fn(async () => {}),
      index: { ntotal: () => 2, getDimension: () => 4 },
      docstore: {
        _docs: new Map<string, unknown>([['id-0', { pageContent: 'a', metadata: {} }]]),
      },
    };

    await expect(
      adapterFor(store).addDocumentsWithEmbeddings(
        [
          { pageContent: 'a', metadata: {} },
          { pageContent: 'b', metadata: {} },
        ] as never,
        indexingEmbeddings as never,
      ),
    ).rejects.toThrow(/index\/docstore divergence/);
  });

  it('pre-creates and trains an SQ8 index before adding the first vector batch', async () => {
    const embeddings = {
      embedDocuments: jest.fn(async () => [[1, 0], [0, 1]]),
      embedQuery: jest.fn(),
    };

    const adapter = await FaissStoreAdapter.fromDocuments(
      [
        { pageContent: 'a', metadata: {} },
        { pageContent: 'b', metadata: {} },
      ] as never,
      embeddings as never,
      { indexType: 'sq8' },
    );

    expect(adapter.totalVectors()).toBe(2);
    expect(adapter.vectorDimension()).toBe(2);
  });

  it('uses vector-first search when LangChain exposes it', async () => {
    const vectorSearch = jest.fn(async () => [[{ pageContent: 'hit', metadata: {} }, 0.1]]);
    const getQueryEmbedding = jest.fn(async () => ({
      embedding: [1, 2, 3],
      status: 'miss' as const,
      telemetry: {
        enabled: true,
        outcome: 'miss' as const,
        model_id: 'fake__model',
        elapsed_ms: 4,
      },
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
    expect(timing.query_cache_telemetry).toEqual({
      enabled: true,
      outcome: 'miss',
      model_id: 'fake__model',
      elapsed_ms: 4,
    });
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
