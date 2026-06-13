import {
  EMBEDDING_CANARY_ID,
  EMBEDDING_CANARY_TEXT_SHA256,
  cosineSimilarity,
  createEmbeddingCanaryFingerprint,
  loadFaissStoreAtomic,
  readIndexIntegrityManifest,
  saveHnswIndexAtomic,
} from './faiss-store-layout.js';
import { HnswIndexAdapter } from './hnsw-index-adapter.js';
import type { HnswIndexConfig } from './config/indexing.js';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('embedding canary fingerprint', () => {
  it('captures the fixed document canary vector with a stable identity', async () => {
    const embeddings = {
      embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [0.6, 0.8])),
    };

    const fingerprint = await createEmbeddingCanaryFingerprint(
      embeddings,
      new Date('2026-06-13T00:00:00.000Z'),
    );

    expect(embeddings.embedDocuments).toHaveBeenCalledWith([
      expect.stringContaining('kb embedding canary v1'),
    ]);
    expect(fingerprint).toEqual({
      canary_id: EMBEDDING_CANARY_ID,
      text_sha256: EMBEDDING_CANARY_TEXT_SHA256,
      embedding_role: 'document',
      captured_at: '2026-06-13T00:00:00.000Z',
      dimensions: 2,
      vector: [0.6, 0.8],
    });
  });

  it('rejects missing and non-finite canary vectors', async () => {
    await expect(
      createEmbeddingCanaryFingerprint({
        embedDocuments: async () => [],
      }),
    ).rejects.toThrow(/no vector/);

    await expect(
      createEmbeddingCanaryFingerprint({
        embedDocuments: async () => [[1, Number.NaN]],
      }),
    ).rejects.toThrow(/non-finite/);
  });
});

describe('cosineSimilarity', () => {
  it('returns cosine similarity for equal-length finite vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns null for incompatible vectors', () => {
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([1], [1, 2])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 2])).toBeNull();
    expect(cosineSimilarity([1, Infinity], [1, 2])).toBeNull();
  });
});

describe('HNSW versioned layout', () => {
  const hnswConfig: HnswIndexConfig = {
    m: 8,
    efConstruction: 40,
    efSearch: 20,
    metric: 'l2',
    capacityPolicy: 'resize_to_fit',
    randomSeed: 100,
  };

  it('persists HNSW indexes with explicit backend metadata', async () => {
    const modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hnsw-layout-'));
    const adapter = await HnswIndexAdapter.fromEmbeddedDocuments({
      documents: [
        { pageContent: 'alpha', metadata: { knowledgeBase: 'kb' } } as never,
        { pageContent: 'beta', metadata: { knowledgeBase: 'kb' } } as never,
      ],
      vectors: [[0, 0], [1, 0]],
    }, hnswConfig);

    await saveHnswIndexAtomic({
      adapter,
      modelDir,
      modelId: 'model',
      swapCounter: 1,
      config: hnswConfig,
    });

    const active = await fsp.readlink(path.join(modelDir, 'index'));
    expect(active).toBe('index.v0');
    await expect(fsp.stat(path.join(modelDir, 'index.v0', 'hnsw.index'))).resolves.toBeTruthy();
    const manifest = await readIndexIntegrityManifest(path.join(modelDir, 'index.v0'));
    expect(manifest).toMatchObject({
      backend: 'hnsw',
      index_type: 'hnsw',
      hnsw: {
        m: 8,
        efConstruction: 40,
        efSearch: 20,
        metric: 'l2',
        capacity_policy: 'resize_to_fit',
        random_seed: 100,
        dimensions: 2,
        max_elements: 2,
      },
      files: {
        'hnsw.index': { sha256: expect.any(String) },
        'docstore.json': { sha256: expect.any(String) },
      },
    });
  });

  it('does not load an HNSW binary through the FAISS loader', async () => {
    const modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hnsw-mismatch-'));
    const adapter = await HnswIndexAdapter.fromEmbeddedDocuments({
      documents: [
        { pageContent: 'alpha', metadata: {} } as never,
      ],
      vectors: [[0, 0]],
    }, hnswConfig);
    await saveHnswIndexAtomic({
      adapter,
      modelDir,
      modelId: 'model',
      swapCounter: 1,
      config: hnswConfig,
    });

    const loaded = await loadFaissStoreAtomic({
      modelDir,
      modelId: 'model',
      embeddings: { embedDocuments: async () => [], embedQuery: async () => [] },
      handleFsOperationError: ((action: string, targetPath: string, error: unknown) => {
        throw new Error(`${action} ${targetPath}: ${(error as Error).message}`);
      }),
    });

    expect(loaded).toBeNull();
    await expect(fsp.lstat(path.join(modelDir, 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
