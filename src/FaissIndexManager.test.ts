import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

// RFC 013 M1+M2: per-model layout. Default test config (huggingface +
// BAAI/bge-small-en-v1.5) maps to this model_id slug.
const DEFAULT_MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';
function modelDirIn(faissPath: string): string {
  return path.join(faissPath, 'models', DEFAULT_MODEL_ID);
}
function modelIndexPathIn(faissPath: string): string {
  return path.join(modelDirIn(faissPath), 'faiss.index');
}
// RFC 014 — atomic save writes to versioned dirs (index.vN/) and swaps a
// symlink. First save under v014 always lands at index.v0.
function versionedIndexPathIn(faissPath: string, version = 'v0'): string {
  return path.join(modelDirIn(faissPath), `index.${version}`);
}
function modelNameFileIn(faissPath: string): string {
  return path.join(modelDirIn(faissPath), 'model_name.txt');
}
function lastIndexUpdatePathIn(faissPath: string): string {
  return path.join(modelDirIn(faissPath), 'last-index-update.json');
}
function pendingManifestPathIn(faissPath: string): string {
  return path.join(modelDirIn(faissPath), 'pending-manifest.json');
}
async function seedVersionedIndex(faissPath: string): Promise<void> {
  const modelDirPath = modelDirIn(faissPath);
  const versionDir = versionedIndexPathIn(faissPath);
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(path.join(versionDir, 'faiss.index'), 'mock-index');
  await fsp.writeFile(path.join(versionDir, 'docstore.json'), '{}');
  await fsp.symlink('index.v0', path.join(modelDirPath, 'index'));
}
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const saveMock = jest.fn();
const addDocumentsMock = jest.fn();
// RFC 017 §3 — FaissStoreAdapter no longer routes through
// `FaissStore.fromTexts` or `FaissStore.addDocuments`; both paths now
// embed upstream and call `addVectors(vectors, documents)`. The mock
// below tracks the new contract.
const fromTextsMock = jest.fn(); // legacy — retained for any test that still asserts on it
const addVectorsMock = jest.fn();
const loadMock = jest.fn();
const similaritySearchMock = jest.fn();
const embedDocumentsMock = jest.fn(async (texts: string[]) => texts.map(mockVectorForText));
const embedQueryMock = jest.fn(async (text: string) => mockVectorForText(text));
const embeddingConstructorMock = jest.fn();
const ollamaEmbeddingConstructorMock = jest.fn();
const openAIEmbeddingConstructorMock = jest.fn();

function mockVectorForText(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return [text.length, hash >>> 0];
}

class MockFaissStore {
  // Simulated FAISS-side state: a flat docstore Map and an ntotal counter
  // so the RFC 017 §3 `ntotal === docstore.size` parity check passes
  // through the adapter without throwing.
  public docstore = { _docs: new Map<string, { pageContent: string; metadata: unknown }>() };
  public index = {
    _n: 0,
    ntotal: () => this.index._n,
    getDimension: () => 2,
  };

  constructor(public embeddings: { embedDocuments: (texts: string[]) => Promise<number[][]> }) {}

  // RFC 017 §3 — the only mutation surface used by FaissStoreAdapter.
  async addVectors(vectors: number[][], documents: Array<{ pageContent: string; metadata?: Record<string, unknown> }>) {
    // Back-compat shim for existing tests that assert against
    // `fromTextsMock`. Pre-RFC-017, `FaissStoreAdapter.fromDocuments`
    // called `FaissStore.fromTexts(texts, metadatas, embeddings)` — the
    // initial seed. Now it constructs the store directly and calls
    // `addVectors`. We track the first addVectors as the seed so tests
    // that count `fromTextsMock` calls continue to work without
    // mechanical migration.
    if (this.index._n === 0) {
      fromTextsMock(
        documents.map((d) => d.pageContent),
        documents.map((d) => d.metadata ?? {}),
        this.embeddings,
      );
    } else {
      // Subsequent batches were tracked by `addDocumentsMock` pre-RFC-017;
      // the production path now bypasses `addDocuments` and calls
      // `addVectors` directly. Surface the call to addDocumentsMock for
      // back-compat with existing test assertions that count incremental
      // batches.
      addDocumentsMock(documents);
    }
    addVectorsMock(vectors, documents);
    documents.forEach((doc, i) => {
      this.docstore._docs.set(`doc-${this.index._n + i}`, {
        pageContent: doc.pageContent,
        metadata: doc.metadata ?? {},
      });
    });
    this.index._n += documents.length;
  }

  // Legacy `addDocuments` retained so any code path that still uses it
  // (tests that bypass the adapter, etc.) works.
  async addDocuments(...args: unknown[]) {
    const [documents] = args as [Array<{ pageContent: string; metadata?: Record<string, unknown> }>];
    await this.embeddings.embedDocuments(documents.map((doc) => doc.pageContent));
    await this.addVectors(
      documents.map((d) => mockVectorForText(d.pageContent)),
      documents,
    );
    return addDocumentsMock(...args);
  }

  async save(...args: unknown[]) {
    const [directory] = args as [string];
    const result = await saveMock(...args);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'faiss.index'), `vectors=${this.index._n}\n`, 'utf-8');
    await fsp.writeFile(
      path.join(directory, 'docstore.json'),
      JSON.stringify(Array.from(this.docstore._docs.entries())),
      'utf-8',
    );
    return result;
  }

  async similaritySearchWithScore(...args: unknown[]) {
    return similaritySearchMock(...args);
  }

  static async fromTexts(...args: unknown[]) {
    fromTextsMock(...args);
    const [texts, , embeddings] = args as [
      string[],
      unknown,
      { embedDocuments: (texts: string[]) => Promise<number[][]> },
    ];
    await embeddings.embedDocuments(texts);
    return new MockFaissStore(embeddings);
  }

  static async load(...args: unknown[]) {
    loadMock(...args);
    const [, embeddings] = args as [
      unknown,
      { embedDocuments: (texts: string[]) => Promise<number[][]> },
    ];
    return new MockFaissStore(embeddings);
  }
}

jest.mock('@langchain/community/embeddings/hf', () => ({
  __esModule: true,
  HuggingFaceInferenceEmbeddings: class MockEmbedding {
    constructor(public _config: unknown) {
      embeddingConstructorMock(_config);
    }
    embedDocuments = embedDocumentsMock;
    embedQuery = embedQueryMock;
  },
}));

jest.mock('@langchain/ollama', () => ({
  __esModule: true,
  OllamaEmbeddings: class MockOllamaEmbeddings {
    constructor(public _config: unknown) {
      ollamaEmbeddingConstructorMock(_config);
    }
    embedDocuments = embedDocumentsMock;
    embedQuery = embedQueryMock;
  },
}));

jest.mock('@langchain/openai', () => ({
  __esModule: true,
  OpenAIEmbeddings: class MockOpenAIEmbeddings {
    constructor(public _config: unknown) {
      openAIEmbeddingConstructorMock(_config);
    }
    embedDocuments = embedDocumentsMock;
    embedQuery = embedQueryMock;
  },
}));

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));

function loadedFaissStore(manager: unknown): Record<string, unknown> {
  const internal = manager as {
    faissIndex?: { getStoreForPersistence?: () => unknown } | null;
  };
  const store = internal.faissIndex?.getStoreForPersistence?.();
  if (store === undefined || store === null || typeof store !== 'object') {
    throw new Error('manager has no loaded FAISS store');
  }
  return store as Record<string, unknown>;
}

async function setLoadedFaissStore(manager: unknown, store: Record<string, unknown>): Promise<void> {
  const { FaissStoreAdapter } = await import('./faiss-store-adapter.js');
  (manager as { faissIndex?: unknown }).faissIndex = FaissStoreAdapter.fromStore(store as never);
}

function createPermissionError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

describe('provider construction', () => {
  // Issue #59 — embeddings are now built lazily inside initialize() via
  // dynamic import of the active provider's @langchain module. The
  // assertions below moved from `new FaissIndexManager()` to
  // `manager.initialize()`; the API-key-throw shape and the constructor-arg
  // shape are unchanged.
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL_NAME: process.env.OPENAI_MODEL_NAME,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    HUGGINGFACE_MODEL_NAME: process.env.HUGGINGFACE_MODEL_NAME,
    HUGGINGFACE_PROVIDER: process.env.HUGGINGFACE_PROVIDER,
    HUGGINGFACE_ENDPOINT_URL: process.env.HUGGINGFACE_ENDPOINT_URL,
  };

  async function seedTempEnv(): Promise<string> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-provider-ctor-'));
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    return tempDir;
  }

  beforeEach(() => {
    jest.resetModules();
    embeddingConstructorMock.mockReset();
    ollamaEmbeddingConstructorMock.mockReset();
    openAIEmbeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('constructs Ollama embeddings with the configured base URL and model on initialize()', async () => {
    await seedTempEnv();
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    process.env.OLLAMA_MODEL = 'mxbai-embed-large';

    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    expect(ollamaEmbeddingConstructorMock).not.toHaveBeenCalled();
    await manager.initialize();

    // Issue #86 — we now also pass an `onFailedAttempt` so deterministic
    // Ollama 4xx errors (e.g. "input length exceeds the context length")
    // short-circuit the AsyncCaller's 7-attempt retry loop.
    expect(ollamaEmbeddingConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'mxbai-embed-large',
        onFailedAttempt: expect.any(Function),
      }),
    );
  });

  it('throws when OPENAI_API_KEY is unset for the OpenAI provider', async () => {
    await seedTempEnv();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_MODEL_NAME = 'text-embedding-3-large';
    delete process.env.OPENAI_API_KEY;

    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { KBError } = await import('./errors.js');
    const manager = new FaissIndexManager();

    // Issue #59 — embeddings are constructed lazily inside initialize(), so
    // the API-key check fires there (not in the ctor). #116 — the throw is a
    // typed KBError with code PROVIDER_AUTH so MCP clients can branch on the
    // code rather than substring-matching the message.
    let caught: unknown;
    try {
      await manager.initialize();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KBError);
    expect(caught).toMatchObject({
      code: 'PROVIDER_AUTH',
      message: expect.stringContaining(
        'OPENAI_API_KEY environment variable is required when using OpenAI provider',
      ),
    });
    expect(openAIEmbeddingConstructorMock).not.toHaveBeenCalled();
  });

  it('constructs OpenAI embeddings with the configured model name on initialize()', async () => {
    await seedTempEnv();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL_NAME = 'text-embedding-3-large';

    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    expect(openAIEmbeddingConstructorMock).not.toHaveBeenCalled();
    await manager.initialize();

    expect(openAIEmbeddingConstructorMock).toHaveBeenCalledWith({
      apiKey: 'test-openai-key',
      model: 'text-embedding-3-large',
    });
  });

  it('keeps exact slash-containing HuggingFace model names in no-arg construction', async () => {
    await seedTempEnv();
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-base-en-v1.5';

    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    expect(manager.embeddingProvider).toBe('huggingface');
    expect(manager.modelName).toBe('BAAI/bge-base-en-v1.5');
    expect(manager.modelId).toBe('huggingface__BAAI-bge-base-en-v1.5');
  });

  it('throws when HUGGINGFACE_API_KEY is unset for the HuggingFace provider', async () => {
    await seedTempEnv();
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-base-en-v1.5';
    delete process.env.HUGGINGFACE_API_KEY;

    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { KBError } = await import('./errors.js');
    const manager = new FaissIndexManager();

    // Issue #59 — embeddings are constructed lazily inside initialize().
    // #116 — the throw is a typed KBError with code PROVIDER_AUTH.
    let caught: unknown;
    try {
      await manager.initialize();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KBError);
    expect(caught).toMatchObject({
      code: 'PROVIDER_AUTH',
      message: expect.stringContaining(
        'HUGGINGFACE_API_KEY environment variable is required when using HuggingFace provider',
      ),
    });
    expect(embeddingConstructorMock).not.toHaveBeenCalled();
  });
});

describe('FaissIndexManager permission handling', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    HUGGINGFACE_ENDPOINT_URL: process.env.HUGGINGFACE_ENDPOINT_URL,
    HUGGINGFACE_PROVIDER: process.env.HUGGINGFACE_PROVIDER,
    INDEXING_BATCH_SIZE: process.env.INDEXING_BATCH_SIZE,
    KB_INDEXING_CONCURRENCY: process.env.KB_INDEXING_CONCURRENCY,
    KB_FS_CONCURRENCY: process.env.KB_FS_CONCURRENCY,
    OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL,
    LOG_FILE: process.env.LOG_FILE,
    KB_MAX_FILE_BYTES: process.env.KB_MAX_FILE_BYTES,
    KB_MAX_EXTRACTED_TEXT_BYTES: process.env.KB_MAX_EXTRACTED_TEXT_BYTES,
    KB_LARGE_FILE_POLICY: process.env.KB_LARGE_FILE_POLICY,
    KB_CHUNK_SIZE: process.env.KB_CHUNK_SIZE,
    KB_CHUNK_OVERLAP: process.env.KB_CHUNK_OVERLAP,
    KB_REFRESH_QUIESCE_MS: process.env.KB_REFRESH_QUIESCE_MS,
    KB_INGEST_SECRET_SCAN: process.env.KB_INGEST_SECRET_SCAN,
    KB_SECRET_SCAN_BYPASS_KBS: process.env.KB_SECRET_SCAN_BYPASS_KBS,
    KB_LOG_FORMAT: process.env.KB_LOG_FORMAT,
    KB_INDEX_TYPE: process.env.KB_INDEX_TYPE,
    KB_HNSW_M: process.env.KB_HNSW_M,
    KB_HNSW_EF_CONSTRUCTION: process.env.KB_HNSW_EF_CONSTRUCTION,
    KB_HNSW_EF_SEARCH: process.env.KB_HNSW_EF_SEARCH,
    KB_HNSW_RANDOM_SEED: process.env.KB_HNSW_RANDOM_SEED,
  };


  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    addVectorsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embedDocumentsMock.mockReset();
    embedDocumentsMock.mockImplementation(async (texts: string[]) => texts.map(mockVectorForText));
    embedQueryMock.mockReset();
    embedQueryMock.mockImplementation(async (text: string) => mockVectorForText(text));
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  it('throws explicit error when FAISS directory cannot be created', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-init-'));
    const lockedDir = path.join(tempDir, 'locked');
    await fsp.mkdir(lockedDir, { recursive: true });
    await fsp.chmod(lockedDir, 0o500);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(lockedDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    try {
      jest.resetModules();
      const loggerModule = await import('./logger.js');
      const loggerErrorSpy = jest.spyOn(loggerModule.logger, 'error');
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const manager = new FaissIndexManager();

      await expect(manager.initialize()).rejects.toThrow(/Permission denied/);
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    } finally {
      await fsp.chmod(lockedDir, 0o700);
    }
  });

  it('passes the configured Hugging Face provider to the embeddings wrapper', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hf-provider-'));
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.HUGGINGFACE_PROVIDER = 'replicate';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    // Issue #59 — embeddings are constructed lazily inside initialize().
    await manager.initialize();

    expect(embeddingConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-key',
      model: 'BAAI/bge-small-en-v1.5',
      provider: 'replicate',
    }));
  });

  it('does not pass a Hugging Face provider when a custom endpoint URL is set', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hf-endpoint-'));
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.HUGGINGFACE_PROVIDER = 'replicate';
    process.env.HUGGINGFACE_ENDPOINT_URL = 'http://127.0.0.1:9999/custom/embed';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    // Issue #59 — embeddings are constructed lazily inside initialize().
    await manager.initialize();

    expect(embeddingConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-key',
      endpointUrl: 'http://127.0.0.1:9999/custom/embed',
      provider: undefined,
    }));
  });

  it('logs permission errors to file when saving FAISS index fails', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-update-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(docPath, '# Title\n\nSome content for embeddings.');

    const logFile = path.join(tempDir, 'logs', 'kb.log');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.LOG_FILE = logFile;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    saveMock.mockRejectedValue(createPermissionError('cannot write index'));

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await expect(manager.updateIndex()).rejects.toThrow(/Permission denied/);
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'failed',
      scope: 'global',
      files_scanned: 1,
      files_changed: 1,
      index_mutated: true,
      saved: false,
      failure_count: 1,
      failures: [
        expect.objectContaining({
          phase: 'save',
          message: expect.stringContaining('cannot write index'),
        }),
      ],
    });
    const persistedSummary = JSON.parse(
      await fsp.readFile(lastIndexUpdatePathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    );
    expect(persistedSummary).toMatchObject({
      schema_version: 'kb.last-index-update.v1',
      summary: {
        status: 'failed',
        scope: 'global',
        model_id: DEFAULT_MODEL_ID,
        files_scanned: 1,
        files_changed: 1,
        saved: false,
        failure_count: 1,
      },
    });
    // RFC 014 — first save under v014 writes to index.v0/ via atomicSave.
    expect(saveMock).toHaveBeenCalledWith(versionedIndexPathIn(process.env.FAISS_INDEX_PATH!));

    await new Promise((resolve) => setImmediate(resolve));
    const logContents = await fsp.readFile(logFile, 'utf-8');
    expect(logContents).toContain('Permission denied while attempting to save FAISS index for model');
  });

  it('upgrades a scoped force-reindex to a global rebuild so deletions are honored without duplicates (#51 P1)', async () => {
    // Setup: two KBs (alpha, beta), each with one file. Initial updateIndex
    // builds the global FAISS index; both files land in the store.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-scoped-force-'));
    const kbDir = path.join(tempDir, 'kb');
    const alphaDir = path.join(kbDir, 'alpha');
    const betaDir = path.join(kbDir, 'beta');
    await fsp.mkdir(alphaDir, { recursive: true });
    await fsp.mkdir(betaDir, { recursive: true });
    await fsp.writeFile(path.join(alphaDir, 'a.md'), '# alpha doc\n\nAlpha content.');
    await fsp.writeFile(path.join(betaDir, 'b.md'), '# beta doc\n\nBeta content.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const loggerModule = await import('./logger.js');
    const loggerInfoSpy = jest.spyOn(loggerModule.logger, 'info');
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    // Initial build: one fromTexts() seeds the store with alpha's file,
    // beta's file goes through addDocuments(). Total ingested = 2 files.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    const initialAdds = addDocumentsMock.mock.calls.length;
    fromTextsMock.mockClear();
    addDocumentsMock.mockClear();
    loggerInfoSpy.mockClear();

    // Action: caller scopes a forced reindex to "alpha". The bug we are
    // fixing: this would keep the existing store and only re-embed alpha,
    // appending duplicates while leaving any orphaned vectors alive. The
    // fix nulls the in-memory store and walks ALL KBs.
    try {
      await manager.updateIndex('alpha', { force: true });

      // After fix: the in-memory store was nulled, so the rebuild starts
      // with fromTexts() again, and BOTH KBs' files are re-ingested.
      expect(fromTextsMock).toHaveBeenCalledTimes(1);
      // Both alpha (1 file) and beta (1 file) re-embedded. With the default
      // batch size they fit in the fromTexts seed batch, so addDocuments has
      // the same call count as the initial build.
      const rebuildAdds = addDocumentsMock.mock.calls.length;
      expect(rebuildAdds).toBe(initialAdds);
      expect(manager.getLastIndexUpdateSummary()).toMatchObject({
        status: 'success',
        scope: 'global',
        files_scanned: 2,
        files_changed: 2,
      });
      const forceLogMessages = loggerInfoSpy.mock.calls.map((call) => String(call[0]));
      expect(forceLogMessages).toContainEqual(
        expect.stringContaining('Force rebuild: re-embedding all chunks from'),
      );
      expect(forceLogMessages).toContainEqual(
        expect.stringContaining('existing index will be replaced'),
      );
      expect(forceLogMessages).not.toContainEqual(
        expect.stringContaining('FAISS index is empty'),
      );
    } finally {
      loggerInfoSpy.mockRestore();
    }

    // The KB hash sidecars must reflect the rebuild — both files have
    // up-to-date sidecars now.
    const alphaSidecar = path.join(alphaDir, '.index', 'a.md');
    const betaSidecar = path.join(betaDir, '.index', 'b.md');
    await expect(fsp.readFile(alphaSidecar, 'utf-8')).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(fsp.readFile(betaSidecar, 'utf-8')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('saves the FAISS index exactly once per updateIndex call when multiple files change', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-save-once-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const fileCount = 3;
    const docPaths: string[] = [];
    for (let i = 0; i < fileCount; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      await fsp.writeFile(docPath, `# Doc ${i}\n\nContents for document number ${i}.`);
      docPaths.push(docPath);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    expect(saveMock).toHaveBeenCalledTimes(1);
    // RFC 014 — first save under v014 writes to index.v0/ via atomicSave.
    expect(saveMock).toHaveBeenCalledWith(versionedIndexPathIn(process.env.FAISS_INDEX_PATH!));
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).not.toHaveBeenCalled();

    for (const docPath of docPaths) {
      const relativePath = path.relative(defaultKb, docPath);
      const sidecarPath = path.join(defaultKb, '.index', path.dirname(relativePath), path.basename(docPath));
      const sidecarContent = await fsp.readFile(sidecarPath, 'utf-8');
      expect(sidecarContent).toMatch(/^[0-9a-f]{64}$/);
      await expect(fsp.stat(`${sidecarPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(fsp.stat(pendingManifestPathIn(process.env.FAISS_INDEX_PATH!)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists an embedding canary fingerprint in the index integrity manifest', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-canary-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Doc\n\nCanary content.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const {
      EMBEDDING_CANARY_ID,
      EMBEDDING_CANARY_TEXT_SHA256,
    } = await import('./faiss-store-layout.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const manifest = JSON.parse(
      await fsp.readFile(
        path.join(versionedIndexPathIn(process.env.FAISS_INDEX_PATH!), 'integrity.json'),
        'utf-8',
      ),
    ) as {
      embedding_canary?: {
        canary_id: string;
        text_sha256: string;
        embedding_role: string;
        dimensions: number;
        vector: number[];
      };
    };
    expect(manifest.embedding_canary).toMatchObject({
      canary_id: EMBEDDING_CANARY_ID,
      text_sha256: EMBEDDING_CANARY_TEXT_SHA256,
      embedding_role: 'document',
      dimensions: 2,
    });
    expect(manifest.embedding_canary?.vector).toHaveLength(2);
  });

  it('builds, persists, reloads, and queries an HNSW index when explicitly configured', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-hnsw-manager-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Alpha\n\nAlpha HNSW content.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_INDEX_TYPE = 'hnsw';
    process.env.KB_HNSW_M = '8';
    process.env.KB_HNSW_EF_CONSTRUCTION = '40';
    process.env.KB_HNSW_EF_SEARCH = '20';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const versionDir = versionedIndexPathIn(process.env.FAISS_INDEX_PATH!);
    await expect(fsp.stat(path.join(versionDir, 'hnsw.index'))).resolves.toBeTruthy();
    await expect(fsp.stat(path.join(versionDir, 'faiss.index'))).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(
      await fsp.readFile(path.join(versionDir, 'integrity.json'), 'utf-8'),
    );
    expect(manifest).toMatchObject({
      backend: 'hnsw',
      index_type: 'hnsw',
      hnsw: {
        m: 8,
        efConstruction: 40,
        efSearch: 20,
        metric: 'l2',
      },
    });

    const reloaded = new FaissIndexManager();
    await reloaded.initialize({ readOnly: true });
    const results = await reloaded.similaritySearch('Alpha HNSW content', 1, Number.POSITIVE_INFINITY);
    expect(results[0]?.pageContent).toContain('Alpha HNSW content');
    expect(reloaded.getStats()).toMatchObject({
      totalChunks: 1,
      indexType: 'hnsw',
    });
  });

  it('recovers a save-complete pending manifest by finishing hash and chunk sidecars', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-complete-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    const sourceHash = sha256Hex('# Title\n\nRecovered content.');
    await fsp.writeFile(docPath, '# Title\n\nRecovered content.');

    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    const chunkManifestPath = `${sidecarPath}.chunks.json`;
    const chunkManifest = {
      schema_version: 'kb.chunk-manifest.v1',
      source_sha256: sourceHash,
      chunks: [{
        chunkIndex: 0,
        textHash: sha256Hex('Recovered content.'),
        metadataHash: sha256Hex('metadata'),
        vectorDocstoreId: sha256Hex('docstore-id'),
      }],
    };
    await seedVersionedIndex(faissDir);
    await fsp.writeFile(
      pendingManifestPathIn(faissDir),
      JSON.stringify({
        schema_version: 'kb.pending-sidecar-commit.v1',
        phase: 'save-complete',
        pending_hash_writes: [{ path: sidecarPath, hash: sourceHash }],
        pending_chunk_manifest_writes: [{
          path: chunkManifestPath,
          manifest: chunkManifest,
        }],
      }),
      'utf-8',
    );

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await expect(fsp.readFile(sidecarPath, 'utf-8')).resolves.toBe(sourceHash);
    await expect(fsp.readFile(chunkManifestPath, 'utf-8'))
      .resolves.toBe(JSON.stringify(chunkManifest));
    await expect(fsp.stat(pendingManifestPathIn(faissDir)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(loadMock).toHaveBeenCalledWith(versionedIndexPathIn(faissDir), expect.anything());
  });

  it('refuses a save-complete pending manifest when the active FAISS index is missing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-missing-index-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(modelDirIn(faissDir), { recursive: true });

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    await fsp.writeFile(
      pendingManifestPathIn(faissDir),
      JSON.stringify({
        schema_version: 'kb.pending-sidecar-commit.v1',
        phase: 'save-complete',
        pending_hash_writes: [{ path: sidecarPath, hash: 'a'.repeat(64) }],
        pending_chunk_manifest_writes: [],
      }),
      'utf-8',
    );

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await expect(manager.initialize()).rejects.toThrow(/marked save-complete/);
    await expect(fsp.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a save-complete pending manifest when sidecar writes fail after FAISS save', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-sidecar-fail-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    const docContent = '# Title\n\nSidecar failure content.';
    const sourceHash = sha256Hex(docContent);
    await fsp.writeFile(docPath, docContent);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsp.chmod(path.dirname(sidecarPath), 0o500);

    await expect(manager.updateIndex()).rejects.toThrow(/write file hash metadata/);
    expect(saveMock).toHaveBeenCalledTimes(1);

    const manifest = JSON.parse(
      await fsp.readFile(pendingManifestPathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    ) as {
      schema_version: string;
      owner: { pid: number; hostname: string; started_at: string };
      phase: string;
      pending_hash_writes: Array<{ path: string; hash: string }>;
      pending_chunk_manifest_writes: Array<{ path: string; manifest: { source_sha256: string } }>;
    };
    expect(manifest.schema_version).toBe('kb.pending-sidecar-commit.v2');
    expect(manifest.owner).toMatchObject({
      pid: process.pid,
      hostname: os.hostname(),
      started_at: expect.any(String),
    });
    expect(manifest.phase).toBe('save-complete');
    expect(manifest.pending_hash_writes).toEqual([{ path: sidecarPath, hash: sourceHash }]);
    expect(manifest.pending_chunk_manifest_writes).toEqual([
      expect.objectContaining({
        path: `${sidecarPath}.chunks.json`,
        manifest: expect.objectContaining({ source_sha256: sourceHash }),
      }),
    ]);
  });

  it('purges the persisted store and sidecars for an ambiguous save-started pending manifest', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-started-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(path.join(defaultKb, '.index'), { recursive: true });
    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    await fsp.writeFile(sidecarPath, 'b'.repeat(64));

    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    await seedVersionedIndex(faissDir);
    await fsp.writeFile(
      pendingManifestPathIn(faissDir),
      JSON.stringify({
        schema_version: 'kb.pending-sidecar-commit.v1',
        phase: 'save-started',
        pending_hash_writes: [{ path: sidecarPath, hash: 'c'.repeat(64) }],
        pending_chunk_manifest_writes: [],
      }),
      'utf-8',
    );

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await expect(fsp.stat(path.join(modelDirIn(faissDir), 'index')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(versionedIndexPathIn(faissDir)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(defaultKb, '.index')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(pendingManifestPathIn(faissDir)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a save-started manifest intact while its same-host owner is alive', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-live-owner-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(path.join(defaultKb, '.index'), { recursive: true });
    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    await fsp.writeFile(sidecarPath, 'b'.repeat(64));

    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    await seedVersionedIndex(faissDir);
    await fsp.writeFile(
      pendingManifestPathIn(faissDir),
      JSON.stringify({
        schema_version: 'kb.pending-sidecar-commit.v2',
        owner: {
          pid: process.pid,
          hostname: os.hostname(),
          started_at: new Date().toISOString(),
        },
        phase: 'save-started',
        pending_hash_writes: [{ path: sidecarPath, hash: 'c'.repeat(64) }],
        pending_chunk_manifest_writes: [],
      }),
      'utf-8',
    );

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await expect(fsp.stat(path.join(modelDirIn(faissDir), 'index'))).resolves.toBeTruthy();
    await expect(fsp.stat(versionedIndexPathIn(faissDir))).resolves.toBeTruthy();
    await expect(fsp.readFile(sidecarPath, 'utf-8')).resolves.toBe('b'.repeat(64));
    await expect(fsp.stat(pendingManifestPathIn(faissDir))).resolves.toBeTruthy();
    expect(loadMock).toHaveBeenCalledWith(versionedIndexPathIn(faissDir), expect.anything());
  });

  it('purges a save-started manifest owned by a foreign host', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-foreign-owner-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(path.join(defaultKb, '.index'), { recursive: true });
    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    await fsp.writeFile(sidecarPath, 'b'.repeat(64));

    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    await seedVersionedIndex(faissDir);
    await fsp.writeFile(
      pendingManifestPathIn(faissDir),
      JSON.stringify({
        schema_version: 'kb.pending-sidecar-commit.v2',
        owner: {
          pid: process.pid,
          hostname: `${os.hostname()}-foreign`,
          started_at: new Date().toISOString(),
        },
        phase: 'save-started',
        pending_hash_writes: [{ path: sidecarPath, hash: 'c'.repeat(64) }],
        pending_chunk_manifest_writes: [],
      }),
      'utf-8',
    );

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await expect(fsp.stat(path.join(modelDirIn(faissDir), 'index')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(versionedIndexPathIn(faissDir)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(defaultKb, '.index')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(pendingManifestPathIn(faissDir)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a slow writer before initializing another manager (#851)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pending-slow-save-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(docPath, '# Title\n\nInitial content.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { withWriteLock } = await import('./write-lock.js');
    const writer = new FaissIndexManager();
    await writer.initialize();
    await withWriteLock(writer.modelDir, () => writer.updateIndex());

    await fsp.writeFile(docPath, '# Title\n\nUpdated content while saving.');
    let resolveSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      resolveSaveStarted = resolve;
    });
    let releaseSave!: () => void;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    saveMock.mockImplementation(async () => {
      resolveSaveStarted();
      await saveReleased;
    });

    const writerUpdate = withWriteLock(writer.modelDir, () => writer.updateIndex());
    await saveStarted;

    const pendingManifest = JSON.parse(
      await fsp.readFile(pendingManifestPathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    ) as { phase: string; owner: { pid: number; hostname: string } };
    expect(pendingManifest).toMatchObject({
      phase: 'save-started',
      owner: { pid: process.pid, hostname: os.hostname() },
    });

    const reader = new FaissIndexManager();
    let writerReleased = false;
    let loadedBeforeWriterRelease = false;
    loadMock.mockImplementation(() => {
      loadedBeforeWriterRelease ||= !writerReleased;
    });
    const readerInitialization = reader.initialize();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(loadedBeforeWriterRelease).toBe(false);

    writerReleased = true;
    releaseSave();
    await writerUpdate;
    await readerInitialization;

    await expect(fsp.readFile(path.join(defaultKb, '.index', 'doc.md'), 'utf-8'))
      .resolves.toBe(sha256Hex('# Title\n\nUpdated content while saving.'));
    await expect(fsp.stat(pendingManifestPathIn(process.env.FAISS_INDEX_PATH!)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('batches changed-file embeddings according to INDEXING_BATCH_SIZE', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-batch-embeddings-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const fileCount = 5;
    const docPaths: string[] = [];
    for (let i = 0; i < fileCount; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      await fsp.writeFile(docPath, `# Doc ${i}\n\nBatching content for document ${i}.`);
      docPaths.push(docPath);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INDEXING_BATCH_SIZE = '2';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    const progressEvents: Array<{
      phase?: string;
      batchIndex?: number;
      batchCount?: number;
      batchSize?: number;
      processedChunks?: number;
      totalChunks?: number;
      provider?: string;
      modelName?: string;
      throughputChunksPerSecond?: number;
    }> = [];
    await manager.updateIndex(undefined, {
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).toHaveBeenCalledTimes(2);
    const embedEvents = progressEvents.filter((event) => event.phase === 'embed');
    expect(embedEvents).toEqual([
      expect.objectContaining({
        batchIndex: 1,
        batchCount: 3,
        batchSize: 2,
        processedChunks: 2,
        totalChunks: 5,
        provider: 'huggingface',
        modelName: 'BAAI/bge-small-en-v1.5',
      }),
      expect.objectContaining({
        batchIndex: 2,
        batchCount: 3,
        batchSize: 2,
        processedChunks: 4,
        totalChunks: 5,
      }),
      expect.objectContaining({
        batchIndex: 3,
        batchCount: 3,
        batchSize: 1,
        processedChunks: 5,
        totalChunks: 5,
      }),
    ]);
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      chunks_added: 5,
      index_mutated: true,
      saved: true,
      sidecars_written: true,
    });

    const [seedTexts, seedMetadatas] = fromTextsMock.mock.calls[0] as [
      string[],
      Array<{ source: string }>,
    ];
    expect(seedTexts).toHaveLength(2);
    expect(seedMetadatas.map((metadata) => metadata.source)).toEqual(docPaths.slice(0, 2));

    const appendedSources = addDocumentsMock.mock.calls.map((call) => {
      const [docs] = call as [Array<{ metadata: { source: string } }>];
      return docs.map((doc) => doc.metadata.source);
    });
    expect(appendedSources).toEqual([
      docPaths.slice(2, 4),
      docPaths.slice(4, 5),
    ]);

    for (const docPath of docPaths) {
      const sidecarPath = path.join(defaultKb, '.index', path.basename(docPath));
      await expect(fsp.readFile(sidecarPath, 'utf-8')).resolves.toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('pipelines embedding batches while inserting and reporting progress in order', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-pipelined-embeddings-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPaths: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      await fsp.writeFile(docPath, `# Doc ${i}\n\nPipelined content for document ${i}.`);
      docPaths.push(docPath);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INDEXING_BATCH_SIZE = '1';
    process.env.KB_INDEXING_CONCURRENCY = '2';

    let activeEmbeddings = 0;
    let maxActiveEmbeddings = 0;
    const completedProviderTexts: string[] = [];
    embedDocumentsMock.mockImplementation(async (texts: string[]) => {
      activeEmbeddings += 1;
      maxActiveEmbeddings = Math.max(maxActiveEmbeddings, activeEmbeddings);
      const firstText = texts[0] ?? '';
      if (firstText.includes('Doc 0')) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      completedProviderTexts.push(firstText);
      activeEmbeddings -= 1;
      return texts.map(mockVectorForText);
    });

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { EMBEDDING_CANARY_TEXT } = await import('./faiss-store-layout.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    const progressEvents: Array<{
      phase?: string;
      batchIndex?: number;
      processedChunks?: number;
    }> = [];

    await manager.updateIndex(undefined, {
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(maxActiveEmbeddings).toBe(2);
    expect(completedProviderTexts.filter((text) => text !== EMBEDDING_CANARY_TEXT)[0])
      .toContain('Doc 1');

    const [seedTexts, seedMetadatas] = fromTextsMock.mock.calls[0] as [
      string[],
      Array<{ source: string }>,
    ];
    expect(seedTexts).toHaveLength(1);
    expect(seedMetadatas.map((metadata) => metadata.source)).toEqual(docPaths.slice(0, 1));

    const appendedSources = addDocumentsMock.mock.calls.map((call) => {
      const [docs] = call as [Array<{ metadata: { source: string } }>];
      return docs.map((doc) => doc.metadata.source);
    });
    expect(appendedSources).toEqual([
      docPaths.slice(1, 2),
      docPaths.slice(2, 3),
    ]);

    const embedEvents = progressEvents.filter((event) => event.phase === 'embed');
    expect(embedEvents.map((event) => ({
      batchIndex: event.batchIndex,
      processedChunks: event.processedChunks,
    }))).toEqual([
      { batchIndex: 1, processedChunks: 1 },
      { batchIndex: 2, processedChunks: 2 },
      { batchIndex: 3, processedChunks: 3 },
    ]);
  });

  it('parallelizes extraction with filesystem concurrency while preserving index order', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-parallel-extraction-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPaths: string[] = [];
    const contentsByPath = new Map<string, string>();
    for (let i = 0; i < 4; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      const content = `# Doc ${i}\n\nExtraction content for document ${i}.`;
      await fsp.writeFile(docPath, content);
      docPaths.push(docPath);
      contentsByPath.set(docPath, content);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_FS_CONCURRENCY = '2';

    let activeLoads = 0;
    let maxActiveLoads = 0;
    const mockLoadFile = jest.fn(async (filePath: string): Promise<string> => {
      activeLoads += 1;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        const content = contentsByPath.get(filePath);
        if (content === undefined) {
          throw new Error(`unexpected load path ${filePath}`);
        }
        return content;
      } finally {
        activeLoads -= 1;
      }
    });

    try {
      jest.resetModules();
      jest.doMock('./loaders.js', () => ({
        ...jest.requireActual<typeof import('./loaders.js')>('./loaders.js'),
        __esModule: true,
        loadFile: mockLoadFile,
      }));
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const manager = new FaissIndexManager();
      await manager.initialize();

      await manager.updateIndex();

      expect(maxActiveLoads).toBe(2);
      expect(mockLoadFile).toHaveBeenCalledTimes(4);
      const [, seedDocuments] = addVectorsMock.mock.calls[0] as [
        number[][],
        Array<{ metadata?: { source?: string } }>,
      ];
      expect(seedDocuments.map((document) => document.metadata?.source)).toEqual(docPaths);
    } finally {
      jest.dontMock('./loaders.js');
    }
  });

  it('keeps ollama embedding batches serial unless OLLAMA_NUM_PARALLEL opts in', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-ollama-serial-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      await fsp.writeFile(docPath, `# Doc ${i}\n\nOllama serial content for document ${i}.`);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'nomic-embed-text';
    process.env.INDEXING_BATCH_SIZE = '1';
    process.env.KB_INDEXING_CONCURRENCY = '3';
    delete process.env.OLLAMA_NUM_PARALLEL;

    let activeEmbeddings = 0;
    let maxActiveEmbeddings = 0;
    embedDocumentsMock.mockImplementation(async (texts: string[]) => {
      activeEmbeddings += 1;
      maxActiveEmbeddings = Math.max(maxActiveEmbeddings, activeEmbeddings);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeEmbeddings -= 1;
      return texts.map(mockVectorForText);
    });

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    expect(maxActiveEmbeddings).toBe(1);
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).toHaveBeenCalledTimes(2);
  });

  it('embeds duplicate normalized chunk text once per indexing operation while preserving every source', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-dedupe-embeddings-'));
    const kbDir = path.join(tempDir, 'kb');
    const alphaKb = path.join(kbDir, 'alpha');
    const betaKb = path.join(kbDir, 'beta');
    await fsp.mkdir(alphaKb, { recursive: true });
    await fsp.mkdir(betaKb, { recursive: true });

    const alphaDuplicate = path.join(alphaKb, 'shared-a.md');
    const alphaUnique = path.join(alphaKb, 'unique.md');
    const betaDuplicate = path.join(betaKb, 'shared-b.md');
    await fsp.writeFile(alphaDuplicate, '# Shared\n\nRepeated boilerplate chunk.');
    await fsp.writeFile(alphaUnique, '# Unique\n\nOnly this source has this chunk.');
    await fsp.writeFile(betaDuplicate, '# Shared\n\nRepeated boilerplate chunk.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INDEXING_BATCH_SIZE = '2';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { normalizeChunkTextForEmbedding } = await import('./file-ingest.js');
    const { EMBEDDING_CANARY_TEXT } = await import('./faiss-store-layout.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    embedDocumentsMock.mockClear();

    await manager.updateIndex();

    const [seedTexts, seedMetadatas] = fromTextsMock.mock.calls[0] as [
      string[],
      Array<{ source: string }>,
    ];
    const appendedDocs = addDocumentsMock.mock.calls.flatMap((call) => {
      const [docs] = call as [Array<{ pageContent: string; metadata: { source: string } }>];
      return docs;
    });
    const indexedTexts = [
      ...seedTexts,
      ...appendedDocs.map((doc) => doc.pageContent),
    ];
    const indexedSources = [
      ...seedMetadatas.map((metadata) => metadata.source),
      ...appendedDocs.map((doc) => doc.metadata.source),
    ];

    expect(indexedSources.sort()).toEqual([
      alphaDuplicate,
      alphaUnique,
      betaDuplicate,
    ].sort());
    expect(indexedTexts).toHaveLength(3);

    const providerTexts = embedDocumentsMock.mock.calls.flatMap((call) => {
      const [texts] = call as [string[]];
      return texts;
    }).filter((text) => text !== EMBEDDING_CANARY_TEXT);
    expect(providerTexts).toEqual([...new Set(indexedTexts.map(normalizeChunkTextForEmbedding))]);
    expect(providerTexts).toHaveLength(2);
    expect(providerTexts).toContain(normalizeChunkTextForEmbedding(seedTexts[0]));
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      chunks_added: 3,
      index_mutated: true,
      saved: true,
    });
  });

  it('persists chunk manifests and embeds only appended chunks when a changed file keeps its stable prefix', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-chunk-manifest-append-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'large.txt');
    const paragraph = (label: string) => `${label} ${'stable words '.repeat(12)}`;
    await fsp.writeFile(
      docPath,
      [paragraph('alpha'), paragraph('beta'), paragraph('gamma')].join('\n\n'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_CHUNK_SIZE = '80';
    process.env.KB_CHUNK_OVERLAP = '0';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { EMBEDDING_CANARY_TEXT } = await import('./faiss-store-layout.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const manifestPath = path.join(defaultKb, '.index', 'large.txt.chunks.json');
    const initialManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as {
      chunks: unknown[];
    };
    expect(initialManifest.chunks.length).toBeGreaterThan(1);
    const [initialTexts] = fromTextsMock.mock.calls[0] as [string[]];
    expect(initialTexts).toHaveLength(initialManifest.chunks.length);

    fromTextsMock.mockClear();
    addDocumentsMock.mockClear();
    embedDocumentsMock.mockClear();
    saveMock.mockClear();

    await fsp.writeFile(
      docPath,
      [
        paragraph('alpha'),
        paragraph('beta'),
        paragraph('gamma'),
        paragraph('delta appended'),
      ].join('\n\n'),
    );
    await manager.updateIndex('default');

    const updatedManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as {
      source_sha256: string;
      chunks: unknown[];
    };
    const appendedChunkCount = updatedManifest.chunks.length - initialManifest.chunks.length;
    expect(appendedChunkCount).toBeGreaterThan(0);
    expect(appendedChunkCount).toBeLessThan(updatedManifest.chunks.length);
    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(addDocumentsMock).toHaveBeenCalledTimes(1);
    const [[appendedDocs]] = addDocumentsMock.mock.calls as [[Array<{ pageContent: string }>]];
    expect(appendedDocs).toHaveLength(appendedChunkCount);
    const providerTexts = embedDocumentsMock.mock.calls.flatMap((call) => {
      const [texts] = call as [string[]];
      return texts;
    }).filter((text) => text !== EMBEDDING_CANARY_TEXT);
    expect(providerTexts).toHaveLength(appendedChunkCount);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'success',
      scope: 'default',
      files_changed: 1,
      chunks_added: appendedChunkCount,
      index_mutated: true,
      saved: true,
      sidecars_written: true,
    });
    await expect(fsp.readFile(path.join(defaultKb, '.index', 'large.txt'), 'utf-8'))
      .resolves.toBe(updatedManifest.source_sha256);
  });

  it('falls back to a full rebuild when a changed file removes chunks so stale content is compacted away', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-chunk-manifest-rebuild-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'large.txt');
    const paragraph = (label: string) => `${label} ${'content words '.repeat(12)}`;
    await fsp.writeFile(
      docPath,
      [
        paragraph('keep alpha'),
        paragraph('remove obsolete sentinel'),
        paragraph('keep omega'),
      ].join('\n\n'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_CHUNK_SIZE = '80';
    process.env.KB_CHUNK_OVERLAP = '0';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    fromTextsMock.mockClear();
    addDocumentsMock.mockClear();
    saveMock.mockClear();
    embedDocumentsMock.mockClear();

    await fsp.writeFile(
      docPath,
      [paragraph('keep alpha'), paragraph('keep omega')].join('\n\n'),
    );
    await manager.updateIndex('default');

    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).not.toHaveBeenCalled();
    const [rebuiltTexts] = fromTextsMock.mock.calls[0] as [string[]];
    expect(rebuiltTexts.join('\n')).not.toContain('obsolete sentinel');
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'success',
      scope: 'default',
      files_changed: 1,
      index_mutated: true,
      saved: true,
      sidecars_written: true,
    });
  });

  it('propagates an indexing error when the provider returns the wrong vector count', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-dedupe-vector-count-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Doc\n\nContent that needs one embedding.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    embedDocumentsMock.mockResolvedValueOnce([]);

    await expect(manager.updateIndex()).rejects.toThrow(
      'Embedding provider returned 0 vector(s) for 1 document(s)',
    );
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'failed',
      files_changed: 1,
      failure_count: 1,
      failures: [
        expect.objectContaining({
          phase: 'indexing',
          message: 'Embedding provider returned 0 vector(s) for 1 document(s)',
        }),
      ],
    });
  });

  it('resolves default batch size from an explicit manager provider', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-batch-provider-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const fileCount = 20;
    const docPaths: string[] = [];
    for (let i = 0; i < fileCount; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      await fsp.writeFile(docPath, `# Doc ${i}\n\nOllama batch default content ${i}.`);
      docPaths.push(docPath);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INDEXING_BATCH_SIZE;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager({
      provider: 'ollama',
      modelName: 'mxbai-embed-large',
    });
    await manager.initialize();
    await manager.updateIndex();

    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).toHaveBeenCalledTimes(1);
    const indexedDocPaths = [...docPaths].sort();
    const [seedTexts, seedMetadatas] = fromTextsMock.mock.calls[0] as [
      string[],
      Array<{ source: string }>,
    ];
    expect(seedTexts).toHaveLength(16);
    expect(seedMetadatas.map((metadata) => metadata.source)).toEqual(indexedDocPaths.slice(0, 16));

    const [[appendedDocs]] = addDocumentsMock.mock.calls as [[Array<{ metadata: { source: string } }>]];
    expect(appendedDocs.map((doc) => doc.metadata.source)).toEqual(indexedDocPaths.slice(16));
  });

  it('records latest update summaries for changed and unchanged runs', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-update-summary-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(docPath, '# Title\n\nSome content for embeddings.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'never_run',
      model_id: DEFAULT_MODEL_ID,
    });

    await manager.initialize();
    await manager.updateIndex('default');

    const changedSummary = manager.getLastIndexUpdateSummary();
    expect(changedSummary).toMatchObject({
      status: 'success',
      scope: 'default',
      model_id: DEFAULT_MODEL_ID,
      files_scanned: 1,
      files_changed: 1,
      files_unchanged: 0,
      files_skipped: 0,
      chunks_added: 1,
      index_mutated: true,
      saved: true,
      sidecars_written: true,
      failure_count: 0,
    });
    expect(changedSummary.started_at).toEqual(expect.any(String));
    expect(changedSummary.finished_at).toEqual(expect.any(String));
    expect(changedSummary.duration_ms).toEqual(expect.any(Number));
    const persistedChangedSummary = JSON.parse(
      await fsp.readFile(lastIndexUpdatePathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    );
    expect(persistedChangedSummary).toMatchObject({
      schema_version: 'kb.last-index-update.v1',
      summary: {
        status: 'success',
        scope: 'default',
        model_id: DEFAULT_MODEL_ID,
        files_scanned: 1,
        files_changed: 1,
        chunks_added: 1,
        saved: true,
        sidecars_written: true,
      },
    });

    saveMock.mockClear();
    fromTextsMock.mockClear();
    addDocumentsMock.mockClear();

    await manager.updateIndex('default');
    expect(saveMock).not.toHaveBeenCalled();
    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(addDocumentsMock).not.toHaveBeenCalled();
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'success',
      scope: 'default',
      files_scanned: 1,
      files_changed: 0,
      files_unchanged: 1,
      files_skipped: 0,
      chunks_added: 0,
      index_mutated: false,
      saved: false,
      sidecars_written: false,
      failure_count: 0,
    });
    const persistedUnchangedSummary = JSON.parse(
      await fsp.readFile(lastIndexUpdatePathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    );
    expect(persistedUnchangedSummary.summary).toMatchObject({
      status: 'success',
      scope: 'default',
      files_changed: 0,
      files_unchanged: 1,
      saved: false,
    });
  });

  it('records enumeration failures in update summaries without writing a freshness manifest', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-enum-summary-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    const blockedDir = path.join(defaultKb, 'blocked');
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(docPath, '# Title\n\nSome content for embeddings.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const actualKbFs = jest.requireActual<typeof import('./kb-fs.js')>('./kb-fs.js');
    jest.doMock('./kb-fs.js', () => ({
      ...actualKbFs,
      enumerateIngestableKbFiles: jest.fn(async () => [{
        kbName: 'default',
        kbPath: defaultKb,
        filePaths: [docPath],
        diagnostics: {
          failure_count: 1,
          failures: [{
            path: blockedDir,
            code: 'EACCES',
            message: `EACCES: permission denied, scandir '${blockedDir}'`,
          }],
        },
      }]),
    }));

    try {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const { freshnessManifestPath } = await import('./freshness-manifest.js');
      const manager = new FaissIndexManager();
      await manager.initialize();
      await manager.updateIndex('default');

      expect(manager.getLastIndexUpdateSummary()).toMatchObject({
        status: 'partial',
        scope: 'default',
        files_scanned: 1,
        files_changed: 1,
        saved: true,
        failure_count: 1,
        failures: [expect.objectContaining({
          relative_path: path.join('default', 'blocked'),
          phase: 'enumeration',
          code: 'EACCES',
          message: expect.stringContaining(path.join('default', 'blocked')),
        })],
      });
      const persistedPartialSummary = JSON.parse(
        await fsp.readFile(lastIndexUpdatePathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
      );
      expect(persistedPartialSummary.summary).toMatchObject({
        status: 'partial',
        scope: 'default',
        failure_count: 1,
        failures: [expect.objectContaining({
          relative_path: path.join('default', 'blocked'),
          phase: 'enumeration',
          code: 'EACCES',
        })],
      });
      await expect(
        fsp.stat(freshnessManifestPath(modelDirIn(process.env.FAISS_INDEX_PATH!))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      jest.dontMock('./kb-fs.js');
      jest.resetModules();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defers files inside the refresh quiescence window and indexes them on a later pass', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-quiesce-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'draft.md');
    await fsp.writeFile(docPath, '# Draft\n\nProducer is still settling.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_REFRESH_QUIESCE_MS = '60000';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await manager.updateIndex('default');
    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'success',
      scope: 'default',
      files_scanned: 1,
      files_changed: 0,
      files_skipped: 1,
      warning_count: 1,
      warnings: [
        expect.objectContaining({
          relative_path: 'draft.md',
          code: 'KB_REFRESH_NOT_QUIESCENT',
          quiesce_ms: 60000,
        }),
      ],
      failure_count: 0,
    });
    const persistedDeferredSummary = JSON.parse(
      await fsp.readFile(lastIndexUpdatePathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    );
    expect(persistedDeferredSummary.summary).toMatchObject({
      files_skipped: 1,
      warning_count: 1,
      warnings: [
        expect.objectContaining({
          relative_path: 'draft.md',
          code: 'KB_REFRESH_NOT_QUIESCENT',
        }),
      ],
    });

    fromTextsMock.mockClear();
    const oldTimestamp = new Date(Date.now() - 120_000);
    await fsp.utimes(docPath, oldTimestamp, oldTimestamp);

    await manager.updateIndex('default');
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'success',
      files_scanned: 1,
      files_changed: 1,
      files_skipped: 0,
      warning_count: 0,
      warnings: [],
      failure_count: 0,
    });
  });

  it('defers files that change during the refresh scan and indexes them on a later pass', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-quiesce-race-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'draft.md');
    await fsp.writeFile(docPath, '# Draft\n\nInitial content.');
    const oldTimestamp = new Date(Date.now() - 120_000);
    await fsp.utimes(docPath, oldTimestamp, oldTimestamp);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_REFRESH_QUIESCE_MS = '60000';

    jest.resetModules();
    const actualFileUtils = jest.requireActual<typeof import('./file-utils.js')>('./file-utils.js');
    let mutatedDuringHash = false;
    jest.doMock('./file-utils.js', () => ({
      ...actualFileUtils,
      calculateSHA256: jest.fn(async (filePath: string) => {
        const hash = await actualFileUtils.calculateSHA256(filePath);
        if (filePath === docPath && !mutatedDuringHash) {
          mutatedDuringHash = true;
          await fsp.writeFile(docPath, '# Draft\n\nChanged while refresh was scanning.');
        }
        return hash;
      }),
    }));

    try {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const manager = new FaissIndexManager();
      await manager.initialize();

      await manager.updateIndex('default');
      expect(fromTextsMock).not.toHaveBeenCalled();
      expect(manager.getLastIndexUpdateSummary()).toMatchObject({
        status: 'success',
        scope: 'default',
        files_scanned: 1,
        files_changed: 0,
        files_skipped: 1,
        warning_count: 1,
        warnings: [
          expect.objectContaining({
            relative_path: 'draft.md',
            code: 'KB_REFRESH_FILE_CHANGED_DURING_SCAN',
            quiesce_ms: 60000,
          }),
        ],
        failure_count: 0,
      });

      fromTextsMock.mockClear();
      mutatedDuringHash = true;
      await fsp.utimes(docPath, oldTimestamp, oldTimestamp);

      await manager.updateIndex('default');
      expect(fromTextsMock).toHaveBeenCalledTimes(1);
      expect(manager.getLastIndexUpdateSummary()).toMatchObject({
        status: 'success',
        files_scanned: 1,
        files_changed: 1,
        files_skipped: 0,
        warning_count: 0,
        warnings: [],
        failure_count: 0,
      });
    } finally {
      jest.dontMock('./file-utils.js');
      jest.resetModules();
    }
  });

  it('quarantines load failures, skips them during backoff, and clears the entry after content changes and indexes', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-quarantine-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'bad.md');
    await fsp.writeFile(docPath, '# Bad\n\nThis content is too large for the configured ingest cap.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_MAX_FILE_BYTES = '4';
    process.env.KB_LARGE_FILE_POLICY = 'error';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { listIngestQuarantine } = await import('./ingest-quarantine.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await manager.updateIndex('default');
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'partial',
      files_scanned: 1,
      files_changed: 1,
      files_skipped: 1,
      failure_count: 1,
      failures: [expect.objectContaining({
        relative_path: 'bad.md',
        phase: 'load',
        code: 'KB_LARGE_FILE_TOO_LARGE',
      })],
    });
    const persistedPartialSummary = JSON.parse(
      await fsp.readFile(lastIndexUpdatePathIn(process.env.FAISS_INDEX_PATH!), 'utf-8'),
    );
    expect(persistedPartialSummary.summary).toMatchObject({
      status: 'partial',
      scope: 'default',
      files_scanned: 1,
      files_skipped: 1,
      failure_count: 1,
      failures: [expect.objectContaining({
        relative_path: 'bad.md',
        phase: 'load',
        code: 'KB_LARGE_FILE_TOO_LARGE',
      })],
    });
    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(await listIngestQuarantine(defaultKb)).toEqual([
      expect.objectContaining({
        relative_path: 'bad.md',
        retry_count: 1,
        source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);

    fromTextsMock.mockClear();
    await manager.updateIndex('default');
    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'success',
      files_scanned: 1,
      files_changed: 0,
      files_skipped: 1,
      failure_count: 0,
    });
    expect((await listIngestQuarantine(defaultKb))[0].retry_count).toBe(1);

    process.env.KB_MAX_FILE_BYTES = '1000';
    await fsp.writeFile(docPath, '# Fixed\n\nSmall enough.');
    await manager.updateIndex('default');
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    await expect(listIngestQuarantine(defaultKb)).resolves.toEqual([]);
  });

  it('quarantines secret-bearing chunks before embedding when ingest secret scan is enabled', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-secret-scan-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    const logFile = path.join(tempDir, 'canonical.jsonl');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'secret.md');
    await fsp.writeFile(docPath, '# Secret\n\npassword=abcDEF1234567890!\n', 'utf-8');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_INGEST_SECRET_SCAN = 'on';
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'both';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { listIngestQuarantine } = await import('./ingest-quarantine.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await manager.updateIndex('default');

    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(addVectorsMock).not.toHaveBeenCalled();
    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'partial',
      files_scanned: 1,
      files_changed: 1,
      files_skipped: 1,
      chunks_attempted: 0,
      failure_count: 1,
      failures: [expect.objectContaining({
        relative_path: 'secret.md',
        phase: 'indexing',
        code: 'KB_INGEST_SECRET_DETECTED',
      })],
    });
    await expect(listIngestQuarantine(defaultKb)).resolves.toEqual([
      expect.objectContaining({
        relative_path: 'secret.md',
        reason: 'secret_detected',
        error_category: 'secret_detected',
        error_code: 'KB_INGEST_SECRET_DETECTED',
        message: expect.stringContaining('key_value_secret'),
      }),
    ]);
    const canonicalEvents = (await fsp.readFile(logFile, 'utf-8'))
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { event?: string; secret_scan?: Record<string, unknown> });
    expect(canonicalEvents).toContainEqual(expect.objectContaining({
      event: 'secret_detected',
      secret_scan: expect.objectContaining({
        categories: expect.arrayContaining(['key_value_secret']),
        chunk_indexes: [0],
        locations: ['chunk'],
      }),
    }));
  });

  it('quarantines secret-bearing frontmatter before metadata reaches FAISS', async () => {
    const awsAccessKey = `AKIA${'1234567890ABCDEF'}`;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-secret-frontmatter-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(
      path.join(defaultKb, 'safe.md'),
      '# Safe\n\nRotate the deployment after the maintenance window.',
    );
    await fsp.writeFile(
      path.join(defaultKb, 'leak.md'),
      `---\napi_key: ${awsAccessKey}\n---\n# Leak\n\nBody without a token.\n`,
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_INGEST_SECRET_SCAN = 'on';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { listIngestQuarantine } = await import('./ingest-quarantine.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await manager.updateIndex('default');

    expect(manager.getLastIndexUpdateSummary()).toMatchObject({
      status: 'partial',
      files_scanned: 2,
      files_changed: 2,
      files_skipped: 1,
      failure_count: 1,
      failures: [expect.objectContaining({
        relative_path: 'leak.md',
        code: 'KB_INGEST_SECRET_DETECTED',
      })],
    });
    const storedDocuments = [
      ...fromTextsMock.mock.calls.flatMap((call) => call[1] as Array<{ pageContent?: string; metadata?: unknown }>),
      ...addVectorsMock.mock.calls.flatMap((call) => call[1] as Array<{ pageContent?: string; metadata?: unknown }>),
    ];
    expect(JSON.stringify(storedDocuments)).not.toContain(awsAccessKey);
    await expect(listIngestQuarantine(defaultKb)).resolves.toEqual([
      expect.objectContaining({
        reason: 'secret_detected',
        relative_path: 'leak.md',
        error_category: 'secret_detected',
      }),
    ]);
  });

  it('leaves secret-bearing files ingestable when the scan is disabled or bypassed', async () => {
    const awsAccessKey = `AKIA${'1234567890ABCDEF'}`;
    for (const mode of ['disabled', 'bypassed'] as const) {
      fromTextsMock.mockClear();
      addVectorsMock.mockClear();
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `kb-faiss-secret-${mode}-`));
      const kbDir = path.join(tempDir, 'kb');
      const defaultKb = path.join(kbDir, 'default');
      await fsp.mkdir(defaultKb, { recursive: true });
      await fsp.writeFile(
        path.join(defaultKb, 'leak.md'),
        `# Leak\n\nAWS_ACCESS_KEY_ID=${awsAccessKey}\n`,
      );

      process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
      process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
      process.env.EMBEDDING_PROVIDER = 'huggingface';
      process.env.HUGGINGFACE_API_KEY = 'test-key';
      if (mode === 'disabled') {
        delete process.env.KB_INGEST_SECRET_SCAN;
        delete process.env.KB_SECRET_SCAN_BYPASS_KBS;
      } else {
        process.env.KB_INGEST_SECRET_SCAN = 'on';
        process.env.KB_SECRET_SCAN_BYPASS_KBS = 'default';
      }

      jest.resetModules();
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const { listIngestQuarantine } = await import('./ingest-quarantine.js');
      const manager = new FaissIndexManager();
      await manager.initialize();

      await manager.updateIndex('default');

      expect(manager.getLastIndexUpdateSummary()).toMatchObject({
        status: 'success',
        files_scanned: 1,
        files_changed: 1,
        files_skipped: 0,
        failure_count: 0,
      });
      expect(fromTextsMock.mock.calls.flatMap((call) => call[0] as string[]).join('\n'))
        .toContain(awsAccessKey);
      await expect(listIngestQuarantine(defaultKb)).resolves.toEqual([]);
    }
  });

  it('sanitizes absolute file paths in update failure summaries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-summary-sanitize-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'secret.md');
    await fsp.writeFile(docPath, '# Secret\n\nThis file is unreadable.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    await fsp.chmod(docPath, 0o000);
    try {
      jest.resetModules();
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const manager = new FaissIndexManager();
      await manager.initialize();

      await manager.updateIndex('default');

      const summary = manager.getLastIndexUpdateSummary();
      expect(summary).toMatchObject({
        status: 'partial',
        scope: 'default',
        files_scanned: 1,
        files_changed: 0,
        files_skipped: 1,
        failure_count: 1,
        failures: [
          expect.objectContaining({
            relative_path: 'secret.md',
            phase: 'load',
            code: 'EACCES',
          }),
        ],
      });
      expect(summary.failures[0].message).not.toContain(tempDir);
      expect(summary.failures[0].message).not.toContain(docPath);
      expect(summary.failures[0].message).toContain('secret.md');
    } finally {
      await fsp.chmod(docPath, 0o600).catch(() => undefined);
    }
  });

  it('splits non-markdown text files into multiple chunks when content exceeds chunkSize', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-nonmd-chunks-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });

    // Build a .txt payload well above the 1000-char chunkSize, with natural
    // paragraph breaks so RecursiveCharacterTextSplitter's default separators
    // (\n\n, \n, " ", "") produce multiple chunks rather than one.
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(10)}`
    );
    const txtContent = paragraphs.join('\n\n');
    expect(txtContent.length).toBeGreaterThan(1000);
    const txtPath = path.join(defaultKb, 'large.txt');
    await fsp.writeFile(txtPath, txtContent);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    // Pre-fix behaviour: the whole file was wrapped in a single Document, so
    // fromTexts received a one-element array. Post-fix: RecursiveCharacterTextSplitter
    // splits by \n\n and produces multiple chunks for this payload.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    const [texts, metadatas] = fromTextsMock.mock.calls[0] as [string[], Array<{ source: string }>];
    expect(Array.isArray(texts)).toBe(true);
    expect(texts.length).toBeGreaterThan(1);
    expect(metadatas).toHaveLength(texts.length);
    for (const metadata of metadatas) {
      expect(metadata.source).toBe(txtPath);
    }
  });

  it('recovers via per-file re-embed when the FAISS index is missing but sidecars survive (#90)', async () => {
    // Issue #90 — when the FAISS store is gone but per-KB hash sidecars
    // survive (operator nuked $FAISS_INDEX_PATH, partial restore, crash
    // mid-rebuild), initialize() purges the now-untrustworthy sidecars
    // and updateIndex re-embeds every file from scratch through the
    // changed-file queue. The first batch creates the new store via
    // fromTexts; later batches append via addDocuments. The fallback branch
    // is preserved as defence-in-depth (partial purge failure) but no
    // longer fires in this scenario.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-fallback-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const fileCount = 2;
    const docPaths: string[] = [];
    for (let i = 0; i < fileCount; i += 1) {
      const docPath = path.join(defaultKb, `doc-${i}.md`);
      await fsp.writeFile(docPath, `# Doc ${i}\n\nFallback rebuild coverage content ${i}.`);
      docPaths.push(docPath);
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    // First pass: let a fresh manager populate sidecars and the in-memory index.
    jest.resetModules();
    {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const firstManager = new FaissIndexManager();
      await firstManager.initialize();
      await firstManager.updateIndex();
    }

    // Capture sidecar hash content; after recovery these hashes must be
    // re-derived from the same file bytes, so the content remains identical.
    const sidecarSnapshots: { path: string; content: string }[] = [];
    for (const docPath of docPaths) {
      const relativePath = path.relative(defaultKb, docPath);
      const sidecarPath = path.join(defaultKb, '.index', path.dirname(relativePath), path.basename(docPath));
      const content = await fsp.readFile(sidecarPath, 'utf-8');
      sidecarSnapshots.push({ path: sidecarPath, content });
    }

    // The mocked FaissStore.save never writes any data files, but RFC 014's
    // atomicSave creates a real `index` symlink + versioned dir during the
    // first pass — even with a mocked store. Wipe both layouts now to
    // recreate the "no on-disk index" condition (the operator's manual
    // `rm -rf $FAISS_INDEX_PATH` from #90).
    const modelDirPath = modelDirIn(process.env.FAISS_INDEX_PATH!);
    for (const entry of await fsp.readdir(modelDirPath)) {
      if (entry === 'model_name.txt') continue;
      await fsp.rm(path.join(modelDirPath, entry), { recursive: true, force: true });
    }
    await expect(
      fsp.stat(modelIndexPathIn(process.env.FAISS_INDEX_PATH!))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.lstat(path.join(modelDirIn(process.env.FAISS_INDEX_PATH!), 'index'))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // Reset mocks so the recovery-path call counts are isolated.
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();

    // Second pass: a new manager with the FAISS store missing on disk.
    // initialize() must detect the gone-store, purge the (now-stale)
    // sidecars at <kb>/.index/, and updateIndex must re-embed every file
    // through the per-file path.
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const secondManager = new FaissIndexManager();
    await secondManager.initialize();
    expect(loadMock).not.toHaveBeenCalled();
    // Sidecar dir gone after the #90 purge.
    await expect(fsp.stat(path.join(defaultKb, '.index'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await secondManager.updateIndex();

    // Recovery path: the changed files fit in the default seed batch, which
    // creates the new store via fromTexts without additional addDocuments.
    // One save call closes the updateIndex.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
    // RFC 014 — first save under v014 writes to index.v0/ via atomicSave.
    expect(saveMock).toHaveBeenCalledWith(versionedIndexPathIn(process.env.FAISS_INDEX_PATH!));

    // Aggregate the sources across both calls — order-insensitive coverage
    // that every file made it into the rebuilt store.
    const allSources = new Set<string>();
    {
      const [, fromTextsMetadatas] = fromTextsMock.mock.calls[0] as [
        string[],
        Array<{ source: string }>,
      ];
      for (const m of fromTextsMetadatas) allSources.add(m.source);
      for (const call of addDocumentsMock.mock.calls) {
        const [docs] = call as [Array<{ metadata: { source: string } }>];
        for (const d of docs) allSources.add(d.metadata.source);
      }
    }
    for (const docPath of docPaths) {
      expect(allSources.has(docPath)).toBe(true);
    }

    // Sidecars are rewritten with the same hash content (file bytes
    // unchanged) and no .tmp leftovers from the atomic rename.
    for (const snapshot of sidecarSnapshots) {
      const content = await fsp.readFile(snapshot.path, 'utf-8');
      expect(content).toBe(snapshot.content);
      await expect(fsp.stat(`${snapshot.path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('recovers from a corrupt FAISS index by unlinking it and falling back to rebuild', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-corrupt-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(docPath, '# Title\n\nContent for the corrupt-recovery case.');

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    await fsp.mkdir(modelDirIn(faissDir), { recursive: true });
    const indexFilePath = modelIndexPathIn(faissDir);
    await fsp.writeFile(indexFilePath, 'corrupt-bytes');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    loadMock.mockImplementationOnce(() => {
      throw new Error('invalid faiss index header');
    });

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    await expect(manager.initialize()).resolves.toBeUndefined();

    expect(loadMock).toHaveBeenCalledWith(indexFilePath, expect.anything());
    await expect(fsp.stat(indexFilePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // End-to-end: the next updateIndex must actually rebuild via fromTexts,
    // not just observe a null faissIndex. This proves the corrupt-recovery
    // path hands off correctly to the existing rebuild branch.
    // RFC 014 — rebuild now saves to index.v0/, not the legacy faiss.index/.
    await manager.updateIndex();
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(versionedIndexPathIn(faissDir));
  });

  it('surfaces a permission error when the corrupt FAISS index cannot be unlinked', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-corrupt-eacces-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    await fsp.mkdir(modelDirIn(faissDir), { recursive: true });
    const indexFilePath = modelIndexPathIn(faissDir);
    await fsp.writeFile(indexFilePath, 'corrupt-bytes');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    loadMock.mockImplementationOnce(() => {
      throw new Error('invalid faiss index header');
    });

    // 0o500 on the model dir (containing indexFilePath) keeps stat/read
    // permitted (so the load branch fires) but denies unlink, forcing the
    // handleFsOperationError rethrow path in the corrupt-recovery catch.
    // RFC 013 M1+M2: indexFilePath now sits under models/<id>/, so the chmod
    // targets that subtree.
    await fsp.chmod(modelDirIn(faissDir), 0o500);

    try {
      jest.resetModules();
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const manager = new FaissIndexManager();

      await expect(manager.initialize()).rejects.toThrow(/Permission denied/);
    } finally {
      await fsp.chmod(modelDirIn(faissDir), 0o700);
    }
  });

  // RFC 012 M0 — pre-existing EISDIR bug surfaces under modern FAISS layouts
  // where indexFilePath is a *directory* (containing faiss.index +
  // docstore.json), not a file. fsp.unlink throws EISDIR on directories;
  // fsp.rm({recursive,force}) handles both shapes.
  it('recovers from a corrupt FAISS index when indexFilePath is a directory (modern layout)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-corrupt-dir-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nContent.');

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    await fsp.mkdir(modelDirIn(faissDir), { recursive: true });
    const indexFilePath = modelIndexPathIn(faissDir);
    // Modern langchain layout: indexFilePath is a directory.
    await fsp.mkdir(indexFilePath, { recursive: true });
    await fsp.writeFile(path.join(indexFilePath, 'faiss.index'), 'corrupt-bytes');
    await fsp.writeFile(path.join(indexFilePath, 'docstore.json'), '{"docstore":"corrupt"}');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    loadMock.mockImplementationOnce(() => {
      throw new Error('invalid faiss index header');
    });

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    // Pre-fix this throws EISDIR from the fsp.unlink call on a directory.
    await expect(manager.initialize()).resolves.toBeUndefined();

    // Whole directory removed, including inner files.
    await expect(fsp.stat(indexFilePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // End-to-end: rebuild branch hands off correctly.
    // RFC 014 — rebuild now saves to index.v0/, not the legacy faiss.index/.
    await manager.updateIndex();
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(versionedIndexPathIn(faissDir));
  });

  it('migrates 0.2.x layout into models/<id>/ on bootstrapLayout (RFC 013 §4.8)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-migrate-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nContent.');

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    // Seed 0.2.x layout: ${faissDir}/faiss.index/{...} + ${faissDir}/model_name.txt.
    const oldIndexDir = path.join(faissDir, 'faiss.index');
    await fsp.mkdir(oldIndexDir, { recursive: true });
    await fsp.writeFile(path.join(oldIndexDir, 'faiss.index'), 'old-model-bytes');
    await fsp.writeFile(path.join(oldIndexDir, 'docstore.json'), '{"old":"docstore"}');
    await fsp.writeFile(path.join(faissDir, 'model_name.txt'), 'sentence-transformers/all-MiniLM-L6-v2');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');

    // bootstrapLayout migrates the old layout into models/<id>/.
    await FaissIndexManager.bootstrapLayout();

    // Old paths gone; data preserved under the migrated model_id (derived
    // from old model_name.txt = sentence-transformers/all-MiniLM-L6-v2).
    const migratedId = 'huggingface__sentence-transformers-all-MiniLM-L6-v2';
    const migratedIndexDir = path.join(faissDir, 'models', migratedId, 'faiss.index');
    await expect(fsp.stat(oldIndexDir)).rejects.toMatchObject({ code: 'ENOENT' });
    // The migrated path must be a directory (not a regular file or a
    // symlink — the migration is supposed to move the layout, not turn
    // it into a sentinel) AND its inner content must round-trip verbatim.
    expect((await fsp.stat(migratedIndexDir)).isDirectory()).toBe(true);
    expect(await fsp.readFile(path.join(migratedIndexDir, 'faiss.index'), 'utf-8')).toBe('old-model-bytes');
    expect(await fsp.readFile(path.join(migratedIndexDir, 'docstore.json'), 'utf-8')).toBe('{"old":"docstore"}');

    // model_name.txt moved into models/<id>/.
    expect(await fsp.readFile(path.join(faissDir, 'models', migratedId, 'model_name.txt'), 'utf-8'))
      .toBe('sentence-transformers/all-MiniLM-L6-v2');

    // active.txt written with the migrated id.
    expect((await fsp.readFile(path.join(faissDir, 'active.txt'), 'utf-8')).trim()).toBe(migratedId);
  });

  it('refuses migration when 0.2.x layout has no model_name.txt (round-1 failure F5)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-migrate-refuse-'));
    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    // 0.2.x layout WITHOUT model_name.txt — pre-RFC-012.
    await fsp.mkdir(path.join(faissDir, 'faiss.index'), { recursive: true });
    await fsp.writeFile(path.join(faissDir, 'faiss.index', 'faiss.index'), 'mystery-bytes');

    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager, MigrationRefusedError } = await import('./FaissIndexManager.js');

    await expect(
      FaissIndexManager.bootstrapLayout()
    ).rejects.toBeInstanceOf(MigrationRefusedError);

    // Old layout untouched — assert byte-for-byte content preservation,
    // not just path existence. A regression that truncated the index
    // before throwing MigrationRefusedError would pass under the
    // resolves.toBeDefined() bar.
    expect((await fsp.stat(path.join(faissDir, 'faiss.index'))).isDirectory()).toBe(true);
    expect(
      await fsp.readFile(path.join(faissDir, 'faiss.index', 'faiss.index'), 'utf-8'),
    ).toBe('mystery-bytes');
    await expect(fsp.stat(path.join(faissDir, 'models'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not fail when the corrupt FAISS index has no .json sibling', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-corrupt-nojson-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    await fsp.mkdir(modelDirIn(faissDir), { recursive: true });
    const indexFilePath = modelIndexPathIn(faissDir);
    await fsp.writeFile(indexFilePath, 'corrupt-bytes');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    loadMock.mockImplementationOnce(() => {
      throw new Error('invalid faiss index header');
    });

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    await expect(manager.initialize()).resolves.toBeUndefined();
    await expect(fsp.stat(indexFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write hash sidecars when the FAISS save fails', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-save-fail-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(docPath, '# Title\n\nContent for the failing-save case.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    saveMock.mockRejectedValue(createPermissionError('cannot write index'));

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    await expect(manager.updateIndex()).rejects.toThrow(/Permission denied/);

    const sidecarPath = path.join(defaultKb, '.index', 'doc.md');
    await expect(fsp.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(`${sidecarPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // RFC 012 §4.5 — readOnly seam
  it('initialize({ readOnly: true }) does not write model_name.txt', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-readonly-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });
    const faissDir = path.join(tempDir, '.faiss');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    await manager.initialize({ readOnly: true });

    // model_name.txt must NOT exist after a read-only init.
    const modelNameFile = modelNameFileIn(faissDir);
    await expect(fsp.stat(modelNameFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('initialize({ strictReadOnly: true }) does not create a missing model directory', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-strict-readonly-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });
    const faissDir = path.join(tempDir, '.faiss');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    await expect(manager.initialize({ strictReadOnly: true })).rejects.toThrow(
      /read-only load will not create/,
    );
    await expect(fsp.stat(modelDirIn(faissDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('initialize() (default) writes model_name.txt atomically', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-atomic-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });
    const faissDir = path.join(tempDir, '.faiss');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    // model_name.txt exists with the configured model.
    const modelNameFile = modelNameFileIn(faissDir);
    expect(await fsp.readFile(modelNameFile, 'utf-8')).toBe('BAAI/bge-small-en-v1.5');

    // No leftover .tmp file from the atomic rename.
    const entries = await fsp.readdir(faissDir);
    const tmpEntries = entries.filter((e) => e.startsWith('model_name.txt.') && e.endsWith('.tmp'));
    expect(tmpEntries).toEqual([]);
  });
});

describe('FaissIndexManager #90 — sidecar invalidation when FAISS store is missing', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  /**
   * Reproduces the partial-drift scenario from issue #90:
   *
   *   1. KB `kb-a` has been indexed previously — its `.index/*.md` sidecars
   *      hold the SHA256 of every file's current contents.
   *   2. The FAISS store at $FAISS_INDEX_PATH was removed (mv aside, manual
   *      `rm -rf`, partial restore, crash mid-rebuild). No `index` symlink
   *      and no legacy `faiss.index/` for this model.
   *   3. Server starts; another KB has already been re-indexed in this run
   *      (`faissIndex !== null`), so the existing fallback rebuild branch
   *      cannot fire for `kb-a` later. (We exercise the failing branch
   *      directly via updateIndex(kb-a) below.)
   *
   * Without the fix: every kb-a file's hash matches its sidecar, so updateIndex
   * skips embedding and the index stays empty for kb-a — silently.
   *
   * With the fix: initialize() purges the stale sidecars; updateIndex(kb-a)
   * re-embeds every file via fromTexts (rebuild branch) or addDocuments
   * (incremental). We assert that fromTexts was called with both sources.
   */
  it('purges stale sidecars at initialize() when this model has no on-disk store, then re-embeds on updateIndex', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-issue-90-purge-'));
    const kbDir = path.join(tempDir, 'kb');
    const kbA = path.join(kbDir, 'kb-a');
    const kbB = path.join(kbDir, 'kb-b');
    await fsp.mkdir(kbA, { recursive: true });
    await fsp.mkdir(kbB, { recursive: true });

    const fileA1 = path.join(kbA, 'doc-1.md');
    const fileA2 = path.join(kbA, 'doc-2.md');
    const fileB1 = path.join(kbB, 'note.md');
    await fsp.writeFile(fileA1, '# A1\n\nFirst doc in kb-a.');
    await fsp.writeFile(fileA2, '# A2\n\nSecond doc in kb-a.');
    await fsp.writeFile(fileB1, '# B1\n\nA note in kb-b.');

    // Pre-seed the .index/*.md sidecars with the *current* file hashes so
    // updateIndex would skip every file (the silent-empty-results bug).
    const { calculateSHA256 } = await import('./file-utils.js');
    for (const file of [fileA1, fileA2, fileB1]) {
      const sidecarDir = path.join(path.dirname(file), '.index');
      await fsp.mkdir(sidecarDir, { recursive: true });
      await fsp.writeFile(
        path.join(sidecarDir, path.basename(file)),
        await calculateSHA256(file),
      );
    }

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    // Sidecars must be gone after initialize(): the store-missing detection
    // recognised them as stale and purged them.
    await expect(fsp.stat(path.join(kbA, '.index'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(kbB, '.index'))).rejects.toMatchObject({ code: 'ENOENT' });

    // updateIndex must now re-embed every file from scratch (no sidecars to
    // mask the empty store). With faissIndex starting at null and no
    // sidecars present, every file's `fileHash !== storedHash` queues the
    // file for the default seed batch. One save call, sidecars rewritten.
    await manager.updateIndex();
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);

    for (const file of [fileA1, fileA2, fileB1]) {
      const sidecarPath = path.join(path.dirname(file), '.index', path.basename(file));
      const content = await fsp.readFile(sidecarPath, 'utf-8');
      expect(content).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('does NOT purge sidecars when the FAISS store loads successfully', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-issue-90-noop-'));
    const kbDir = path.join(tempDir, 'kb');
    const kbA = path.join(kbDir, 'kb-a');
    await fsp.mkdir(kbA, { recursive: true });
    const fileA = path.join(kbA, 'doc.md');
    await fsp.writeFile(fileA, '# A\n\nContent.');

    // Pre-seed a sidecar with the correct hash.
    const { calculateSHA256 } = await import('./file-utils.js');
    const sidecarDir = path.join(kbA, '.index');
    await fsp.mkdir(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'doc.md');
    const expectedHash = await calculateSHA256(fileA);
    await fsp.writeFile(sidecarPath, expectedHash);

    // Pre-seed a legacy FAISS store directory so loadAtomic finds and
    // loads it (the mock load resolves to a fresh MockFaissStore).
    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(modelDirIn(faissDir), { recursive: true });
    await fsp.mkdir(modelIndexPathIn(faissDir), { recursive: true });

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    expect(loadMock).toHaveBeenCalledTimes(1);
    // Sidecar must survive: store loaded successfully, no purge needed.
    await expect(fsp.readFile(sidecarPath, 'utf-8')).resolves.toBe(expectedHash);
  });

  it('does NOT purge sidecars under initialize({ readOnly: true })', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-issue-90-readonly-'));
    const kbDir = path.join(tempDir, 'kb');
    const kbA = path.join(kbDir, 'kb-a');
    await fsp.mkdir(kbA, { recursive: true });
    const fileA = path.join(kbA, 'doc.md');
    await fsp.writeFile(fileA, '# A\n\nReadonly path content.');

    const { calculateSHA256 } = await import('./file-utils.js');
    const sidecarDir = path.join(kbA, '.index');
    await fsp.mkdir(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'doc.md');
    const expectedHash = await calculateSHA256(fileA);
    await fsp.writeFile(sidecarPath, expectedHash);

    // No FAISS store on disk — would normally trigger purge, but readOnly
    // suppresses it (no mutations under that mode, RFC 012 §4.5).
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize({ readOnly: true });

    await expect(fsp.readFile(sidecarPath, 'utf-8')).resolves.toBe(expectedHash);
  });

  it('skips symlinked KB entries during purge to avoid path-escape rmrf (Codex P2)', async () => {
    // A user can legitimately mount an external KB via symlink
    // (`~/knowledge_bases/external -> /elsewhere/notes`). `listKnowledgeBases`
    // filters dot-prefixes only, so without the lstat check the recursive
    // rm could delete `<external-target>/.index` — outside the configured
    // root. The fix: lstat each KB entry and skip symlinks. The KB stays
    // unindexed-by-this-recovery; the user's manual `find` workaround
    // (which does NOT follow symlinks by default) still works.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-issue-90-symlink-'));
    const kbDir = path.join(tempDir, 'kb');
    const realKb = path.join(kbDir, 'real-kb');
    await fsp.mkdir(realKb, { recursive: true });
    await fsp.writeFile(path.join(realKb, 'doc.md'), '# Real\n\nReal content.');

    // External target outside KNOWLEDGE_BASES_ROOT_DIR. `<external>/.index/`
    // pre-seeded with a sentinel sidecar; the test asserts it survives.
    const externalRoot = path.join(tempDir, 'external');
    const externalIndex = path.join(externalRoot, '.index');
    await fsp.mkdir(externalIndex, { recursive: true });
    const sentinelSidecar = path.join(externalIndex, 'sentinel.md');
    await fsp.writeFile(sentinelSidecar, 'do-not-delete');

    // KB symlink at `<kbDir>/external-kb -> <externalRoot>`. With the bug,
    // purgeStaleSidecars would resolve `<kbDir>/external-kb/.index/`,
    // realpath outside the root, and rmrf the sentinel.
    await fsp.symlink(externalRoot, path.join(kbDir, 'external-kb'));

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    // External index must survive — the symlink-skip prevents path escape.
    await expect(fsp.readFile(sentinelSidecar, 'utf-8')).resolves.toBe('do-not-delete');
    // The non-symlinked KB had no `.index/` to begin with; nothing to assert
    // there beyond initialize completing without error.
  });

  it('serializes the purge with concurrent sidecar writes via withSidecarLock (Codex P1)', async () => {
    // The race the lock prevents: another model's `updateIndex` is mid-
    // sidecar-write batch (per-model lock only) when this model's
    // `purgeStaleSidecars` fires (fresh init under missing store) — the
    // purge would `rmrf` the parent dir between the writer's `mkdir` and
    // `rename`, causing ENOENT. The lock at `${FAISS_INDEX_PATH}/.kb-sidecar.lock`
    // is acquired by both sides.
    //
    // We can't truly drive concurrency in a single test without flakiness,
    // but we can verify the lock file is created (and cleaned up) by the
    // purge path — strong signal that the serialization primitive is wired.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-issue-90-lock-'));
    const kbDir = path.join(tempDir, 'kb');
    const kbA = path.join(kbDir, 'kb-a');
    await fsp.mkdir(kbA, { recursive: true });
    await fsp.writeFile(path.join(kbA, 'doc.md'), '# A\n\nContent.');

    // Pre-seed a sidecar so the purge has work to do.
    const { calculateSHA256 } = await import('./file-utils.js');
    const sidecarDir = path.join(kbA, '.index');
    await fsp.mkdir(sidecarDir, { recursive: true });
    await fsp.writeFile(
      path.join(sidecarDir, 'doc.md'),
      await calculateSHA256(path.join(kbA, 'doc.md')),
    );

    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();

    // Lockfile lives under FAISS_INDEX_PATH and must NOT survive past the
    // purge (proper-lockfile cleans up on release). If the lock leaked,
    // the next acquisition would either block on retry or stale-clean
    // after 30s — both observable as test slowness or flakes.
    const lockfilePath = path.join(faissDir, '.kb-sidecar.lock');
    await expect(fsp.stat(lockfilePath)).rejects.toMatchObject({ code: 'ENOENT' });

    // Sidecars purged as expected.
    await expect(fsp.stat(path.join(kbA, '.index'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Followup sidecar write through updateIndex must also acquire the
    // lock and release it without leaving the lockfile behind.
    await manager.updateIndex();
    await expect(fsp.stat(lockfilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('handles a missing KNOWLEDGE_BASES_ROOT_DIR without throwing during the purge', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-issue-90-no-kbroot-'));
    const missingKbRoot = path.join(tempDir, 'kb-does-not-exist');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = missingKbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();

    // ENOENT on the KB root must not propagate from the purge path —
    // initialize must succeed and leave no stale state behind.
    await expect(manager.initialize()).resolves.toBeUndefined();
  });
});

describe('FaissIndexManager chunk metadata (RFC 010 M1)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  async function runHappyPath(kbRoot: string) {
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(kbRoot, '..', '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    return fromTextsMock.mock.calls[0] as [string[], Record<string, unknown>[]];
  }

  it('extracts frontmatter tags and strips the fence from the embedded body', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-meta-tags-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(
      docPath,
      '---\ntags: [foo, bar]\n---\n# Heading\n\nReal content that should embed.\n'
    );

    const [texts, metadatas] = await runHappyPath(kbDir);

    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toContain('---');
      expect(text).not.toContain('tags:');
    }
    expect(metadatas.length).toBe(texts.length);
    for (const md of metadatas) {
      expect(md.tags).toEqual(['foo', 'bar']);
      expect(md.source).toBe(docPath);
      expect(md.knowledgeBase).toBe('default');
      expect(md.extension).toBe('.md');
      expect(md.relativePath).toBe('default/doc.md');
      expect(typeof md.chunkIndex).toBe('number');
    }
  });

  it('produces `tags: []` when the file has no frontmatter', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-meta-notags-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'plain.md'), '# Plain\n\nNo frontmatter.\n');

    const [, metadatas] = await runHappyPath(kbDir);
    for (const md of metadatas) {
      expect(md.tags).toEqual([]);
    }
  });

  it('assigns deterministic 0-based chunkIndex within a single source file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-meta-chunkidx-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });

    // Payload large enough to force the splitter to produce >1 chunk.
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(10)}`
    );
    const content = paragraphs.join('\n\n');
    const filePath = path.join(defaultKb, 'long.txt');
    await fsp.writeFile(filePath, content);

    const [texts, metadatas] = await runHappyPath(kbDir);
    expect(texts.length).toBeGreaterThan(1);
    // All metadatas are for the same source, so chunkIndex should be [0, 1, …, N-1].
    const perFile = metadatas.filter((m) => m.source === filePath);
    expect(perFile.length).toBe(texts.length);
    for (let i = 0; i < perFile.length; i += 1) {
      expect(perFile[i].chunkIndex).toBe(i);
    }
  });

  it('derives `knowledgeBase` from the first path segment under the KB root', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-meta-kbname-'));
    const kbDir = path.join(tempDir, 'kb');
    const teamKb = path.join(kbDir, 'team-notes');
    await fsp.mkdir(path.join(teamKb, 'company'), { recursive: true });
    await fsp.writeFile(
      path.join(teamKb, 'company', 'onboarding.md'),
      '# Onboarding\n\nHello.\n'
    );

    const [, metadatas] = await runHappyPath(kbDir);
    expect(metadatas.length).toBeGreaterThan(0);
    for (const md of metadatas) {
      expect(md.knowledgeBase).toBe('team-notes');
      expect(md.relativePath).toBe('team-notes/company/onboarding.md');
    }
  });

  it('also strips YAML frontmatter from non-markdown files (universal-strip contract)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-meta-txt-fm-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'note.txt');
    await fsp.writeFile(
      docPath,
      '---\ntags: [nontext]\n---\nPlain-text body after frontmatter.\n'
    );

    const [texts, metadatas] = await runHappyPath(kbDir);

    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toContain('---');
      expect(text).not.toContain('tags:');
    }
    for (const md of metadatas) {
      expect(md.tags).toEqual(['nontext']);
      expect(md.extension).toBe('.txt');
    }
  });

  it('applies the same metadata shape in the fallback rebuild branch', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-meta-fallback-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    const docPath = path.join(defaultKb, 'doc.md');
    await fsp.writeFile(
      docPath,
      '---\ntags: [fallback]\n---\n# Title\n\nFallback branch content.\n'
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    // First pass: seed sidecars so the second run sees hashes match.
    jest.resetModules();
    {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const first = new FaissIndexManager();
      await first.initialize();
      await first.updateIndex();
    }

    // Precondition: no on-disk index, so a fresh manager will take the
    // fallback rebuild branch. RFC 014 — the mocked save never writes the
    // staging dir, but atomicSave creates a real `index` symlink anyway.
    // Wipe both layouts to recreate the "no on-disk index" condition.
    const _modelDirA = modelDirIn(process.env.FAISS_INDEX_PATH!);
    for (const entry of await fsp.readdir(_modelDirA)) {
      if (entry === 'model_name.txt') continue;
      await fsp.rm(path.join(_modelDirA, entry), { recursive: true, force: true });
    }
    await expect(
      fsp.stat(modelIndexPathIn(process.env.FAISS_INDEX_PATH!))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const second = new FaissIndexManager();
    await second.initialize();
    await second.updateIndex();

    // The fallback branch must have fired and must produce the same enriched shape.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).not.toHaveBeenCalled();
    const [texts, metadatas] = fromTextsMock.mock.calls[0] as [string[], Record<string, unknown>[]];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toContain('---');
    }
    for (const md of metadatas) {
      expect(md.source).toBe(docPath);
      expect(md.knowledgeBase).toBe('default');
      expect(md.extension).toBe('.md');
      expect(md.relativePath).toBe('default/doc.md');
      expect(md.tags).toEqual(['fallback']);
      expect(typeof md.chunkIndex).toBe('number');
    }
  });
});

describe('FaissIndexManager similaritySearch threshold filter', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  async function setupReadyManager() {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-threshold-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nContent for threshold tests.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    return manager;
  }

  it('drops tuples whose score is above the caller-supplied threshold', async () => {
    const manager = await setupReadyManager();
    const docA = { pageContent: 'a', metadata: { source: 'a' } };
    const docB = { pageContent: 'b', metadata: { source: 'b' } };
    similaritySearchMock.mockResolvedValueOnce([
      [docA, 0.5],
      [docB, 1.5],
    ]);

    const results = await manager.similaritySearch('query', 10, 1.0);

    expect(results).toHaveLength(1);
    expect(results[0].pageContent).toBe('a');
    expect(results[0].score).toBe(0.5);
  });

  it('throws INDEX_NOT_INITIALIZED when similaritySearch runs before initialize/updateIndex', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-uninitialized-'));
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { KBError } = await import('./errors.js');
    const manager = new FaissIndexManager();

    await expect(manager.similaritySearch('query', 10)).rejects.toBeInstanceOf(KBError);
    await expect(manager.similaritySearch('query', 10)).rejects.toMatchObject({
      code: 'INDEX_NOT_INITIALIZED',
      message: 'FAISS index is not initialized',
    });
  });

  it('keeps results at or below the default threshold of 2 and drops the rest', async () => {
    const manager = await setupReadyManager();
    const docs = [
      { pageContent: 'a', metadata: { source: 'a' } },
      { pageContent: 'b', metadata: { source: 'b' } },
      { pageContent: 'c', metadata: { source: 'c' } },
    ];
    similaritySearchMock.mockResolvedValueOnce([
      [docs[0], 0.1],
      [docs[1], 1.9],
      [docs[2], 2.5],
    ]);

    const results = await manager.similaritySearch('query', 10);

    expect(results.map((r) => r.score)).toEqual([0.1, 1.9]);
  });

  it('returns every result when the threshold is generous', async () => {
    const manager = await setupReadyManager();
    const docs = [
      { pageContent: 'a', metadata: { source: 'a' } },
      { pageContent: 'b', metadata: { source: 'b' } },
    ];
    similaritySearchMock.mockResolvedValueOnce([
      [docs[0], 0.1],
      [docs[1], 0.5],
    ]);

    const results = await manager.similaritySearch('query', 10, 10);

    expect(results.map((r) => r.score)).toEqual([0.1, 0.5]);
  });
});

describe('FaissIndexManager ingest filter (RFC 011 M1)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    INGEST_EXTRA_EXTENSIONS: process.env.INGEST_EXTRA_EXTENSIONS,
    INGEST_EXCLUDE_PATHS: process.env.INGEST_EXCLUDE_PATHS,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  async function seedArxivKb(kbRoot: string) {
    // Mirror the real arxiv workflow layout so the fixture exercises the
    // exact filter rules the RFC's Motivation §2.2 calls out.
    const notesDir = path.join(kbRoot, 'notes');
    const pdfsDir = path.join(kbRoot, 'pdfs');
    const logsDir = path.join(kbRoot, 'logs');
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.mkdir(pdfsDir, { recursive: true });
    await fsp.mkdir(logsDir, { recursive: true });

    // Two notes with frontmatter matching the real arxiv schema.
    await fsp.writeFile(
      path.join(notesDir, '2604.21215.md'),
      '---\narxiv_id: 2604.21215\ntags: [kv-cache, quantization]\n---\n# Paper A\n\nBody A.\n',
    );
    await fsp.writeFile(
      path.join(notesDir, '2604.21221.md'),
      '---\narxiv_id: 2604.21221\ntags: [sparse-attention]\n---\n# Paper B\n\nBody B.\n',
    );

    // Binary PDFs as `%PDF-` headed garbage — UTF-8-decoding these would
    // corrupt to U+FFFD noise if the filter failed to exclude them.
    await fsp.writeFile(
      path.join(pdfsDir, '2604.21215.pdf'),
      Buffer.from('%PDF-1.7\n' + 'binary\x00bytes\xff'.repeat(50)),
    );
    await fsp.writeFile(
      path.join(pdfsDir, '2604.21221.pdf'),
      Buffer.from('%PDF-1.7\n' + 'more\x00binary\xff'.repeat(50)),
    );

    // Workflow sidecar + daily log — both non-dotfile and thus walked today.
    await fsp.writeFile(
      path.join(kbRoot, '_seen.jsonl'),
      '{"id":"2604.21215","seen_at":"2026-04-24T22:37:01.985Z","status":"ingested"}\n' +
        '{"id":"2604.21221","seen_at":"2026-04-24T22:42:27.567Z","status":"ingested"}\n',
    );
    await fsp.writeFile(
      path.join(logsDir, '2026-04-24.log'),
      '2026-04-24T22:37 ingested 2604.21215\n2026-04-24T22:42 ingested 2604.21221\n',
    );
  }

  function collectIngestedDocs(): {
    texts: string[];
    metadatas: Record<string, unknown>[];
  } {
    // updateIndex bootstraps the store via fromTexts on the first file and
    // appends subsequent files via addDocuments — aggregate both so the
    // per-file assertions are order-independent.
    const texts: string[] = [];
    const metadatas: Record<string, unknown>[] = [];
    for (const call of fromTextsMock.mock.calls) {
      const [callTexts, callMetadatas] = call as [
        string[],
        Record<string, unknown>[],
      ];
      texts.push(...callTexts);
      metadatas.push(...callMetadatas);
    }
    for (const call of addDocumentsMock.mock.calls) {
      const [docs] = call as [
        Array<{ pageContent: string; metadata: Record<string, unknown> }>,
      ];
      for (const doc of docs) {
        texts.push(doc.pageContent);
        metadatas.push(doc.metadata);
      }
    }
    return { texts, metadatas };
  }

  it('embeds only notes/*.md on an arxiv-shaped KB (PDFs, _seen.jsonl, logs/** excluded)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-arxiv-'));
    const kbRoot = path.join(tempDir, 'kb');
    const arxivKb = path.join(kbRoot, 'arxiv-llm-inference');
    await seedArxivKb(arxivKb);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INGEST_EXTRA_EXTENSIONS;
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { texts, metadatas } = collectIngestedDocs();

    // Every emitted chunk must originate from a .md file under notes/.
    const sources = new Set(metadatas.map((m) => String(m.source)));
    for (const src of sources) {
      expect(src.endsWith('.md')).toBe(true);
      expect(src).toContain(`${path.sep}notes${path.sep}`);
    }
    // Concretely: the two note files are ingested; nothing else.
    expect(sources.size).toBe(2);
    expect(sources.has(path.join(arxivKb, 'notes', '2604.21215.md'))).toBe(true);
    expect(sources.has(path.join(arxivKb, 'notes', '2604.21221.md'))).toBe(true);

    // Defensive content assertion: no chunk text carries the %PDF- header
    // or _seen.jsonl ledger shape.
    for (const text of texts) {
      expect(text).not.toContain('%PDF-');
      expect(text).not.toContain('"status":"ingested"');
    }

    // The PDFs, _seen.jsonl, and logs/*.log must not have sidecar hash files —
    // they were never ingested.
    await expect(
      fsp.stat(path.join(arxivKb, '.index', 'pdfs', '2604.21215.pdf')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.stat(path.join(arxivKb, '.index', '_seen.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.stat(path.join(arxivKb, '.index', 'logs', '2026-04-24.log')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('INGEST_EXTRA_EXTENSIONS=".json" admits a notes/config.json while Rule A still excludes _seen.jsonl', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-extra-ext-'));
    const kbRoot = path.join(tempDir, 'kb');
    const arxivKb = path.join(kbRoot, 'arxiv-llm-inference');
    await seedArxivKb(arxivKb);

    // Add a JSON config the operator wants embedded.
    await fsp.writeFile(
      path.join(arxivKb, 'notes', 'config.json'),
      '{"schema_version": 1, "topic": "llm-inference"}',
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.json';
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectIngestedDocs();
    const sources = new Set(metadatas.map((m) => String(m.source)));
    expect(sources.has(path.join(arxivKb, 'notes', 'config.json'))).toBe(true);
    // _seen.jsonl is still excluded by Rule A (segment-literal), even with
    // .json added to the allowlist — Rule A runs before Rule B.
    expect(sources.has(path.join(arxivKb, '_seen.jsonl'))).toBe(false);
  });

  it('applies the filter on the post-#90 store-loss recovery path (not only the steady-state per-KB update loop)', async () => {
    // The steady-state per-KB update loop and the store-loss recovery
    // path (#90, sidecars purged at initialize → all files re-embedded
    // through the per-file path on the next updateIndex) are conceptually
    // independent — but both go through the same `enumerateIngestableKbFiles`
    // path in updateIndex. This test guards against a future refactor that
    // adds a second `getFilesRecursively` site without wrapping it in the
    // filter.
    //
    // Pre-#90 this test drove the (now-effectively-dead) fallback rebuild
    // branch by seeding sidecars then deleting the FAISS store. Post-#90
    // initialize() purges those sidecars, so updateIndex re-embeds via
    // the per-file path. The filter must still exclude PDFs / _seen.jsonl
    // / logs/**/*.log.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-fallback-'));
    const kbRoot = path.join(tempDir, 'kb');
    const arxivKb = path.join(kbRoot, 'arxiv-llm-inference');
    await seedArxivKb(arxivKb);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INGEST_EXTRA_EXTENSIONS;
    delete process.env.INGEST_EXCLUDE_PATHS;

    // First pass: seed sidecars via the per-KB update loop.
    jest.resetModules();
    {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const first = new FaissIndexManager();
      await first.initialize();
      await first.updateIndex();
    }

    // Precondition: no on-disk index. RFC 014 — the mocked save never
    // writes a staging dir, but atomicSave creates a real `index` symlink
    // anyway. Wipe both layouts to recreate the "no on-disk index"
    // condition (the operator's manual `rm -rf $FAISS_INDEX_PATH` from #90).
    const _modelDirB = modelDirIn(process.env.FAISS_INDEX_PATH!);
    for (const entry of await fsp.readdir(_modelDirB)) {
      if (entry === 'model_name.txt') continue;
      await fsp.rm(path.join(_modelDirB, entry), { recursive: true, force: true });
    }
    await expect(
      fsp.stat(modelIndexPathIn(process.env.FAISS_INDEX_PATH!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();

    // Second pass: fresh manager. initialize() purges the now-stale
    // sidecars (#90), updateIndex re-embeds every filtered file via the
    // per-file path. The filter must still exclude the PDFs, _seen.jsonl,
    // and logs/**/*.log.
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const second = new FaissIndexManager();
    await second.initialize();
    await second.updateIndex();

    // Per-file recovery: first filtered file → fromTexts, the rest →
    // addDocuments. Aggregate via the existing helper.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    const { texts, metadatas } = collectIngestedDocs();
    const sources = new Set(metadatas.map((m) => String(m.source)));
    for (const src of sources) {
      expect(src.endsWith('.md')).toBe(true);
      expect(src).toContain(`${path.sep}notes${path.sep}`);
    }
    expect(sources.size).toBe(2); // only the two notes
    for (const text of texts) {
      expect(text).not.toContain('%PDF-');
      expect(text).not.toContain('"status":"ingested"');
    }
  });

  it('INGEST_EXCLUDE_PATHS="drafts/**" suppresses a drafts/ subtree without touching notes/', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-exclude-'));
    const kbRoot = path.join(tempDir, 'kb');
    const arxivKb = path.join(kbRoot, 'arxiv-llm-inference');
    await seedArxivKb(arxivKb);

    const draftsDir = path.join(arxivKb, 'drafts');
    await fsp.mkdir(draftsDir, { recursive: true });
    await fsp.writeFile(path.join(draftsDir, 'scratch.md'), '# WIP\n\nNot yet.\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INGEST_EXTRA_EXTENSIONS;
    process.env.INGEST_EXCLUDE_PATHS = 'drafts/**';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectIngestedDocs();
    const sources = new Set(metadatas.map((m) => String(m.source)));
    expect(sources.has(path.join(arxivKb, 'drafts', 'scratch.md'))).toBe(false);
    expect(sources.has(path.join(arxivKb, 'notes', '2604.21215.md'))).toBe(true);
  });
});

describe('FaissIndexManager ingest — PDF + HTML loaders (issue #46)', () => {
  // pdf-parse drives pdfjs-dist which would attempt to set up a fake worker
  // and read a bundled fixture under jest's loader. Mocking the direct lib
  // path lets us assert that .pdf files are routed through the PDF loader,
  // that the extracted text reaches the splitter, and that PDF chunks land
  // with the right metadata — without booting pdfjs.
  jest.mock('pdf-parse/lib/pdf-parse.js', () => ({
    __esModule: true,
    default: async (_buf: Buffer) => ({
      text: 'Mock PDF body extracted by pdf-parse stub.',
    }),
  }));

  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    INGEST_EXTRA_EXTENSIONS: process.env.INGEST_EXTRA_EXTENSIONS,
    INGEST_EXCLUDE_PATHS: process.env.INGEST_EXCLUDE_PATHS,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv) as Array<
      [keyof typeof originalEnv, string | undefined]
    >) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  function collectIngestedDocs(): {
    texts: string[];
    metadatas: Record<string, unknown>[];
  } {
    const texts: string[] = [];
    const metadatas: Record<string, unknown>[] = [];
    for (const call of fromTextsMock.mock.calls) {
      const [callTexts, callMetadatas] = call as [
        string[],
        Record<string, unknown>[],
      ];
      texts.push(...callTexts);
      metadatas.push(...callMetadatas);
    }
    for (const call of addDocumentsMock.mock.calls) {
      const [docs] = call as [
        Array<{ pageContent: string; metadata: Record<string, unknown> }>,
      ];
      for (const doc of docs) {
        texts.push(doc.pageContent);
        metadatas.push(doc.metadata);
      }
    }
    return { texts, metadatas };
  }

  it('ingests a `.pdf` file via the PDF loader (issue #46 happy path)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-pdf-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    await fsp.mkdir(docsKb, { recursive: true });
    // Real PDF bytes (header is what the in-loader header guard, if any,
    // would inspect; the rest is opaque since pdf-parse is mocked).
    await fsp.writeFile(
      path.join(docsKb, 'spec.pdf'),
      Buffer.from('%PDF-1.4\n%mocked content does not need to be valid here'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.pdf';
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { texts, metadatas } = collectIngestedDocs();
    expect(texts.some((t) => t.includes('Mock PDF body'))).toBe(true);
    const pdfMetadata = metadatas.find(
      (m) => String(m.source).endsWith('.pdf'),
    );
    // toMatchObject fails clearly when pdfMetadata is undefined AND when
    // any subfield mismatches — strictly stronger than the prior
    // toBeDefined()-then-?.-access pattern.
    expect(pdfMetadata).toMatchObject({
      extension: '.pdf',
      knowledgeBase: 'docs',
    });
  });

  it('lets INGEST_EXCLUDE_PATHS suppress PDFs even when .pdf is explicitly opted in', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-pdf-excluded-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    const notesDir = path.join(docsKb, 'notes');
    const pdfsDir = path.join(docsKb, 'pdfs');
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.mkdir(pdfsDir, { recursive: true });
    await fsp.writeFile(path.join(notesDir, 'summary.md'), '# Summary\n\nUse the note.\n');
    await fsp.writeFile(
      path.join(pdfsDir, 'paper.pdf'),
      Buffer.from('%PDF-1.4\n%mocked content does not need to be valid here'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.pdf';
    process.env.INGEST_EXCLUDE_PATHS = 'pdfs/**';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { texts, metadatas } = collectIngestedDocs();
    const sources = new Set(metadatas.map((m) => String(m.source)));
    expect(sources.has(path.join(docsKb, 'notes', 'summary.md'))).toBe(true);
    expect(sources.has(path.join(docsKb, 'pdfs', 'paper.pdf'))).toBe(false);
    expect(texts.some((t) => t.includes('Mock PDF body'))).toBe(false);
    await expect(
      fsp.stat(path.join(docsKb, '.index', 'pdfs', 'paper.pdf')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds once when an existing index has a freshness manifest from the old PDF-default filter', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-pdf-migration-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    await fsp.mkdir(docsKb, { recursive: true });
    await fsp.writeFile(path.join(docsKb, 'summary.md'), '# Summary\n\nUse the note.\n');
    await fsp.writeFile(
      path.join(docsKb, 'paper.pdf'),
      Buffer.from('%PDF-1.4\n%mocked content does not need to be valid here'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.pdf';
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const first = new FaissIndexManager();
      await first.initialize();
      await first.updateIndex();
    }
    expect(collectIngestedDocs().metadatas.some((m) => String(m.source).endsWith('.pdf'))).toBe(
      true,
    );
    await expect(
      fsp.stat(path.join(docsKb, '.index', 'paper.pdf')),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });

    // The mocked FaissStore.save creates the versioned directory + symlink
    // but not a concrete faiss.index file. Seed one so the freshness
    // migration path sees the same on-disk signal as a real index.
    const activeIndexPath = path.join(
      versionedIndexPathIn(process.env.FAISS_INDEX_PATH!),
      'faiss.index',
    );
    await fsp.mkdir(path.dirname(activeIndexPath), { recursive: true });
    await fsp.writeFile(activeIndexPath, 'mock faiss bytes', 'utf-8');
    const activeIndexStat = await fsp.stat(activeIndexPath);
    const { writeFreshnessManifest } = await import('./freshness-manifest.js');
    await writeFreshnessManifest({
      modelId: DEFAULT_MODEL_ID,
      modelDir: modelDirIn(process.env.FAISS_INDEX_PATH!),
      kbRootDir: kbRoot,
      indexMtimeMs: activeIndexStat.mtimeMs,
      filterConfig: {
        baseExtensions: ['.md', '.markdown', '.txt', '.rst', '.html', '.htm', '.pdf'],
        extraExtensions: [],
        excludePaths: [],
      },
    });

    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    delete process.env.INGEST_EXTRA_EXTENSIONS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const second = new FaissIndexManager();
    await second.initialize();
    await second.updateIndex();

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    const { texts, metadatas } = collectIngestedDocs();
    const sources = new Set(metadatas.map((m) => String(m.source)));
    expect(sources.has(path.join(docsKb, 'summary.md'))).toBe(true);
    expect(sources.has(path.join(docsKb, 'paper.pdf'))).toBe(false);
    expect(texts.some((t) => t.includes('Mock PDF body'))).toBe(false);
    await expect(
      fsp.stat(path.join(docsKb, '.index', 'paper.pdf')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a stale PDF-only persisted index when the new default filter has no ingestable files', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-pdf-only-migration-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    await fsp.mkdir(docsKb, { recursive: true });
    await fsp.writeFile(
      path.join(docsKb, 'paper.pdf'),
      Buffer.from('%PDF-1.4\n%mocked content does not need to be valid here'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.pdf';
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    {
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const first = new FaissIndexManager();
      await first.initialize();
      await first.updateIndex();
    }
    expect(collectIngestedDocs().metadatas.some((m) => String(m.source).endsWith('.pdf'))).toBe(
      true,
    );

    const modelDir = modelDirIn(process.env.FAISS_INDEX_PATH!);
    const activeIndexPath = path.join(
      versionedIndexPathIn(process.env.FAISS_INDEX_PATH!),
      'faiss.index',
    );
    await fsp.mkdir(path.dirname(activeIndexPath), { recursive: true });
    await fsp.writeFile(activeIndexPath, 'mock faiss bytes', 'utf-8');
    const activeIndexStat = await fsp.stat(activeIndexPath);
    const { freshnessManifestPath, writeFreshnessManifest } = await import(
      './freshness-manifest.js'
    );
    await writeFreshnessManifest({
      modelId: DEFAULT_MODEL_ID,
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs: activeIndexStat.mtimeMs,
      filterConfig: {
        baseExtensions: ['.md', '.markdown', '.txt', '.rst', '.html', '.htm', '.pdf'],
        extraExtensions: [],
        excludePaths: [],
      },
    });

    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    delete process.env.INGEST_EXTRA_EXTENSIONS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const second = new FaissIndexManager();
    await second.initialize();
    await second.updateIndex();

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(fromTextsMock).not.toHaveBeenCalled();
    expect(addDocumentsMock).not.toHaveBeenCalled();
    await expect(fsp.stat(path.join(modelDir, 'index'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fsp.stat(versionedIndexPathIn(process.env.FAISS_INDEX_PATH!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(freshnessManifestPath(modelDir))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('ingests a `.html` file via the HTML loader (tags stripped before embedding)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-html-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    await fsp.mkdir(docsKb, { recursive: true });
    await fsp.writeFile(
      path.join(docsKb, 'guide.html'),
      `<html><body><h1>Quickstart</h1><p>Run <code>npm install</code> to begin.</p><script>alert(1)</script></body></html>`,
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INGEST_EXTRA_EXTENSIONS;
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { texts, metadatas } = collectIngestedDocs();
    const htmlMetadata = metadatas.find(
      (m) => String(m.source).endsWith('.html'),
    );
    expect(htmlMetadata).toMatchObject({ extension: '.html' });

    // html-to-text uppercases <h1> by default; assert case-insensitively.
    const htmlTexts = texts.filter((t) =>
      t.toLowerCase().includes('quickstart'),
    );
    expect(htmlTexts.length).toBeGreaterThan(0);
    const merged = htmlTexts.join('\n');
    expect(merged).toContain('npm install');
    expect(merged).not.toContain('<h1>');
    expect(merged).not.toContain('alert(1)');
  });

  it('skips a file with an unsupported extension (issue #46 — log + continue, no crash)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-skip-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    await fsp.mkdir(docsKb, { recursive: true });
    await fsp.writeFile(path.join(docsKb, 'note.md'), '# Hello\n\nBody.\n');
    // `.exe` is not in the base allowlist nor in INGEST_EXTRA_EXTENSIONS,
    // so the ingest filter must drop it before any loader sees it.
    await fsp.writeFile(path.join(docsKb, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0x90]));

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INGEST_EXTRA_EXTENSIONS;
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectIngestedDocs();
    const sources = new Set(metadatas.map((m) => String(m.source)));
    expect(sources.has(path.join(docsKb, 'note.md'))).toBe(true);
    expect(sources.has(path.join(docsKb, 'tool.exe'))).toBe(false);
  });

  it('mixed-extension KB: .md + opt-in .pdf + .html all ingest, dispatched by extension', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-mixed-'));
    const kbRoot = path.join(tempDir, 'kb');
    const docsKb = path.join(kbRoot, 'docs');
    await fsp.mkdir(docsKb, { recursive: true });
    await fsp.writeFile(path.join(docsKb, 'a.md'), '# Markdown\n\nMarkdown body.\n');
    await fsp.writeFile(
      path.join(docsKb, 'b.pdf'),
      Buffer.from('%PDF-1.4\n%placeholder'),
    );
    await fsp.writeFile(
      path.join(docsKb, 'c.html'),
      '<html><body><p>HTML body content.</p></body></html>',
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.pdf';
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectIngestedDocs();
    const extensions = new Set(metadatas.map((m) => String(m.extension)));
    expect(extensions.has('.md')).toBe(true);
    expect(extensions.has('.pdf')).toBe(true);
    expect(extensions.has('.html')).toBe(true);
  });
});

describe('liftFrontmatter (RFC 011 §5.4.2)', () => {
  it('lifts whitelisted keys verbatim and coerces relevance_score via parseInt', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const result = liftFrontmatter(
      {
        arxiv_id: '2604.21221',
        title: 'Sparse Forcing',
        authors: 'A, B, C',
        published: '2026-04-23',
        relevance_score: '7',
        ingested_at: '2026-04-24T22:42:27.567Z',
      },
      '/kb/notes/2604.21221.md',
    );
    expect(result).toEqual({
      arxiv_id: '2604.21221',
      title: 'Sparse Forcing',
      authors: 'A, B, C',
      published: '2026-04-23',
      relevance_score: 7,
      ingested_at: '2026-04-24T22:42:27.567Z',
    });
  });

  it('lifts the llm-as-judge whitelist keys', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const result = liftFrontmatter(
      {
        judge_method: 'single-LLM ref-free',
        metrics_used: 'sycophancy_rate',
        bias_handling: 'three-persona mix',
      },
      '/kb/notes/judge.md',
    );
    expect(result).toEqual({
      judge_method: 'single-LLM ref-free',
      metrics_used: 'sycophancy_rate',
      bias_handling: 'three-persona mix',
    });
  });

  it('lifts RFC005 lifecycle/search metadata through the safe allowlist', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const result = liftFrontmatter(
      {
        status: 'active',
        review_status: 'pending',
        contradicted_by: ['older-note.md', 'superseded-rfc.md'],
        manual_edits: 'false',
        promote_model: 'deterministic',
        tier: 'wisdom',
        confidence: '0.82',
        last_verified_at: '2026-05-09T01:02:03Z',
        private_token: 'SECRET_VALUE_XYZ',
      },
      '/kb/_wisdom/generated.md',
    );
    expect(result).toEqual({
      status: 'active',
      review_status: 'pending',
      contradicted_by: ['older-note.md', 'superseded-rfc.md'],
      manual_edits: false,
      promote_model: 'deterministic',
      tier: 'wisdom',
      confidence: 0.82,
      last_verified_at: '2026-05-09T01:02:03Z',
      extras: { private_token: 'SECRET_VALUE_XYZ' },
    });
  });

  it('omits invalid RFC005 lifecycle/search values from the allowlist', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const loggerModule = await import('./logger.js');
    const debugSpy = jest.spyOn(loggerModule.logger, 'debug').mockImplementation(() => {});

    const result = liftFrontmatter(
      {
        status: ['active'],
        contradicted_by: ['good.md', 42, ''],
        manual_edits: 'sometimes',
        confidence: 'high',
        last_verified_at: { nested: 'value' },
      },
      '/kb/_wisdom/generated.md',
    );
    expect(result).toEqual({ contradicted_by: ['good.md'] });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('non-string frontmatter key "status"'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('invalid boolean frontmatter key "manual_edits"'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('non-numeric confidence'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('non-string frontmatter key "last_verified_at"'));
    debugSpy.mockRestore();
  });

  it('routes non-whitelisted string keys into extras', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const result = liftFrontmatter(
      {
        arxiv_id: '2604.1',
        custom_field: 'value',
        another: 'x',
      },
      '/kb/notes/paper.md',
    );
    expect(result).toEqual({
      arxiv_id: '2604.1',
      extras: { custom_field: 'value', another: 'x' },
    });
  });

  it('drops relevance_score when non-numeric and logs at debug level', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const loggerModule = await import('./logger.js');
    const debugSpy = jest.spyOn(loggerModule.logger, 'debug').mockImplementation(() => {});

    const result = liftFrontmatter(
      { arxiv_id: '2604.1', relevance_score: 'high' },
      '/kb/notes/paper.md',
    );
    expect(result).toEqual({ arxiv_id: '2604.1' });
    const calls = debugSpy.mock.calls.flat().map((c) => String(c));
    expect(calls.some((m) => m.includes('non-numeric relevance_score'))).toBe(true);
    // Log must NOT echo the raw value — §5.4.2 leak rule. "high" is the
    // sentinel from the input above; assert it never appears in any log.
    for (const m of calls) expect(m).not.toContain('high');
    debugSpy.mockRestore();
  });

  it('drops non-string values and logs at debug level (YAML arrays, nested maps)', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const loggerModule = await import('./logger.js');
    const debugSpy = jest.spyOn(loggerModule.logger, 'debug').mockImplementation(() => {});

    const result = liftFrontmatter(
      {
        arxiv_id: '2604.1',
        // FAILSAFE preserves arrays and maps; neither is a whitelist target.
        metrics_list: ['a', 'b'],
        nested: { foo: 'bar' },
      },
      '/kb/notes/paper.md',
    );
    expect(result).toEqual({ arxiv_id: '2604.1' });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('non-string frontmatter key "metrics_list"'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('non-string frontmatter key "nested"'));
    debugSpy.mockRestore();
  });

  it('ignores `tags` — it is handled by the sibling metadata.tags field', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    const result = liftFrontmatter(
      { arxiv_id: '2604.1', tags: ['kv-cache'] },
      '/kb/notes/paper.md',
    );
    expect(result).toEqual({ arxiv_id: '2604.1' });
    // A result object with `tags` in it would be a duplicate-tags regression.
    expect(result && 'tags' in result).toBe(false);
  });

  it('returns undefined when the parsed frontmatter contains no liftable fields', async () => {
    const { liftFrontmatter } = await import('./frontmatter-lift.js');
    expect(liftFrontmatter({}, '/kb/notes/paper.md')).toBeUndefined();
    // Non-string-only input: everything dropped → undefined.
    expect(liftFrontmatter({ some_array: ['a'] }, '/kb/notes/paper.md')).toBeUndefined();
  });
});

describe('detectSiblingPdfPath (RFC 011 §5.3.4)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  };

  afterEach(() => {
    if (originalEnv.KNOWLEDGE_BASES_ROOT_DIR === undefined) {
      delete process.env.KNOWLEDGE_BASES_ROOT_DIR;
    } else {
      process.env.KNOWLEDGE_BASES_ROOT_DIR = originalEnv.KNOWLEDGE_BASES_ROOT_DIR;
    }
  });

  it('finds a sibling PDF in the arxiv notes/ + pdfs/ layout', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pdf-arxiv-'));
    const kbName = 'arxiv-llm-inference';
    const kbRoot = path.join(tempDir, kbName);
    await fsp.mkdir(path.join(kbRoot, 'notes'), { recursive: true });
    await fsp.mkdir(path.join(kbRoot, 'pdfs'), { recursive: true });
    await fsp.writeFile(path.join(kbRoot, 'notes', '2604.21221.md'), '# note');
    await fsp.writeFile(path.join(kbRoot, 'pdfs', '2604.21221.pdf'), Buffer.from('%PDF-'));

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    jest.resetModules();
    const { detectSiblingPdfPath } = await import('./frontmatter-lift.js');
    const result = detectSiblingPdfPath(
      path.join(kbRoot, 'notes', '2604.21221.md'),
      kbName,
    );
    expect(result).toBe('pdfs/2604.21221.pdf');
  });

  it('falls back to a same-directory sibling PDF', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pdf-samedir-'));
    const kbName = 'colocated';
    const kbRoot = path.join(tempDir, kbName);
    await fsp.mkdir(kbRoot, { recursive: true });
    await fsp.writeFile(path.join(kbRoot, 'paper.md'), '# note');
    await fsp.writeFile(path.join(kbRoot, 'paper.pdf'), Buffer.from('%PDF-'));

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    jest.resetModules();
    const { detectSiblingPdfPath } = await import('./frontmatter-lift.js');
    const result = detectSiblingPdfPath(path.join(kbRoot, 'paper.md'), kbName);
    expect(result).toBe('paper.pdf');
  });

  it('returns undefined when no sibling PDF exists at either location', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pdf-none-'));
    const kbName = 'no-pdfs';
    const kbRoot = path.join(tempDir, kbName);
    await fsp.mkdir(path.join(kbRoot, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(kbRoot, 'notes', 'paper.md'), '# note');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    jest.resetModules();
    const { detectSiblingPdfPath } = await import('./frontmatter-lift.js');
    const result = detectSiblingPdfPath(
      path.join(kbRoot, 'notes', 'paper.md'),
      kbName,
    );
    expect(result).toBeUndefined();
  });

  it('prefers the arxiv layout when both arxiv and same-dir siblings exist', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pdf-prefer-'));
    const kbName = 'preferred';
    const kbRoot = path.join(tempDir, kbName);
    await fsp.mkdir(path.join(kbRoot, 'notes'), { recursive: true });
    await fsp.mkdir(path.join(kbRoot, 'pdfs'), { recursive: true });
    await fsp.writeFile(path.join(kbRoot, 'notes', 'paper.md'), '# note');
    // Both candidates exist; the arxiv-layout one wins.
    await fsp.writeFile(
      path.join(kbRoot, 'pdfs', 'paper.pdf'),
      Buffer.from('%PDF-arxiv'),
    );
    await fsp.writeFile(
      path.join(kbRoot, 'notes', 'paper.pdf'),
      Buffer.from('%PDF-samedir'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    jest.resetModules();
    const { detectSiblingPdfPath } = await import('./frontmatter-lift.js');
    const result = detectSiblingPdfPath(
      path.join(kbRoot, 'notes', 'paper.md'),
      kbName,
    );
    expect(result).toBe('pdfs/paper.pdf');
  });

  it('returns undefined when the `.md` is at the KB root and only a sibling-KB `pdfs/` directory exists (no cross-KB bleed)', async () => {
    // A note at the KB root (no `notes/` subdir) would resolve the arxiv
    // probe `<dir>/../pdfs/<stem>.pdf` to `<KNOWLEDGE_BASES_ROOT_DIR>/pdfs/<stem>.pdf`
    // — a directory SIBLING to this KB, potentially a different KB entirely.
    // `pdf_path` on chunks must not reference cross-KB files; the helper
    // must reject any path that escapes the KB directory.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pdf-cross-kb-'));
    const kbName = 'my-kb';
    const kbRoot = path.join(tempDir, kbName);
    await fsp.mkdir(kbRoot, { recursive: true });
    // Place the .md at the KB root (not under notes/).
    await fsp.writeFile(path.join(kbRoot, 'paper.md'), '# note');

    // Plant a `pdfs/` SIBLING to the KB — this would be picked up by a
    // naive arxiv probe that walks `../pdfs/` from the .md's directory.
    const siblingPdfsDir = path.join(tempDir, 'pdfs');
    await fsp.mkdir(siblingPdfsDir, { recursive: true });
    await fsp.writeFile(path.join(siblingPdfsDir, 'paper.pdf'), Buffer.from('%PDF-cross'));

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    jest.resetModules();
    const { detectSiblingPdfPath } = await import('./frontmatter-lift.js');
    const result = detectSiblingPdfPath(
      path.join(kbRoot, 'paper.md'),
      kbName,
    );
    // Arxiv probe points outside the KB → rejected. Same-dir fallback
    // finds no in-KB `paper.pdf` → returns undefined.
    expect(result).toBeUndefined();
  });
});

describe('FaissIndexManager integration — frontmatter + pdf_path (RFC 011 M2)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    INGEST_EXTRA_EXTENSIONS: process.env.INGEST_EXTRA_EXTENSIONS,
    INGEST_EXCLUDE_PATHS: process.env.INGEST_EXCLUDE_PATHS,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  function collectChunks(): {
    texts: string[];
    metadatas: Record<string, unknown>[];
  } {
    const texts: string[] = [];
    const metadatas: Record<string, unknown>[] = [];
    for (const call of fromTextsMock.mock.calls) {
      const [t, m] = call as [string[], Record<string, unknown>[]];
      texts.push(...t);
      metadatas.push(...m);
    }
    for (const call of addDocumentsMock.mock.calls) {
      const [docs] = call as [
        Array<{ pageContent: string; metadata: Record<string, unknown> }>,
      ];
      for (const doc of docs) {
        texts.push(doc.pageContent);
        metadatas.push(doc.metadata);
      }
    }
    return { texts, metadatas };
  }

  it('attaches lifted frontmatter + pdf_path on an arxiv-shaped KB', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-m2-arxiv-'));
    const kbRoot = path.join(tempDir, 'kb');
    const arxivKb = path.join(kbRoot, 'arxiv-llm-inference');
    await fsp.mkdir(path.join(arxivKb, 'notes'), { recursive: true });
    await fsp.mkdir(path.join(arxivKb, 'pdfs'), { recursive: true });
    await fsp.writeFile(
      path.join(arxivKb, 'notes', '2604.21221.md'),
      '---\n' +
        'arxiv_id: 2604.21221\n' +
        'title: "Sparse Forcing"\n' +
        'authors: "A, B"\n' +
        'published: 2026-04-23\n' +
        'relevance_score: 7\n' +
        'tags: [kv-cache, quantization]\n' +
        'ingested_at: 2026-04-24T22:42:27.567Z\n' +
        '---\n' +
        '# Body\n\nReal paper content.\n',
    );
    await fsp.writeFile(
      path.join(arxivKb, 'pdfs', '2604.21221.pdf'),
      Buffer.from('%PDF-binary'),
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    delete process.env.INGEST_EXTRA_EXTENSIONS;
    delete process.env.INGEST_EXCLUDE_PATHS;

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectChunks();
    expect(metadatas.length).toBeGreaterThan(0);
    for (const md of metadatas) {
      expect(md.tags).toEqual(['kv-cache', 'quantization']);
      expect(md.frontmatter).toEqual({
        arxiv_id: '2604.21221',
        title: 'Sparse Forcing',
        authors: 'A, B',
        published: '2026-04-23',
        relevance_score: 7, // coerced from "7"
        ingested_at: '2026-04-24T22:42:27.567Z',
      });
      expect(md.pdf_path).toBe('pdfs/2604.21221.pdf');
    }
  });

  it('omits pdf_path when no sibling PDF exists', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-m2-nopdf-'));
    const kbRoot = path.join(tempDir, 'kb');
    const kb = path.join(kbRoot, 'no-pdf-kb');
    await fsp.mkdir(path.join(kb, 'notes'), { recursive: true });
    await fsp.writeFile(
      path.join(kb, 'notes', 'paper.md'),
      '---\narxiv_id: 2604.99\n---\n# Body\n',
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectChunks();
    for (const md of metadatas) {
      expect(md.pdf_path).toBeUndefined();
      expect(md.frontmatter).toEqual({ arxiv_id: '2604.99' });
    }
  });

  it('routes non-whitelisted frontmatter into frontmatter.extras', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-m2-extras-'));
    const kbRoot = path.join(tempDir, 'kb');
    const kb = path.join(kbRoot, 'kb');
    await fsp.mkdir(kb, { recursive: true });
    await fsp.writeFile(
      path.join(kb, 'paper.md'),
      '---\narxiv_id: 2604.1\nsentinel_key: SECRET_VALUE_XYZ\n---\n# Body\n',
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();

    const { metadatas } = collectChunks();
    expect(metadatas.length).toBeGreaterThan(0);
    for (const md of metadatas) {
      expect(md.frontmatter).toEqual({
        arxiv_id: '2604.1',
        extras: { sentinel_key: 'SECRET_VALUE_XYZ' },
      });
    }
  });
});

describe('FaissIndexManager similaritySearch metadata filters (#53)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  // The mock FaissStore exposes ntotal() unconditionally — the real one is set
  // up by FaissStore.fromTexts. Patch it on the instance after updateIndex.
  async function setupReadyManager() {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-filters-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nContent for filter tests.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    // Provide ntotal() so the over-fetch branch (scoped or filtered) doesn't
    // crash on undefined.index. The real FaissStore exposes this; the mock
    // does not, so wire the minimum surface the implementation reads.
    loadedFaissStore(manager).index = {
      ntotal: () => 100,
      getDimension: () => 2,
    };
    return manager;
  }

  it('returns only chunks whose extension is in the extensions filter', async () => {
    const manager = await setupReadyManager();
    const md = { pageContent: 'm', metadata: { source: '/abs/a.md', extension: '.md', relativePath: 'kb/a.md' } };
    const pdf = { pageContent: 'p', metadata: { source: '/abs/a.pdf', extension: '.pdf', relativePath: 'kb/a.pdf' } };
    similaritySearchMock.mockResolvedValueOnce([
      [md, 0.1],
      [pdf, 0.2],
    ]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: ['.md'],
    });

    expect(results.map((r) => r.pageContent)).toEqual(['m']);
  });

  it('extensions filter is case-insensitive and tolerates missing leading dot', async () => {
    const manager = await setupReadyManager();
    const md = { pageContent: 'm', metadata: { extension: '.md', relativePath: 'kb/a.md' } };
    const txt = { pageContent: 't', metadata: { extension: '.txt', relativePath: 'kb/a.txt' } };
    similaritySearchMock.mockResolvedValueOnce([
      [md, 0.1],
      [txt, 0.2],
    ]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: ['MD'],
    });

    expect(results.map((r) => r.pageContent)).toEqual(['m']);
  });

  it('drops every result when no chunk matches the extensions filter', async () => {
    const manager = await setupReadyManager();
    const md = { pageContent: 'm', metadata: { extension: '.md', relativePath: 'kb/a.md' } };
    similaritySearchMock.mockResolvedValueOnce([[md, 0.1]]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: ['.pdf'],
    });

    expect(results).toEqual([]);
  });

  it('path_glob matches the in-KB relative path (KB-name segment stripped)', async () => {
    const manager = await setupReadyManager();
    const runbook = {
      pageContent: 'on',
      metadata: { extension: '.md', relativePath: 'ops/runbooks/oncall.md' },
    };
    const meeting = {
      pageContent: 'mt',
      metadata: { extension: '.md', relativePath: 'ops/meetings/standup.md' },
    };
    similaritySearchMock.mockResolvedValueOnce([
      [runbook, 0.1],
      [meeting, 0.2],
    ]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      pathGlob: 'runbooks/**',
    });

    expect(results.map((r) => r.pageContent)).toEqual(['on']);
  });

  it('path_glob also matches against the full KB-prefixed relativePath', async () => {
    const manager = await setupReadyManager();
    const a = { pageContent: 'a', metadata: { relativePath: 'alpha/notes/x.md', extension: '.md' } };
    const b = { pageContent: 'b', metadata: { relativePath: 'beta/notes/y.md', extension: '.md' } };
    similaritySearchMock.mockResolvedValueOnce([
      [a, 0.1],
      [b, 0.2],
    ]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      pathGlob: 'alpha/**',
    });

    expect(results.map((r) => r.pageContent)).toEqual(['a']);
  });

  it('tags filter requires every tag (AND semantics)', async () => {
    const manager = await setupReadyManager();
    const both = {
      pageContent: 'both',
      metadata: { tags: ['ops', 'oncall'], extension: '.md', relativePath: 'kb/a.md' },
    };
    const opsOnly = {
      pageContent: 'opsOnly',
      metadata: { tags: ['ops'], extension: '.md', relativePath: 'kb/b.md' },
    };
    const noTags = {
      pageContent: 'noTags',
      metadata: { tags: [], extension: '.md', relativePath: 'kb/c.md' },
    };
    similaritySearchMock.mockResolvedValueOnce([
      [both, 0.1],
      [opsOnly, 0.2],
      [noTags, 0.3],
    ]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      tags: ['ops', 'oncall'],
    });

    expect(results.map((r) => r.pageContent)).toEqual(['both']);
  });

  it('tags filter rejects chunks with no tags array on metadata', async () => {
    const manager = await setupReadyManager();
    const noTagField = {
      pageContent: 'x',
      metadata: { extension: '.md', relativePath: 'kb/a.md' },
    };
    similaritySearchMock.mockResolvedValueOnce([[noTagField, 0.1]]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      tags: ['ops'],
    });

    expect(results).toEqual([]);
  });

  it('combined filters AND together: extension + path_glob + tags', async () => {
    const manager = await setupReadyManager();
    const match = {
      pageContent: 'match',
      metadata: {
        extension: '.md',
        relativePath: 'kb/runbooks/oncall.md',
        tags: ['ops', 'oncall'],
      },
    };
    const wrongExt = {
      pageContent: 'wrongExt',
      metadata: {
        extension: '.txt',
        relativePath: 'kb/runbooks/oncall.txt',
        tags: ['ops', 'oncall'],
      },
    };
    const wrongPath = {
      pageContent: 'wrongPath',
      metadata: {
        extension: '.md',
        relativePath: 'kb/meetings/standup.md',
        tags: ['ops', 'oncall'],
      },
    };
    const missingTag = {
      pageContent: 'missingTag',
      metadata: {
        extension: '.md',
        relativePath: 'kb/runbooks/oncall.md',
        tags: ['ops'],
      },
    };
    similaritySearchMock.mockResolvedValueOnce([
      [match, 0.1],
      [wrongExt, 0.15],
      [wrongPath, 0.2],
      [missingTag, 0.25],
    ]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: ['.md'],
      pathGlob: 'runbooks/**',
      tags: ['ops', 'oncall'],
    });

    expect(results.map((r) => r.pageContent)).toEqual(['match']);
  });

  it('empty filter arrays are treated as absent and do not exclude every chunk', async () => {
    const manager = await setupReadyManager();
    const a = { pageContent: 'a', metadata: { extension: '.md', relativePath: 'kb/a.md', tags: [] } };
    similaritySearchMock.mockResolvedValueOnce([[a, 0.1]]);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: [],
      tags: [],
    });

    expect(results.map((r) => r.pageContent)).toEqual(['a']);
  });

  it('end-to-end: ingest reads YAML frontmatter tags, then tags filter selects chunks at search time', async () => {
    // Real ingest path through buildChunkDocuments: frontmatter is parsed,
    // tags land on every chunk's metadata, the post-filter then selects.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-filters-e2e-'));
    const kbDir = path.join(tempDir, 'kb');
    const kb = path.join(kbDir, 'mixed');
    await fsp.mkdir(kb, { recursive: true });
    await fsp.writeFile(
      path.join(kb, 'tagged.md'),
      '---\ntags: [ops, oncall]\n---\n# Title\n\nOncall runbook content.\n',
    );
    await fsp.writeFile(
      path.join(kb, 'untagged.md'),
      '# Untagged\n\nGeneric notes without frontmatter.\n',
    );

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    loadedFaissStore(manager).index = {
      ntotal: () => 100,
      getDimension: () => 2,
    };

    // Capture the metadata that ingest stamped on the chunks for both files;
    // feed those exact objects back via the FAISS mock so the post-filter
    // sees the real shape produced by buildChunkDocuments.
    const taggedChunks: Array<{ pageContent: string; metadata: Record<string, unknown> }> = [];
    const untaggedChunks: Array<{ pageContent: string; metadata: Record<string, unknown> }> = [];
    for (const call of fromTextsMock.mock.calls) {
      const [texts, metadatas] = call as [string[], Record<string, unknown>[]];
      for (let i = 0; i < texts.length; i += 1) {
        const target = (metadatas[i].source as string).endsWith('/tagged.md') ? taggedChunks : untaggedChunks;
        target.push({ pageContent: texts[i], metadata: metadatas[i] });
      }
    }
    for (const call of addDocumentsMock.mock.calls) {
      const [docs] = call as [Array<{ pageContent: string; metadata: Record<string, unknown> }>];
      for (const d of docs) {
        const target = (d.metadata.source as string).endsWith('/tagged.md') ? taggedChunks : untaggedChunks;
        target.push(d);
      }
    }
    expect(taggedChunks.length).toBeGreaterThan(0);
    expect(untaggedChunks.length).toBeGreaterThan(0);
    expect(taggedChunks[0].metadata.tags).toEqual(['ops', 'oncall']);
    expect(untaggedChunks[0].metadata.tags).toEqual([]);

    similaritySearchMock.mockResolvedValueOnce([
      [taggedChunks[0], 0.1],
      [untaggedChunks[0], 0.2],
    ]);
    const tagged = await manager.similaritySearch('q', 10, undefined, undefined, { tags: ['ops'] });
    expect(tagged).toHaveLength(1);
    expect((tagged[0].metadata as { source: string }).source).toMatch(/\/tagged\.md$/);

    similaritySearchMock.mockResolvedValueOnce([
      [taggedChunks[0], 0.1],
      [untaggedChunks[0], 0.2],
    ]);
    const md = await manager.similaritySearch('q', 10, undefined, undefined, { extensions: ['.md'] });
    expect(md.map((r) => (r.metadata as { source: string }).source).sort()).toEqual(
      [taggedChunks[0].metadata.source, untaggedChunks[0].metadata.source].sort(),
    );
  });
});

describe('progressiveFetchSizes (#229)', () => {
  let progressiveFetchSizes: (k: number, ntotal: number) => number[];

  beforeAll(async () => {
    jest.resetModules();
    ({ progressiveFetchSizes } = await import('./FaissIndexManager.js'));
  });

  it('returns [ntotal] when the floor window already meets or exceeds ntotal', () => {
    expect(progressiveFetchSizes(10, 5)).toEqual([5]);
    expect(progressiveFetchSizes(10, 19)).toEqual([19]);
    expect(progressiveFetchSizes(10, 20)).toEqual([20]);
  });

  it('emits the geometric ladder for typical k=10 and large ntotal', () => {
    expect(progressiveFetchSizes(10, 1000)).toEqual([20, 40, 160, 1000]);
  });

  it('collapses rungs that meet or exceed ntotal so the sequence stays monotonic', () => {
    expect(progressiveFetchSizes(10, 100)).toEqual([20, 40, 100]);
    expect(progressiveFetchSizes(10, 50)).toEqual([20, 40, 50]);
    expect(progressiveFetchSizes(10, 30)).toEqual([20, 30]);
  });

  it('keeps a floor of 20 even when k is very small', () => {
    expect(progressiveFetchSizes(1, 1000)).toEqual([20, 1000]);
    expect(progressiveFetchSizes(2, 1000)).toEqual([20, 32, 1000]);
  });

  it('drops duplicate rungs when 4*k equals the floor', () => {
    // k=5: max(k,20)=20, 4k=20 (duplicate), 16k=80. Expect [20, 80, ntotal].
    expect(progressiveFetchSizes(5, 1000)).toEqual([20, 80, 1000]);
  });

  it('caps the whole ladder at ntotal when k itself exceeds ntotal', () => {
    expect(progressiveFetchSizes(1000, 100)).toEqual([100]);
  });

  it('returns [] when ntotal is zero so the caller can short-circuit', () => {
    expect(progressiveFetchSizes(10, 0)).toEqual([]);
  });
});

describe('FaissIndexManager progressive overfetch (#229)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  async function setupManagerWithNtotal(ntotal: number) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-overfetch-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nProgressive overfetch fixture.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    loadedFaissStore(manager).index = {
      ntotal: () => ntotal,
      getDimension: () => 2,
    };
    return manager;
  }

  it('unfiltered search makes a single FAISS call with fetchK = k', async () => {
    const manager = await setupManagerWithNtotal(500);
    const doc = { pageContent: 'a', metadata: { source: 'a' } };
    similaritySearchMock.mockResolvedValueOnce([[doc, 0.1]]);

    const results = await manager.similaritySearch('q', 10);

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 10);
    expect(results).toHaveLength(1);
  });

  it('filtered search terminates after the first window when it yields ≥ k hits', async () => {
    const manager = await setupManagerWithNtotal(1000);
    // First window is fetchK = max(k=5, 20) = 20. Return 20 items, 6 of which
    // satisfy the .md filter — more than enough for k=5, so no expansion.
    const mdHits: Array<[unknown, number]> = Array.from({ length: 6 }, (_, i) => [
      { pageContent: `m${i}`, metadata: { extension: '.md', relativePath: `kb/m${i}.md` } },
      0.1 + i * 0.01,
    ]);
    const pdfPad: Array<[unknown, number]> = Array.from({ length: 14 }, (_, i) => [
      { pageContent: `p${i}`, metadata: { extension: '.pdf', relativePath: `kb/p${i}.pdf` } },
      0.2 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce([...mdHits, ...pdfPad]);

    const results = await manager.similaritySearch('q', 5, undefined, undefined, {
      extensions: ['.md'],
    });

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results.map((r) => r.pageContent)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('expands the fetch window when the first window starves the filter', async () => {
    const manager = await setupManagerWithNtotal(1000);
    // Ladder for k=2: [max(k,20)=20, 16k=32, 1000]. The 4k rung collapses
    // because 4*2 sits below the floor of 20.
    // Window 1 (fetchK=20): 20 .pdf items, 0 matches. raw.length == fetchK so
    // we cannot short-circuit on exhaustion; loop must move to window 2.
    const noMatches: Array<[unknown, number]> = Array.from({ length: 20 }, (_, i) => [
      { pageContent: `p${i}`, metadata: { extension: '.pdf', relativePath: `kb/p${i}.pdf` } },
      0.1 + i * 0.01,
    ]);
    // Window 2 (fetchK=32): the last 3 items are .md, so the filter clears k=2.
    const wider: Array<[unknown, number]> = Array.from({ length: 32 }, (_, i) => {
      const isMd = i >= 29;
      return [
        {
          pageContent: isMd ? `m${i - 29}` : `p${i}`,
          metadata: {
            extension: isMd ? '.md' : '.pdf',
            relativePath: isMd ? `kb/m${i - 29}.md` : `kb/p${i}.pdf`,
          },
        },
        0.1 + i * 0.01,
      ];
    });
    similaritySearchMock.mockResolvedValueOnce(noMatches);
    similaritySearchMock.mockResolvedValueOnce(wider);

    const results = await manager.similaritySearch('q', 2, undefined, undefined, {
      extensions: ['.md'],
    });

    expect(similaritySearchMock).toHaveBeenCalledTimes(2);
    expect(similaritySearchMock).toHaveBeenNthCalledWith(1, 'q', 20);
    expect(similaritySearchMock).toHaveBeenNthCalledWith(2, 'q', 32);
    expect(results.map((r) => r.pageContent)).toEqual(['m0', 'm1']);
  });

  it('stops early when FAISS returns fewer items than the requested window', async () => {
    // ntotal=1000 from the patched index, but the live docstore only has 12
    // chunks for this query. raw.length < fetchK should short-circuit the
    // loop on the first call — no extra rungs even though the filter starves.
    const manager = await setupManagerWithNtotal(1000);
    const items: Array<[unknown, number]> = Array.from({ length: 12 }, (_, i) => [
      { pageContent: `p${i}`, metadata: { extension: '.pdf', relativePath: `kb/p${i}.pdf` } },
      0.1 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce(items);

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: ['.md'],
    });

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results).toEqual([]);
  });

  it('worst case: matches buried late still surface via the ntotal fallback rung', async () => {
    // ntotal=50, k=10 → ladder = [20, 40, 50]. The needle sits at index 45,
    // which only the final rung can reach. Simulate FAISS returning the top
    // `fetchK` items by score order.
    const manager = await setupManagerWithNtotal(50);
    const items: Array<[unknown, number]> = Array.from({ length: 50 }, (_, i) => {
      const isMatch = i === 45;
      return [
        {
          pageContent: isMatch ? 'needle' : `p${i}`,
          metadata: {
            extension: isMatch ? '.md' : '.pdf',
            relativePath: isMatch ? 'kb/needle.md' : `kb/p${i}.pdf`,
          },
        },
        0.1 + i * 0.001,
      ];
    });
    similaritySearchMock.mockImplementation(async (...args: unknown[]) => {
      const fetchK = args[1] as number;
      return items.slice(0, Math.min(fetchK, items.length));
    });

    const results = await manager.similaritySearch('q', 10, undefined, undefined, {
      extensions: ['.md'],
    });

    expect(similaritySearchMock).toHaveBeenCalledTimes(3);
    expect(similaritySearchMock).toHaveBeenNthCalledWith(1, 'q', 20);
    expect(similaritySearchMock).toHaveBeenNthCalledWith(2, 'q', 40);
    expect(similaritySearchMock).toHaveBeenNthCalledWith(3, 'q', 50);
    expect(results.map((r) => r.pageContent)).toEqual(['needle']);
  });

  it('scoped search uses progressive overfetch even without metadata filters', async () => {
    const manager = await setupManagerWithNtotal(1000);
    const inScope: Array<[unknown, number]> = Array.from({ length: 4 }, (_, i) => [
      {
        pageContent: `s${i}`,
        metadata: {
          source: `${process.env.KNOWLEDGE_BASES_ROOT_DIR}/scoped/file${i}.md`,
          extension: '.md',
        },
      },
      0.1 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce(inScope);

    const results = await manager.similaritySearch('q', 10, undefined, 'scoped');

    // First rung is 20. Result count is 4 → less than k=10, but raw.length=4
    // < fetchK=20 means FAISS is exhausted, so we stop after one call.
    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results.map((r) => r.pageContent)).toEqual(['s0', 's1', 's2', 's3']);
  });
});

describe('FaissIndexManager.findChunkByReference', () => {
  it('finds an indexed chunk by public chunk id or kb:// URI', async () => {
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { parseChunkReference } = await import('./chunk-id.js');
    const manager = new FaissIndexManager({
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
    });
    const docs = new Map([
      ['0', {
        pageContent: 'first chunk',
        metadata: {
          knowledgeBase: 'alpha',
          relativePath: 'alpha/docs/deploy.md',
          loc: { lines: { from: 1, to: 4 } },
          chunkIndex: 0,
        },
      }],
      ['1', {
        pageContent: 'second chunk',
        metadata: {
          knowledgeBase: 'alpha',
          relativePath: 'alpha/docs/deploy.md',
          loc: { lines: { from: 5, to: 8 } },
          chunkIndex: 1,
        },
      }],
    ]);
    await setLoadedFaissStore(manager, { docstore: { _docs: docs } });

    expect(manager.findChunkByReference(parseChunkReference('alpha/docs/deploy.md#L5-L8'))?.pageContent)
      .toBe('second chunk');
    expect(manager.findChunkByReference(parseChunkReference('kb://alpha/docs/deploy.md#L1-L4'))?.pageContent)
      .toBe('first chunk');
    expect(manager.findChunkByReference(parseChunkReference('kb://alpha/docs/deploy.md'))?.pageContent)
      .toBe('first chunk');
  });
});

describe('FaissIndexManager neighbor context expansion', () => {
  it('adds adjacent chunks from the same source while keeping the semantic match distinct', async () => {
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager({
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
    });
    const docs = new Map([
      ['0', { pageContent: 'before', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 0 } }],
      ['1', { pageContent: 'match', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 1 } }],
      ['2', { pageContent: 'after', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 2 } }],
      ['other', { pageContent: 'wrong source', metadata: { knowledgeBase: 'kb', source: '/kb/other.md', chunkIndex: 0 } }],
    ]);
    await setLoadedFaissStore(manager, { docstore: { _docs: docs } });

    const expanded = manager.expandWithNeighborContext([
      {
        pageContent: 'match',
        metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 1 },
        score: 0.12,
      },
    ], { before: 1, after: 1 });

    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      pageContent: 'match',
      score: 0.12,
      matchType: 'semantic',
      semanticMatch: true,
    });
    expect(expanded[0].contextChunks?.map((chunk) => ({
      content: chunk.pageContent,
      type: chunk.matchType,
      semantic: chunk.semanticMatch,
      direction: chunk.contextDirection,
    }))).toEqual([
      { content: 'before', type: 'context', semantic: false, direction: 'before' },
      { content: 'after', type: 'context', semantic: false, direction: 'after' },
    ]);
  });

  it('deduplicates overlapping context and never reclassifies another semantic match as context', async () => {
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager({
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
    });
    const docs = new Map([
      ['0', { pageContent: 'zero', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 0 } }],
      ['1', { pageContent: 'one', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 1 } }],
      ['2', { pageContent: 'two', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 2 } }],
      ['3', { pageContent: 'three', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 3 } }],
    ]);
    await setLoadedFaissStore(manager, { docstore: { _docs: docs } });

    const expanded = manager.expandWithNeighborContext([
      {
        pageContent: 'one',
        metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 1 },
        score: 0.1,
      },
      {
        pageContent: 'two',
        metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 2 },
        score: 0.2,
      },
    ], { before: 1, after: 1 });

    expect(expanded.map((result) => result.pageContent)).toEqual(['one', 'two']);
    expect(expanded[0].contextChunks?.map((chunk) => chunk.pageContent)).toEqual(['zero']);
    expect(expanded[1].contextChunks?.map((chunk) => chunk.pageContent)).toEqual(['three']);
  });

  it('caps context chunks per response', async () => {
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager({
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
    });
    const docs = new Map([
      ['0', { pageContent: 'zero', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 0 } }],
      ['1', { pageContent: 'one', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 1 } }],
      ['2', { pageContent: 'two', metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 2 } }],
    ]);
    await setLoadedFaissStore(manager, { docstore: { _docs: docs } });

    const expanded = manager.expandWithNeighborContext([
      {
        pageContent: 'one',
        metadata: { knowledgeBase: 'kb', source: '/kb/doc.md', chunkIndex: 1 },
        score: 0.1,
      },
    ], { before: 1, after: 1, maxContextChunks: 1 });

    expect(expanded[0].contextChunks?.map((chunk) => chunk.pageContent)).toEqual(['zero']);
    expect(expanded[0].contextTruncated).toBe(true);
  });
});

describe('FaissIndexManager predicate-pushdown sidecar (#283)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  };

  beforeEach(() => {
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();
    similaritySearchMock.mockReset();
    embeddingConstructorMock.mockReset();
  });

  afterEach(() => {
    const keys = Object.keys(originalEnv) as Array<keyof typeof originalEnv>;
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  // The progressive-overfetch suite above patches the loaded mock store's
  // index to fake an arbitrary `ntotal`. We layer a sidecar on top of that
  // by writing the JSONL file directly to the per-model directory; the
  // manager's `loadMetadataSidecar` then sees a populated, non-stale
  // sidecar and the fast-path can fire.
  async function setupManagerWithSidecar(opts: {
    ntotal: number;
    rows: Array<{
      docstoreId: string;
      knowledgeBase: string;
      source: string;
      relativePath: string;
      extension: string;
      tags?: string[];
      frontmatter?: Record<string, string>;
    }>;
  }) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sidecar-fast-path-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nSidecar fast-path fixture.');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const { writeMetadataSidecar, METADATA_SIDECAR_FILENAME } = await import('./metadata-sidecar.js');

    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    loadedFaissStore(manager).index = {
      ntotal: () => opts.ntotal,
      getDimension: () => 2,
    };

    const sidecarPath = path.join(tempDir, '.faiss', 'models', DEFAULT_MODEL_ID, METADATA_SIDECAR_FILENAME);
    await writeMetadataSidecar({
      sidecarPath,
      modelId: DEFAULT_MODEL_ID,
      rows: opts.rows.map((row) => ({
        docstoreId: row.docstoreId,
        knowledgeBase: row.knowledgeBase,
        source: row.source,
        relativePath: row.relativePath,
        extension: row.extension,
        tags: row.tags ?? [],
        frontmatter: row.frontmatter,
      })),
    });
    (manager as { __resetMetadataSidecarCacheForTests?: () => void })
      .__resetMetadataSidecarCacheForTests?.();
    return { manager, tempDir, sidecarPath };
  }

  it('short-circuits to the empty result when no sidecar row matches the filter (no FAISS call)', async () => {
    const { manager } = await setupManagerWithSidecar({
      ntotal: 200,
      rows: Array.from({ length: 200 }, (_, i) => ({
        docstoreId: String(i),
        knowledgeBase: 'docs',
        source: `/kb/docs/file${i}.md`,
        relativePath: `docs/file${i}.md`,
        extension: '.md',
      })),
    });

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      10,
      undefined,
      undefined,
      { extensions: ['.txt'] },
      timing,
    );

    expect(results).toEqual([]);
    expect(similaritySearchMock).not.toHaveBeenCalled();
    expect(timing.sidecar_fast_path).toBe('short_circuit');
    expect(timing.sidecar_candidates).toBe(0);
    expect(timing.post_filter_kept).toBe(0);
  });

  it('runs a single FAISS search at the targeted fetchK when the filter is highly selective', async () => {
    // 100 .md+ops chunks out of 10_000 = 1% selectivity. The sidecar has
    // a row per docstore vector so the header total matches the live
    // ntotal; the fast-path picks a rung sized to the candidate count and
    // returns as soon as it satisfies k.
    const candidateCount = 100;
    const { manager } = await setupManagerWithSidecar({
      ntotal: 10_000,
      rows: Array.from({ length: 10_000 }, (_, i) => {
        const isCandidate = i < candidateCount;
        return {
          docstoreId: String(i),
          knowledgeBase: 'docs',
          source: isCandidate ? `/kb/docs/runbook${i}.md` : `/kb/docs/other${i}.pdf`,
          relativePath: isCandidate ? `docs/runbooks/runbook${i}.md` : `docs/other${i}.pdf`,
          extension: isCandidate ? '.md' : '.pdf',
          tags: isCandidate ? ['ops'] : ['misc'],
        };
      }),
    });

    similaritySearchMock.mockImplementation(async (...args: unknown[]) => {
      const fetchK = args[1] as number;
      // Half the returned results match the filter so k=10 is satisfied.
      const out: Array<[unknown, number]> = [];
      for (let i = 0; i < fetchK; i += 1) {
        out.push([
          {
            pageContent: `r${i}`,
            metadata: i % 2 === 0
              ? { extension: '.md', tags: ['ops'], relativePath: `docs/runbooks/r${i}.md` }
              : { extension: '.pdf', tags: ['ops'], relativePath: `docs/r${i}.pdf` },
          },
          0.1 + i * 0.0001,
        ]);
      }
      return out;
    });

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      10,
      undefined,
      undefined,
      { extensions: ['.md'], tags: ['ops'] },
      timing,
    );

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(10);
    expect(timing.sidecar_fast_path).toBe('hit');
    expect(timing.sidecar_candidates).toBe(100);
    // The fast-path requested far less than ntotal (which the post-filter
    // ladder would walk up to in the worst case).
    const callArgs = similaritySearchMock.mock.calls[0];
    expect(timing.post_filter_kept).toBe((callArgs[1] as number) / 2);
    expect(callArgs[1]).toBeLessThan(10_000);
  });

  it('falls back to the progressive overfetch ladder when the filter is too broad', async () => {
    // 800 of 1000 chunks match → selectivity 80%, above the SELECTIVITY_CEILING.
    // fast-path declines (timing reports 'unused') and the existing #229 ladder
    // runs unchanged. Rows total matches ntotal so the sidecar is not stale.
    const { manager } = await setupManagerWithSidecar({
      ntotal: 1000,
      rows: [
        ...Array.from({ length: 800 }, (_, i) => ({
          docstoreId: String(i),
          knowledgeBase: 'docs',
          source: `/kb/docs/m${i}.md`,
          relativePath: `docs/m${i}.md`,
          extension: '.md',
        })),
        ...Array.from({ length: 200 }, (_, i) => ({
          docstoreId: String(800 + i),
          knowledgeBase: 'docs',
          source: `/kb/docs/p${i}.pdf`,
          relativePath: `docs/p${i}.pdf`,
          extension: '.pdf',
        })),
      ],
    });

    const mdHits: Array<[unknown, number]> = Array.from({ length: 6 }, (_, i) => [
      { pageContent: `m${i}`, metadata: { extension: '.md', relativePath: `docs/m${i}.md` } },
      0.1 + i * 0.01,
    ]);
    const pdfPad: Array<[unknown, number]> = Array.from({ length: 14 }, (_, i) => [
      { pageContent: `p${i}`, metadata: { extension: '.pdf', relativePath: `docs/p${i}.pdf` } },
      0.2 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce([...mdHits, ...pdfPad]);

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      5,
      undefined,
      undefined,
      { extensions: ['.md'] },
      timing,
    );

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results).toHaveLength(5);
    expect(timing.sidecar_fast_path).toBe('unused');
    expect(timing.post_filter_kept).toBe(6);
  });

  it('falls back to the post-filter ladder when the sidecar is missing entirely', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sidecar-missing-'));
    const kbDir = path.join(tempDir, 'kb');
    const defaultKb = path.join(kbDir, 'default');
    await fsp.mkdir(defaultKb, { recursive: true });
    await fsp.writeFile(path.join(defaultKb, 'doc.md'), '# Title\n\nMissing sidecar fixture.');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex();
    loadedFaissStore(manager).index = {
      ntotal: () => 1000,
      getDimension: () => 2,
    };
    // The mock store has no docstore, so refreshMetadataSidecar threw and
    // no JSONL was persisted. This is exactly the on-disk "no sidecar" state.

    const mdHits: Array<[unknown, number]> = Array.from({ length: 6 }, (_, i) => [
      { pageContent: `m${i}`, metadata: { extension: '.md', relativePath: `kb/m${i}.md` } },
      0.1 + i * 0.01,
    ]);
    const pad: Array<[unknown, number]> = Array.from({ length: 14 }, (_, i) => [
      { pageContent: `p${i}`, metadata: { extension: '.pdf', relativePath: `kb/p${i}.pdf` } },
      0.2 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce([...mdHits, ...pad]);

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      5,
      undefined,
      undefined,
      { extensions: ['.md'] },
      timing,
    );

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results).toHaveLength(5);
    expect(timing.sidecar_fast_path).toBe('missing');
  });

  it('ignores the active-model sidecar after loading a historical version directory', async () => {
    const { manager, tempDir } = await setupManagerWithSidecar({
      ntotal: 200,
      rows: Array.from({ length: 200 }, (_, i) => ({
        docstoreId: String(i),
        knowledgeBase: 'docs',
        source: `/kb/docs/file${i}.md`,
        relativePath: `docs/file${i}.md`,
        extension: '.md',
      })),
    });
    const versionDir = path.join(tempDir, 'historical', 'index.v1');
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(path.join(versionDir, 'faiss.index'), 'mock-index');
    await fsp.writeFile(path.join(versionDir, 'docstore.json'), '{}');

    await manager.loadFromVersionDir(versionDir);
    loadedFaissStore(manager).index = {
      ntotal: () => 200,
      getDimension: () => 2,
    };

    const txtHits: Array<[unknown, number]> = Array.from({ length: 6 }, (_, i) => [
      { pageContent: `t${i}`, metadata: { extension: '.txt', relativePath: `docs/t${i}.txt` } },
      0.1 + i * 0.01,
    ]);
    const pad: Array<[unknown, number]> = Array.from({ length: 14 }, (_, i) => [
      { pageContent: `m${i}`, metadata: { extension: '.md', relativePath: `docs/m${i}.md` } },
      0.2 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce([...txtHits, ...pad]);

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      5,
      undefined,
      undefined,
      { extensions: ['.txt'] },
      timing,
    );

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results).toHaveLength(5);
    expect(timing.sidecar_fast_path).toBe('missing');
  });

  it('treats an ntotal mismatch as stale and falls through to the ladder for correctness', async () => {
    // Sidecar header says 100 chunks but the live mock store reports 200.
    // The stale signal must drop the fast-path even though the sidecar file
    // is otherwise valid.
    const { manager } = await setupManagerWithSidecar({
      ntotal: 200,
      rows: Array.from({ length: 100 }, (_, i) => ({
        docstoreId: String(i),
        knowledgeBase: 'docs',
        source: `/kb/docs/file${i}.md`,
        relativePath: `docs/file${i}.md`,
        extension: '.md',
      })),
    });

    const mdHits: Array<[unknown, number]> = Array.from({ length: 6 }, (_, i) => [
      { pageContent: `m${i}`, metadata: { extension: '.md', relativePath: `docs/m${i}.md` } },
      0.1 + i * 0.01,
    ]);
    const pad: Array<[unknown, number]> = Array.from({ length: 14 }, (_, i) => [
      { pageContent: `p${i}`, metadata: { extension: '.pdf', relativePath: `docs/p${i}.pdf` } },
      0.2 + i * 0.01,
    ]);
    similaritySearchMock.mockResolvedValueOnce([...mdHits, ...pad]);

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      5,
      undefined,
      undefined,
      { extensions: ['.md'] },
      timing,
    );

    expect(similaritySearchMock).toHaveBeenCalledTimes(1);
    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results).toHaveLength(5);
    expect(timing.sidecar_fast_path).toBe('missing');
  });

  it('falls back to the ladder when the sidecar JSONL on disk is corrupt', async () => {
    const { manager, sidecarPath } = await setupManagerWithSidecar({
      ntotal: 100,
      rows: Array.from({ length: 100 }, (_, i) => ({
        docstoreId: String(i),
        knowledgeBase: 'docs',
        source: `/kb/docs/file${i}.md`,
        relativePath: `docs/file${i}.md`,
        extension: '.md',
      })),
    });
    await fsp.writeFile(sidecarPath, '{not-valid-jsonl', 'utf-8');
    (manager as { __resetMetadataSidecarCacheForTests?: () => void })
      .__resetMetadataSidecarCacheForTests?.();

    const items: Array<[unknown, number]> = Array.from({ length: 20 }, (_, i) => [
      { pageContent: `m${i}`, metadata: { extension: '.md', relativePath: `docs/m${i}.md` } },
      0.1 + i * 0.001,
    ]);
    similaritySearchMock.mockResolvedValueOnce(items);

    const timing: Record<string, unknown> = {};
    const results = await manager.similaritySearch(
      'q',
      5,
      undefined,
      undefined,
      { extensions: ['.md'] },
      timing,
    );

    expect(similaritySearchMock).toHaveBeenCalledWith('q', 20);
    expect(results).toHaveLength(5);
    expect(timing.sidecar_fast_path).toBe('missing');
  });
});
