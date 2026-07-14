import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { Document } from '@langchain/core/documents';
import { createMockEmbeddings } from '../../../src/test-support/embeddings.js';
import {
  activeIndexSymlink,
  chunkManifestPath,
  createChaosWorkspace,
  fsError,
  hashSidecarPath,
  modelDir,
  pathExists,
  pendingManifestPath,
  readJson,
  readQuarantineJsonl,
  restoreChaosEnv,
  saveChaosEnv,
  writeFixtureNote,
  type ChaosWorkspace,
  type SavedEnv,
} from '../fault-harness.js';

type EmbeddingFault = 'none' | 'timeout' | 'wrong-count';
type SaveFault = 'none' | 'disk-full';

let mockEmbeddingFault: EmbeddingFault = 'none';
let mockSaveFault: SaveFault = 'none';
const mockEmbedDocuments = jest.fn(async (texts: string[]) => {
  if (mockEmbeddingFault === 'timeout') {
    throw fsError('PROVIDER_TIMEOUT', 'embedding provider timed out');
  }
  if (mockEmbeddingFault === 'wrong-count') {
    return texts.slice(0, Math.max(0, texts.length - 1)).map(mockVectorForText);
  }
  return texts.map(mockVectorForText);
});
const mockEmbedQuery = jest.fn(async (text: string) => mockVectorForText(text));
const mockEmbeddings = createMockEmbeddings({
  embedDocuments: mockEmbedDocuments,
  embedQuery: mockEmbedQuery,
});
const mockSave = jest.fn();
const mockAddVectors = jest.fn();
const mockLoad = jest.fn();

function mockVectorForText(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16_777_619);
  }
  return [text.length, hash >>> 0];
}

class MockFaissStore {
  public docstore = { _docs: new Map<string, Document>() };
  public index = {
    _n: 0,
    ntotal: () => this.index._n,
    getDimension: () => 2,
  };

  constructor(public embeddings: EmbeddingsInterface) {}

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    mockAddVectors(vectors, documents);
    const expectedDimension = vectors[0]?.length ?? 0;
    for (const vector of vectors) {
      if (vector.length !== expectedDimension || vector.some((value) => !Number.isFinite(value))) {
        throw fsError('EMBED_MALFORMED', 'embedding provider returned malformed vectors');
      }
    }
    documents.forEach((document, i) => {
      this.docstore._docs.set(`doc-${this.index._n + i}`, document);
    });
    this.index._n += documents.length;
  }

  async save(directory: string): Promise<void> {
    mockSave(directory);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'faiss.index'), `vectors=${this.index._n}\n`, 'utf-8');
    if (mockSaveFault === 'disk-full') {
      throw fsError('ENOSPC', 'no space left on device while writing docstore');
    }
    await fsp.writeFile(
      path.join(directory, 'docstore.json'),
      JSON.stringify(Array.from(this.docstore._docs.entries())),
      'utf-8',
    );
  }

  async similaritySearchWithScore(): Promise<[]> {
    return [];
  }

  static async load(directory: string, embeddings: EmbeddingsInterface): Promise<MockFaissStore> {
    mockLoad(directory, embeddings);
    const store = new MockFaissStore(embeddings);
    const raw = await fsp.readFile(path.join(directory, 'docstore.json'), 'utf-8');
    const entries = JSON.parse(raw) as Array<[string, Document]>;
    entries.forEach(([id, document]) => store.docstore._docs.set(id, document));
    store.index._n = entries.length;
    return store;
  }
}

jest.mock('@langchain/community/embeddings/hf', () => ({
  __esModule: true,
  HuggingFaceInferenceEmbeddings: class MockEmbedding {
    embedDocuments = mockEmbeddings.embedDocuments;
    embedQuery = mockEmbeddings.embedQuery;
  },
}));

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));

describe('ingest chaos suite', () => {
  let workspace: ChaosWorkspace;
  let savedEnv: SavedEnv;

  beforeEach(async () => {
    savedEnv = saveChaosEnv();
    mockEmbeddingFault = 'none';
    mockSaveFault = 'none';
    mockEmbedDocuments.mockClear();
    mockEmbedQuery.mockClear();
    mockSave.mockClear();
    mockAddVectors.mockClear();
    mockLoad.mockClear();
    jest.resetModules();
    workspace = await createChaosWorkspace();
  });

  afterEach(async () => {
    restoreChaosEnv(savedEnv);
    await fsp.rm(workspace.tempDir, { recursive: true, force: true });
  });

  async function runUpdate(): Promise<import('../../../src/FaissIndexManager.js').FaissIndexManager> {
    const { FaissIndexManager } = await import('../../../src/FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex(workspace.kbName);
    return manager;
  }

  it('recovers a save-complete interruption by replaying missing sidecars on initialize', async () => {
    await writeFixtureNote(workspace);
    await runUpdate();

    const hashSidecar = hashSidecarPath(workspace);
    const chunkSidecar = chunkManifestPath(workspace);
    const hash = await fsp.readFile(hashSidecar, 'utf-8');
    const manifest = await readJson(chunkSidecar);

    await fsp.rm(hashSidecar, { force: true });
    await fsp.rm(chunkSidecar, { force: true });
    await fsp.writeFile(
      pendingManifestPath(workspace),
      JSON.stringify({
        schema_version: 'kb.pending-sidecar-commit.v1',
        phase: 'save-complete',
        pending_hash_writes: [{ path: hashSidecar, hash }],
        pending_chunk_manifest_writes: [{ path: chunkSidecar, manifest }],
      }),
      'utf-8',
    );

    jest.resetModules();
    const { FaissIndexManager } = await import('../../../src/FaissIndexManager.js');
    const recovered = new FaissIndexManager();
    await recovered.initialize();

    await expect(fsp.readFile(hashSidecar, 'utf-8')).resolves.toBe(hash);
    await expect(readJson(chunkSidecar)).resolves.toEqual(manifest);
    await expect(pathExists(pendingManifestPath(workspace))).resolves.toBe(false);
    expect(recovered.hasLoadedIndex).toBe(true);
  });

  it('leaves no active index when disk fills during the versioned FAISS save', async () => {
    await writeFixtureNote(workspace);
    mockSaveFault = 'disk-full';

    await expect(runUpdate()).rejects.toMatchObject({ code: 'ENOSPC' });

    const summary = await readJson<{ summary: { status: string; failures: Array<{ phase: string; code: string }> } }>(
      path.join(modelDir(workspace), 'last-index-update.json'),
    );
    expect(summary.summary.status).toBe('failed');
    expect(summary.summary.failures).toEqual([
      expect.objectContaining({ phase: 'save', code: 'ENOSPC' }),
    ]);
    await expect(pathExists(activeIndexSymlink(workspace))).resolves.toBe(false);
    await expect(pathExists(hashSidecarPath(workspace))).resolves.toBe(false);

    mockSaveFault = 'none';
    jest.resetModules();
    await runUpdate();
    await expect(pathExists(activeIndexSymlink(workspace))).resolves.toBe(true);
    await expect(pathExists(hashSidecarPath(workspace))).resolves.toBe(true);
  });

  it('quarantines an embedding-provider timeout and keeps the index unpublished', async () => {
    await writeFixtureNote(workspace);
    mockEmbeddingFault = 'timeout';

    await expect(runUpdate()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    const records = await readQuarantineJsonl(workspace);
    expect(records).toEqual([
      expect.objectContaining({
        relative_path: 'runbook.md',
        error_code: 'PROVIDER_TIMEOUT',
      }),
    ]);
    await expect(pathExists(activeIndexSymlink(workspace))).resolves.toBe(false);

    const { KBError } = await import('../../../src/errors.js');
    const { classifyKbSearchError } = await import('../../../src/search-errors-core.js');
    expect(classifyKbSearchError(new KBError('PROVIDER_TIMEOUT', 'request timed out'))).toEqual(
      expect.objectContaining({
        category: 'provider',
        next_action: expect.stringContaining('Retry once'),
      }),
    );
  });

  it('quarantines malformed embedding responses before any FAISS save is published', async () => {
    await writeFixtureNote(workspace);
    mockEmbeddingFault = 'wrong-count';

    await expect(runUpdate()).rejects.toThrow(/Embedding provider returned 0 vector/);

    const records = await readQuarantineJsonl(workspace);
    expect(records).toEqual([
      expect.objectContaining({
        relative_path: 'runbook.md',
        error_category: 'unknown',
        message: expect.stringContaining('Embedding provider returned 0 vector'),
      }),
    ]);
    expect(mockSave).not.toHaveBeenCalled();
    await expect(pathExists(activeIndexSymlink(workspace))).resolves.toBe(false);
  });

  it('trips the contextual-preface circuit breaker after consecutive LLM timeouts', async () => {
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'on';
    process.env.KB_LLM_ENDPOINT = 'http://127.0.0.1:0/v1/chat/completions';
    const fetchMock = jest.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'AbortError' });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { resolveContextualPrefaces, sidecarPathFor } =
      await import('../../../src/contextual-preface.js');
    const source = path.join(workspace.kbPath, 'long.md');
    const chunks = Array.from({ length: 8 }, (_, i) => `chunk ${i}`);

    const resolved = await resolveContextualPrefaces({
      source,
      knowledgeBaseName: workspace.kbName,
      documentHash: 'h-circuit',
      documentBody: chunks.join('\n\n'),
      chunks,
    });

    expect(resolved).toEqual(chunks.map(() => null));
    expect(fetchMock).toHaveBeenCalledTimes(15);
    const sidecar = await readJson<{ chunks: Array<{ preface: string | null; error_code: string }> }>(
      sidecarPathFor(source, workspace.kbName),
    );
    expect(sidecar.chunks).toHaveLength(chunks.length);
    expect(sidecar.chunks.every((chunk) =>
      chunk.preface === null && chunk.error_code === 'llm_unreachable',
    )).toBe(true);
  }, 20_000);
});
