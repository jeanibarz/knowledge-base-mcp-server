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

  it('rebuilds via fromTexts once when the FAISS index is missing but sidecars are up to date', async () => {
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

    // Capture sidecar state so we can confirm the fallback branch leaves them untouched.
    const sidecarSnapshots: { path: string; content: string }[] = [];
    for (const docPath of docPaths) {
      const relativePath = path.relative(defaultKb, docPath);
      const sidecarPath = path.join(defaultKb, '.index', path.dirname(relativePath), path.basename(docPath));
      const content = await fsp.readFile(sidecarPath, 'utf-8');
      sidecarSnapshots.push({ path: sidecarPath, content });
    }

    // The mocked FaissStore.save never writes faiss.index, so a fresh manager
    // will see it missing on disk — exactly the state the fallback branch is
    // meant to recover from. Assert that precondition explicitly.
    await expect(
      fsp.stat(path.join(process.env.FAISS_INDEX_PATH!, 'faiss.index'))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // Reset mocks so the fallback-branch call counts are isolated.
    saveMock.mockReset();
    addDocumentsMock.mockReset();
    fromTextsMock.mockReset();
    loadMock.mockReset();

    // Second pass: a new manager with faiss.index missing and sidecars intact.
    jest.resetModules();
    const { FaissIndexManager } = await import('./FaissIndexManager.js');
    const secondManager = new FaissIndexManager();
    await secondManager.initialize();
    expect(loadMock).not.toHaveBeenCalled();

    await secondManager.updateIndex();

    // Fallback branch: one rebuild, zero per-file additions, one save.
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(addDocumentsMock).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(path.join(process.env.FAISS_INDEX_PATH!, 'faiss.index'));

    // fromTexts must receive documents from every file at once. With content
    // well under the 1000-char chunkSize, each file produces exactly one chunk,
    // so the count is deterministic and a regression that double-collects docs
    // or skips one would be caught immediately.
    const [texts, metadatas] = fromTextsMock.mock.calls[0] as [string[], Array<{ source: string }>];
    expect(Array.isArray(texts)).toBe(true);
    expect(texts).toHaveLength(fileCount);
    expect(metadatas).toHaveLength(fileCount);
    const sources = new Set(metadatas.map((m) => m.source));
    for (const docPath of docPaths) {
      expect(sources.has(docPath)).toBe(true);
    }

    // Sidecars must remain byte-for-byte identical and no .tmp files left behind.
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
    const indexFilePath = path.join(faissDir, 'faiss.index');
    const indexJsonPath = `${indexFilePath}.json`;
    await fsp.writeFile(indexFilePath, 'corrupt-bytes');
    await fsp.writeFile(indexJsonPath, '{"docstore":"corrupt"}');

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
    await expect(fsp.stat(indexJsonPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // End-to-end: the next updateIndex must actually rebuild via fromTexts,
    // not just observe a null faissIndex. This proves the corrupt-recovery
    // path hands off correctly to the existing rebuild branch.
    await manager.updateIndex();
    expect(fromTextsMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(indexFilePath);
  });

  it('surfaces a permission error when the corrupt FAISS index cannot be unlinked', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-corrupt-eacces-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    const indexFilePath = path.join(faissDir, 'faiss.index');
    await fsp.writeFile(indexFilePath, 'corrupt-bytes');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = kbDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    loadMock.mockImplementationOnce(() => {
      throw new Error('invalid faiss index header');
    });

    // 0o500 on the containing directory keeps stat/read permitted (so the
    // load branch fires) but denies unlink, forcing the handleFsOperationError
    // rethrow path in the corrupt-recovery catch.
    await fsp.chmod(faissDir, 0o500);

    try {
      jest.resetModules();
      const { FaissIndexManager } = await import('./FaissIndexManager.js');
      const manager = new FaissIndexManager();

      await expect(manager.initialize()).rejects.toThrow(/Permission denied/);
    } finally {
      await fsp.chmod(faissDir, 0o700);
    }
  });

  it('does not fail when the corrupt FAISS index has no .json sibling', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-faiss-corrupt-nojson-'));
    const kbDir = path.join(tempDir, 'kb');
    await fsp.mkdir(kbDir, { recursive: true });

    const faissDir = path.join(tempDir, '.faiss');
    await fsp.mkdir(faissDir, { recursive: true });
    const indexFilePath = path.join(faissDir, 'faiss.index');
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

    // Precondition: faiss.index is not on disk (the mocked save never writes
    // it), so a fresh manager will take the fallback rebuild branch.
    await expect(
      fsp.stat(path.join(process.env.FAISS_INDEX_PATH!, 'faiss.index'))
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
