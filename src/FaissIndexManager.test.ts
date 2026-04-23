import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const saveMock = jest.fn();
const addDocumentsMock = jest.fn();
const fromTextsMock = jest.fn();
const loadMock = jest.fn();
const similaritySearchMock = jest.fn();
const embeddingConstructorMock = jest.fn();

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

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));

function createPermissionError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

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
    new FaissIndexManager();

    expect(embeddingConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-key',
      model: 'sentence-transformers/all-MiniLM-L6-v2',
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
    new FaissIndexManager();

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
    expect(saveMock).toHaveBeenCalledWith(path.join(process.env.FAISS_INDEX_PATH!, 'faiss.index'));

    await new Promise((resolve) => setImmediate(resolve));
    const logContents = await fsp.readFile(logFile, 'utf-8');
    expect(logContents).toContain('Permission denied while attempting to save FAISS index at');
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
    expect(saveMock).toHaveBeenCalledWith(path.join(process.env.FAISS_INDEX_PATH!, 'faiss.index'));
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
});
