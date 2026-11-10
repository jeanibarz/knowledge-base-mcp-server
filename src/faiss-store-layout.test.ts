import {
  EMBEDDING_CANARY_ID,
  EMBEDDING_CANARY_TEXT_SHA256,
  cosineSimilarity,
  createEmbeddingCanaryFingerprint,
  loadFaissStoreAtomic,
  loadHnswIndexAtomic,
  pruneInactiveIndexVersions,
  readIndexIntegrityManifest,
  repairIndexPointer,
  saveFaissStoreAtomic,
  saveHnswIndexAtomic,
} from './faiss-store-layout.js';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
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
      allowRebuild: true,
      embeddings: { embedDocuments: async () => [], embedQuery: async () => [] },
      handleFsOperationError: ((action: string, targetPath: string, error: unknown) => {
        throw new Error(`${action} ${targetPath}: ${(error as Error).message}`);
      }),
    });

    expect(loaded).toBeNull();
    // Issue #1179 — refusing the version must not delete the shared pointer.
    expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v0');
  });
});

// Issue #1179 — a version a process cannot use must keep its `index`
// pointer, so processes configured to match it still load it.
describe('loaders keep the active index pointer (#1179)', () => {
  const hnswConfig: HnswIndexConfig = {
    m: 8,
    efConstruction: 40,
    efSearch: 20,
    metric: 'l2',
    capacityPolicy: 'resize_to_fit',
    randomSeed: 100,
  };
  const embeddings = {
    embedDocuments: async (texts: string[]) => texts.map((_, i) => [i, 1]),
    embedQuery: async () => [0, 1],
  };
  const failOnFsError = ((action: string, targetPath: string, error: unknown) => {
    throw new Error(`${action} ${targetPath}: ${(error as Error).message}`);
  });

  async function makeFaissModelDir(): Promise<string> {
    const modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-1179-faiss-'));
    const store = await FaissStore.fromTexts(['alpha', 'beta'], [{}, {}], embeddings);
    await saveFaissStoreAtomic({ store, modelDir, modelId: 'model', swapCounter: 1, indexType: 'flat' });
    return modelDir;
  }

  async function makeHnswModelDir(): Promise<string> {
    const modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-1179-hnsw-'));
    const adapter = await HnswIndexAdapter.fromEmbeddedDocuments({
      documents: [{ pageContent: 'alpha', metadata: {} } as never],
      vectors: [[0, 1]],
    }, hnswConfig);
    await saveHnswIndexAtomic({ adapter, modelDir, modelId: 'model', swapCounter: 1, config: hnswConfig });
    return modelDir;
  }

  function loadFaiss(
    modelDir: string,
    expectedIndexType: 'flat' | 'sq8',
    repairCorrupt = true,
    allowRebuild = repairCorrupt,
  ) {
    return loadFaissStoreAtomic({
      allowRebuild,
      modelDir,
      modelId: 'model',
      embeddings,
      handleFsOperationError: failOnFsError,
      expectedIndexType,
      repairCorrupt,
    });
  }

  function loadHnsw(modelDir: string, config: HnswIndexConfig = hnswConfig, allowRebuild = true) {
    return loadHnswIndexAtomic({
      allowRebuild,
      modelDir,
      modelId: 'model',
      config,
      handleFsOperationError: failOnFsError,
    });
  }

  async function pointer(modelDir: string): Promise<string> {
    return fsp.readlink(path.join(modelDir, 'index'));
  }

  it('FAISS index-type mismatch returns null, keeps the pointer, and a matching load still works', async () => {
    const modelDir = await makeFaissModelDir();

    await expect(loadFaiss(modelDir, 'sq8')).resolves.toBeNull();

    expect(await pointer(modelDir)).toBe('index.v0');
    await expect(loadFaiss(modelDir, 'flat')).resolves.not.toBeNull();
  });

  it('FAISS index-type mismatch on a read-only load throws and keeps the pointer', async () => {
    const modelDir = await makeFaissModelDir();

    await expect(loadFaiss(modelDir, 'sq8', false)).rejects.toThrow(/written as flat.*expects sq8/);

    expect(await pointer(modelDir)).toBe('index.v0');
  });

  it('FAISS load failure returns null and keeps the pointer', async () => {
    const modelDir = await makeFaissModelDir();
    await fsp.writeFile(path.join(modelDir, 'index.v0', 'faiss.index'), 'corrupt-bytes');

    await expect(loadFaiss(modelDir, 'flat')).resolves.toBeNull();

    expect(await pointer(modelDir)).toBe('index.v0');
  });

  it('HNSW loader keeps the pointer on a backend mismatch', async () => {
    const modelDir = await makeFaissModelDir();

    await expect(loadHnsw(modelDir)).resolves.toBeNull();

    expect(await pointer(modelDir)).toBe('index.v0');
  });

  it('HNSW loader keeps the pointer when the manifest lacks HNSW metadata', async () => {
    const modelDir = await makeHnswModelDir();
    const manifestPath = path.join(modelDir, 'index.v0', 'integrity.json');
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    delete manifest.hnsw;
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));

    await expect(loadHnsw(modelDir)).resolves.toBeNull();

    expect(await pointer(modelDir)).toBe('index.v0');
  });

  it('HNSW loader keeps the pointer when tuning differs, and the original tuning still loads', async () => {
    const modelDir = await makeHnswModelDir();

    await expect(loadHnsw(modelDir, { ...hnswConfig, m: 16 })).resolves.toBeNull();

    expect(await pointer(modelDir)).toBe('index.v0');
    await expect(loadHnsw(modelDir)).resolves.not.toBeNull();
  });

  it('HNSW load failure returns null and keeps the pointer', async () => {
    const modelDir = await makeHnswModelDir();
    await fsp.writeFile(path.join(modelDir, 'index.v0', 'hnsw.index'), 'corrupt-bytes');

    await expect(loadHnsw(modelDir)).resolves.toBeNull();

    expect(await pointer(modelDir)).toBe('index.v0');
  });

  it('a writer without allowRebuild gets a typed INDEX_CONFIG_MISMATCH and the pointer is kept (#1181)', async () => {
    const faissDir = await makeFaissModelDir();
    await expect(loadFaiss(faissDir, 'sq8', true, false)).rejects.toMatchObject({ code: 'INDEX_CONFIG_MISMATCH' });
    // A read-only load throws the same typed error.
    await expect(loadFaiss(faissDir, 'sq8', false)).rejects.toMatchObject({ code: 'INDEX_CONFIG_MISMATCH' });
    expect(await pointer(faissDir)).toBe('index.v0');

    const hnswDir = await makeHnswModelDir();
    await expect(loadHnsw(hnswDir, { ...hnswConfig, m: 16 }, false))
      .rejects.toMatchObject({ code: 'INDEX_CONFIG_MISMATCH' });
    await expect(loadHnsw(faissDir, hnswConfig, false))
      .rejects.toMatchObject({ code: 'INDEX_CONFIG_MISMATCH' });
    expect(await pointer(hnswDir)).toBe('index.v0');
  });

  it('a writer without allowRebuild gets CORRUPT_INDEX instead of rebuilding over an unreadable version (#1181)', async () => {
    const faissDir = await makeFaissModelDir();
    await fsp.writeFile(path.join(faissDir, 'index.v0', 'faiss.index'), 'corrupt-bytes');
    await expect(loadFaiss(faissDir, 'flat', true, false)).rejects.toMatchObject({ code: 'CORRUPT_INDEX' });

    const hnswDir = await makeHnswModelDir();
    await fsp.writeFile(path.join(hnswDir, 'index.v0', 'hnsw.index'), 'corrupt-bytes');
    await expect(loadHnsw(hnswDir, hnswConfig, false)).rejects.toMatchObject({ code: 'CORRUPT_INDEX' });
    expect(await pointer(hnswDir)).toBe('index.v0');
  });

  it('a writer sees INDEX_POINTER_MISSING when versions exist but the pointer is gone; readers and allowRebuild get null (#1181)', async () => {
    const modelDir = await makeFaissModelDir();
    await fsp.rm(path.join(modelDir, 'index'));

    await expect(loadFaiss(modelDir, 'flat', true, false)).rejects.toMatchObject({ code: 'INDEX_POINTER_MISSING' });
    await expect(loadHnsw(modelDir, hnswConfig, false)).rejects.toMatchObject({ code: 'INDEX_POINTER_MISSING' });
    await expect(loadFaiss(modelDir, 'flat', false)).resolves.toBeNull();
    await expect(loadFaiss(modelDir, 'flat', true, true)).resolves.toBeNull();
  });

  it('repairIndexPointer re-points at the newest verifying version and skips a tampered one (#1181)', async () => {
    const modelDir = await makeFaissModelDir();
    const store = await FaissStore.fromTexts(['gamma'], [{}], embeddings);
    await saveFaissStoreAtomic({ store, modelDir, modelId: 'model', swapCounter: 2, indexType: 'flat' });
    expect(await pointer(modelDir)).toBe('index.v1');
    await fsp.rm(path.join(modelDir, 'index'));

    // Newest version is tampered -> fall back to v0.
    await fsp.writeFile(path.join(modelDir, 'index.v1', 'docstore.json'), '{}');
    await expect(repairIndexPointer(modelDir)).resolves.toMatchObject({ status: 'repaired', target: 'index.v0' });
    expect(await pointer(modelDir)).toBe('index.v0');
    // Idempotent: an existing pointer is never touched.
    await expect(repairIndexPointer(modelDir)).resolves.toMatchObject({ status: 'pointer_present' });

    await fsp.rm(path.join(modelDir, 'index'));
    await fsp.writeFile(path.join(modelDir, 'index.v0', 'docstore.json'), '{}');
    await expect(repairIndexPointer(modelDir)).resolves.toMatchObject({ status: 'no_verified_version' });
    await expect(fsp.lstat(path.join(modelDir, 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pruning keeps the newest version by creation time, not by version number (#1181)', async () => {
    const modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-1181-prune-'));
    const mk = async (name: string, ageMin: number) => {
      const dir = path.join(modelDir, name);
      await fsp.mkdir(dir);
      const t = new Date(Date.now() - ageMin * 60_000);
      await fsp.utimes(dir, t, t);
    };
    // Scrambled directory: numbering restarted, so v8 is newer than v38/v39.
    await mk('index.v38', 300);
    await mk('index.v39', 200);
    await mk('index.v8', 10);
    await mk('index.v40', 0);
    await fsp.symlink('index.v40', path.join(modelDir, 'index'));

    const result = await pruneInactiveIndexVersions(modelDir, { retention: 1 });

    expect(result.removed.sort()).toEqual(['index.v38', 'index.v39']);
    expect(result.kept.sort()).toEqual(['index.v40', 'index.v8']);
  });

  it('a save with no pointer numbers past existing versions instead of overwriting index.v0', async () => {
    const modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-1179-renumber-'));
    await fsp.mkdir(path.join(modelDir, 'index.v0'));
    await fsp.writeFile(path.join(modelDir, 'index.v0', 'marker'), 'v0');
    await fsp.mkdir(path.join(modelDir, 'index.v5'));
    await fsp.writeFile(path.join(modelDir, 'index.v5', 'marker'), 'v5');
    const store = await FaissStore.fromTexts(['alpha'], [{}], embeddings);

    await saveFaissStoreAtomic({ store, modelDir, modelId: 'model', swapCounter: 1, indexType: 'flat' });

    expect(await pointer(modelDir)).toBe('index.v6');
    expect(await fsp.readFile(path.join(modelDir, 'index.v0', 'marker'), 'utf-8')).toBe('v0');
    expect(await fsp.readFile(path.join(modelDir, 'index.v5', 'marker'), 'utf-8')).toBe('v5');
  });
});
