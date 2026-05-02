import * as fsp from 'fs/promises';
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

const saveMock = jest.fn();
const addDocumentsMock = jest.fn();
const fromTextsMock = jest.fn();
const loadMock = jest.fn();
const similaritySearchMock = jest.fn();
const embeddingConstructorMock = jest.fn();
const ollamaEmbeddingConstructorMock = jest.fn();
const openAIEmbeddingConstructorMock = jest.fn();

class MockFaissStore {
  async addDocuments(...args: unknown[]) {
    return addDocumentsMock(...args);
  }

  async save(...args: unknown[]) {
    return saveMock(...args);
  }

  async similaritySearchWithScore(...args: unknown[]) {
    return similaritySearchMock(...args);
  }

  static async fromTexts(...args: unknown[]) {
    fromTextsMock(...args);
    return new MockFaissStore();
  }

  static async load(...args: unknown[]) {
    loadMock(...args);
    return new MockFaissStore();
  }
}

jest.mock('@langchain/community/embeddings/hf', () => ({
  __esModule: true,
  HuggingFaceInferenceEmbeddings: class MockEmbedding {
    constructor(public _config: unknown) {
      embeddingConstructorMock(_config);
    }
  },
}));

jest.mock('@langchain/ollama', () => ({
  __esModule: true,
  OllamaEmbeddings: class MockOllamaEmbeddings {
    constructor(public _config: unknown) {
      ollamaEmbeddingConstructorMock(_config);
    }
  },
}));

jest.mock('@langchain/openai', () => ({
  __esModule: true,
  OpenAIEmbeddings: class MockOpenAIEmbeddings {
    constructor(public _config: unknown) {
      openAIEmbeddingConstructorMock(_config);
    }
  },
}));

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));

function createPermissionError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

describe('resolveChunkSize (#107 follow-up — KB_CHUNK_SIZE / KB_CHUNK_OVERLAP env vars)', () => {
  const savedSize = process.env.KB_CHUNK_SIZE;
  const savedOverlap = process.env.KB_CHUNK_OVERLAP;
  let resolveChunkSize: () => { chunkSize: number; chunkOverlap: number };

  beforeAll(async () => {
    // Late import to ensure env-driven module-state isn't captured at top-level.
    const mod = await import('./FaissIndexManager.js');
    resolveChunkSize = mod.resolveChunkSize;
  });

  afterEach(() => {
    if (savedSize === undefined) delete process.env.KB_CHUNK_SIZE; else process.env.KB_CHUNK_SIZE = savedSize;
    if (savedOverlap === undefined) delete process.env.KB_CHUNK_OVERLAP; else process.env.KB_CHUNK_OVERLAP = savedOverlap;
  });

  it('returns historical defaults (1000 / 200) when no env vars are set', () => {
    delete process.env.KB_CHUNK_SIZE;
    delete process.env.KB_CHUNK_OVERLAP;
    expect(resolveChunkSize()).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
  });

  it('honors KB_CHUNK_SIZE; overlap scales as floor(chunkSize/5)', () => {
    process.env.KB_CHUNK_SIZE = '358';
    delete process.env.KB_CHUNK_OVERLAP;
    expect(resolveChunkSize()).toEqual({ chunkSize: 358, chunkOverlap: 71 });
  });

  it('honors an independent KB_CHUNK_OVERLAP', () => {
    process.env.KB_CHUNK_SIZE = '500';
    process.env.KB_CHUNK_OVERLAP = '50';
    expect(resolveChunkSize()).toEqual({ chunkSize: 500, chunkOverlap: 50 });
  });

  it('falls back to default 200 overlap when KB_CHUNK_SIZE is the default 1000 and overlap unset', () => {
    process.env.KB_CHUNK_SIZE = '1000';
    delete process.env.KB_CHUNK_OVERLAP;
    expect(resolveChunkSize()).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
  });

  it('treats invalid / non-positive values as unset (preserves defaults)', () => {
    process.env.KB_CHUNK_SIZE = 'not-a-number';
    process.env.KB_CHUNK_OVERLAP = '-1';
    expect(resolveChunkSize()).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
  });

  it('accepts zero overlap explicitly', () => {
    process.env.KB_CHUNK_SIZE = '500';
    process.env.KB_CHUNK_OVERLAP = '0';
    expect(resolveChunkSize()).toEqual({ chunkSize: 500, chunkOverlap: 0 });
  });
});

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
    LOG_FILE: process.env.LOG_FILE,
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

    // Action: caller scopes a forced reindex to "alpha". The bug we are
    // fixing: this would keep the existing store and only re-embed alpha,
    // appending duplicates while leaving any orphaned vectors alive. The
    // fix nulls the in-memory store and walks ALL KBs.
    await manager.updateIndex('alpha', { force: true });

    // After fix: the in-memory store was nulled, so the rebuild starts
    // with fromTexts() again, and BOTH KBs' files are re-ingested.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    // Both alpha (1 file) and beta (1 file) re-embedded — minus the seed
    // file that fromTexts consumes. So addDocuments runs once for the
    // remaining file.
    const rebuildAdds = addDocumentsMock.mock.calls.length;
    expect(rebuildAdds).toBe(initialAdds);

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
    expect(addDocumentsMock).toHaveBeenCalledTimes(fileCount - 1);

    for (const docPath of docPaths) {
      const relativePath = path.relative(defaultKb, docPath);
      const sidecarPath = path.join(defaultKb, '.index', path.dirname(relativePath), path.basename(docPath));
      const sidecarContent = await fsp.readFile(sidecarPath, 'utf-8');
      expect(sidecarContent).toMatch(/^[0-9a-f]{64}$/);
      await expect(fsp.stat(`${sidecarPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
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
    // per-file path: first file → fromTexts (creating the new store),
    // each subsequent file → addDocuments. The fallback rebuild branch
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

    // Per-file recovery path: first file lands in fromTexts (creating the
    // new store), each subsequent file is appended via addDocuments.
    // One save call closes the updateIndex.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).toHaveBeenCalledTimes(fileCount - 1);
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
    await expect(fsp.stat(migratedIndexDir)).resolves.toBeDefined();
    expect(await fsp.readFile(path.join(migratedIndexDir, 'faiss.index'), 'utf-8')).toBe('old-model-bytes');

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

    // Old layout untouched.
    await expect(fsp.stat(path.join(faissDir, 'faiss.index'))).resolves.toBeDefined();
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
    const { calculateSHA256 } = await import('./utils.js');
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
    // sidecars present, every file's `fileHash !== storedHash` triggers
    // re-embed via the per-file path: the first file lands in fromTexts,
    // the rest in addDocuments. One save call, sidecars rewritten.
    await manager.updateIndex();
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).toHaveBeenCalledTimes(2);
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
    const { calculateSHA256 } = await import('./utils.js');
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

    const { calculateSHA256 } = await import('./utils.js');
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
    const { calculateSHA256 } = await import('./utils.js');
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
    // Issue #46 — `.pdf` is now in the base allowlist, so the arxiv
    // workflow (which already pairs each notes/*.md with a sibling
    // pdfs/*.pdf) must opt PDFs out via INGEST_EXCLUDE_PATHS to keep its
    // pre-#46 behavior of "embed the markdown sibling only, not the
    // binary PDF".
    process.env.INGEST_EXCLUDE_PATHS = 'pdfs/**';

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
    // independent — but both go through the same `filterIngestablePaths`
    // call site (line 967 in updateIndex). This test guards against a
    // future refactor that adds a second `getFilesRecursively` site
    // without wrapping it in the filter.
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
    // Issue #46 — same pdfs/** opt-out as the steady-state arxiv test.
    process.env.INGEST_EXCLUDE_PATHS = 'pdfs/**';

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
    delete process.env.INGEST_EXTRA_EXTENSIONS;
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
    expect(pdfMetadata).toBeDefined();
    expect(pdfMetadata?.extension).toBe('.pdf');
    expect(String(pdfMetadata?.knowledgeBase)).toBe('docs');
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
    expect(htmlMetadata).toBeDefined();
    expect(htmlMetadata?.extension).toBe('.html');

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

  it('mixed-extension KB: .md + .pdf + .html all ingest, dispatched by extension', async () => {
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
    delete process.env.INGEST_EXTRA_EXTENSIONS;
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
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
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
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
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

  it('routes non-whitelisted string keys into extras', async () => {
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
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
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
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
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
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
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
    const result = liftFrontmatter(
      { arxiv_id: '2604.1', tags: ['kv-cache'] },
      '/kb/notes/paper.md',
    );
    expect(result).toEqual({ arxiv_id: '2604.1' });
    // A result object with `tags` in it would be a duplicate-tags regression.
    expect(result && 'tags' in result).toBe(false);
  });

  it('returns undefined when the parsed frontmatter contains no liftable fields', async () => {
    const { liftFrontmatter } = await import('./FaissIndexManager.js');
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
    const { detectSiblingPdfPath } = await import('./FaissIndexManager.js');
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
    const { detectSiblingPdfPath } = await import('./FaissIndexManager.js');
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
    const { detectSiblingPdfPath } = await import('./FaissIndexManager.js');
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
    const { detectSiblingPdfPath } = await import('./FaissIndexManager.js');
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
    const { detectSiblingPdfPath } = await import('./FaissIndexManager.js');
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
    // Issue #46 — `.pdf` is in the base allowlist; the arxiv layout pairs
    // the .md note with the actual PDF, so keep the PDF out of embeddings
    // to mirror the workflow's intent (notes are the source of truth).
    process.env.INGEST_EXCLUDE_PATHS = 'pdfs/**';

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
    interface IndexHandle { index: { ntotal: () => number } }
    (manager as unknown as IndexHandle).index = { ntotal: () => 100 };
    const internal = manager as unknown as { faissIndex: { index: { ntotal: () => number } } };
    internal.faissIndex.index = { ntotal: () => 100 };
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
    const internal = manager as unknown as { faissIndex: { index: { ntotal: () => number } } };
    internal.faissIndex.index = { ntotal: () => 100 };

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
