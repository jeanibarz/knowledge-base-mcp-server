import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import {
  HNSW_DOCSTORE_FILENAME,
  HNSW_INDEX_FILENAME,
  HnswIndexAdapter,
} from './hnsw-index-adapter.js';
import type { HnswIndexConfig } from './config/indexing.js';

const config: HnswIndexConfig = {
  m: 8,
  efConstruction: 40,
  efSearch: 20,
  metric: 'l2',
  capacityPolicy: 'resize_to_fit',
  randomSeed: 100,
};

function docs(): Document[] {
  return [
    { pageContent: 'alpha', metadata: { knowledgeBase: 'kb-a' } } as Document,
    { pageContent: 'beta', metadata: { knowledgeBase: 'kb-a' } } as Document,
    { pageContent: 'gamma', metadata: { knowledgeBase: 'kb-b' } } as Document,
  ];
}

describe('HnswIndexAdapter', () => {
  it('builds, queries, persists, and reloads a tuned HNSW index', async () => {
    const documents = docs();
    const adapter = await HnswIndexAdapter.fromEmbeddedDocuments({
      documents,
      vectors: [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
    }, config);

    expect(adapter.totalVectors()).toBe(3);
    expect(adapter.vectorDimension()).toBe(2);
    expect(adapter.chunkCountsByKnowledgeBase()).toEqual({ 'kb-a': 2, 'kb-b': 1 });

    const beforeSave = await adapter.similaritySearchUsingBestPath({
      query: 'ignored',
      k: 2,
      getQueryEmbedding: async () => ({
        embedding: [0, 0],
        status: 'miss',
        telemetry: { enabled: true, outcome: 'miss', model_id: 'm', elapsed_ms: 0 },
      }),
    });
    expect(beforeSave.map(([doc]) => doc.pageContent)).toContain('alpha');

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hnsw-adapter-'));
    await adapter.save(dir);
    await expect(fsp.stat(path.join(dir, HNSW_INDEX_FILENAME))).resolves.toBeTruthy();
    await expect(fsp.stat(path.join(dir, HNSW_DOCSTORE_FILENAME))).resolves.toBeTruthy();

    const loaded = await HnswIndexAdapter.load(dir, { ...config, efSearch: 30 }, 2);
    const afterLoad = await loaded.similaritySearchUsingBestPath({
      query: 'ignored',
      k: 1,
      getQueryEmbedding: async () => ({
        embedding: [10, 0],
        status: 'miss',
        telemetry: { enabled: true, outcome: 'miss', model_id: 'm', elapsed_ms: 0 },
      }),
    });

    expect(afterLoad).toHaveLength(1);
    expect(afterLoad[0][0].pageContent).toBe('beta');
  });

  it('rejects dimension mismatches before mutating the index', async () => {
    const adapter = await HnswIndexAdapter.fromEmbeddedDocuments({
      documents: [docs()[0]],
      vectors: [[0, 0]],
    }, config);

    await expect(adapter.addEmbeddedDocuments({
      documents: [docs()[1]],
      vectors: [[1, 2, 3]],
    })).rejects.toThrow(/dimension mismatch/);
    expect(adapter.totalVectors()).toBe(1);
  });
});
