import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const initializeMock = jest.fn();
const updateIndexMock = jest.fn();
const similaritySearchMock = jest.fn();
const hasLoadedIndexMock = jest.fn(() => true);
// Issue #54 — kb_stats reads chunk_count + dim from the manager. Default to
// an empty store so tests that don't care about stats still see a sane shape.
const getStatsMock = jest.fn(() => ({
  totalChunks: 0,
  chunkCountsByKb: {} as Record<string, number>,
  dim: null as number | null,
}));

const FaissIndexManagerMock: any = jest.fn().mockImplementation((opts?: { provider?: string; modelName?: string }) => {
  // RFC 013 M1+M2: the manager exposes modelDir / modelId / modelName for
  // callers (KnowledgeBaseServer's per-call lock acquisition + cache key).
  // Mock these so handleRetrieveKnowledge can do withWriteLock(manager.modelDir, ...).
  const provider = opts?.provider ?? 'huggingface';
  const modelName = opts?.modelName ?? 'BAAI/bge-small-en-v1.5';
  const modelId = `${provider}__${modelName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-')}`;
  const faissPath = process.env.FAISS_INDEX_PATH ?? '/tmp/kb-server-mock';
  const modelDir = path.join(faissPath, 'models', modelId);
  return {
    initialize: initializeMock,
    updateIndex: updateIndexMock,
    similaritySearch: similaritySearchMock,
    getStats: getStatsMock,
    modelDir,
    modelId,
    modelName,
    embeddingProvider: provider,
    get hasLoadedIndex() {
      return hasLoadedIndexMock();
    },
  };
});
// bootstrapLayout is a static method; the mock returns a no-op promise.
FaissIndexManagerMock.bootstrapLayout = jest.fn().mockResolvedValue(undefined);

jest.mock('./FaissIndexManager.js', () => ({
  __esModule: true,
  FaissIndexManager: FaissIndexManagerMock,
}));

// Each KnowledgeBaseServer constructor registers a SIGINT listener; the
// default cap of 10 would warn once we cross it across the suite.
process.setMaxListeners(50);

describe('KnowledgeBaseServer handlers', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    LOG_FILE: process.env.LOG_FILE,
    RETRIEVE_KNOWLEDGE_DESCRIPTION: process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION,
    LIST_KNOWLEDGE_BASES_DESCRIPTION: process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION,
  };

  beforeEach(() => {
    initializeMock.mockReset();
    updateIndexMock.mockReset();
    similaritySearchMock.mockReset();
    hasLoadedIndexMock.mockReset();
    hasLoadedIndexMock.mockReturnValue(true);
    getStatsMock.mockReset();
    getStatsMock.mockReturnValue({ totalChunks: 0, chunkCountsByKb: {}, dim: null });
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
    // SIGINT listener is added in the constructor; keep the test process tidy.
    process.removeAllListeners('SIGINT');
    jest.restoreAllMocks();
  });

  async function setRetrieveEnv() {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-retrieve-'));
    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    // RFC 013 M1+M2: seed a registered model so resolveActiveModel() succeeds.
    // Default huggingface + BAAI/bge-small-en-v1.5 → this model_id.
    const modelId = 'huggingface__BAAI-bge-small-en-v1.5';
    const modelDir = path.join(faissDir, 'models', modelId);
    await fsp.mkdir(modelDir, { recursive: true });
    await fsp.writeFile(path.join(modelDir, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
    await fsp.writeFile(path.join(faissDir, 'active.txt'), modelId);
    return tempDir;
  }

  async function freshServer(): Promise<any> {
    jest.resetModules();
    const { KnowledgeBaseServer } = await import('./KnowledgeBaseServer.js');
    return new KnowledgeBaseServer();
  }

  // --- handleListKnowledgeBases ---------------------------------------------

  it('handleListKnowledgeBases returns filtered (dot-free) entries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-list-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'beta'));
    await fsp.mkdir(path.join(tempDir, '.hidden'));
    await fsp.writeFile(path.join(tempDir, '.config'), '');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleListKnowledgeBases']();

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text) as string[];
    expect(new Set(parsed)).toEqual(new Set(['alpha', 'beta']));
    // Explicit negative assertions so a regression that drops the dot filter
    // cannot pass by mere set-equality coincidence.
    expect(parsed).not.toContain('.hidden');
    expect(parsed).not.toContain('.config');
  });

  // --- handleListModels (RFC 013 M3 §4.5) ----------------------------------

  it('handleListModels returns registered models with active marker', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-listmodels-'));
    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const idA = 'huggingface__BAAI-bge-small-en-v1.5';
    const idB = 'ollama__nomic-embed-text-latest';
    for (const [id, name] of [[idA, 'BAAI/bge-small-en-v1.5'], [idB, 'nomic-embed-text:latest']] as const) {
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), name);
    }
    await fsp.writeFile(path.join(faissDir, 'active.txt'), idA);

    const server = await freshServer();
    const result = await server['handleListModels']();

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    const a = parsed.find((m: any) => m.model_id === idA);
    const b = parsed.find((m: any) => m.model_id === idB);
    expect(a).toMatchObject({ provider: 'huggingface', model_name: 'BAAI/bge-small-en-v1.5', active: true });
    expect(b).toMatchObject({ provider: 'ollama', model_name: 'nomic-embed-text:latest', active: false });
  });

  it('handleListModels skips models with .adding sentinel', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-listmodels-skip-'));
    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const idA = 'huggingface__BAAI-bge-small-en-v1.5';
    const idB = 'ollama__nomic-embed-text-latest';
    for (const [id, name] of [[idA, 'BAAI/bge-small-en-v1.5'], [idB, 'nomic-embed-text:latest']] as const) {
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), name);
    }
    await fsp.writeFile(path.join(faissDir, 'models', idB, '.adding'), `${process.pid}\n`);
    await fsp.writeFile(path.join(faissDir, 'active.txt'), idA);

    const server = await freshServer();
    const result = await server['handleListModels']();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.map((m: any) => m.model_id)).toEqual([idA]);
  });

  it('handleListModels returns empty array when no models registered', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-listmodels-empty-'));
    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleListModels']();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });

  // --- handleRetrieveKnowledge model_name override (RFC 013 M3) -------------

  it('handleRetrieveKnowledge with model_name=<unregistered> returns isError: true with hint', async () => {
    await setRetrieveEnv();
    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'q', model_name: 'ollama__not-here' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not registered');
  });

  it('handleRetrieveKnowledge with valid model_name override prepends model_id footer', async () => {
    await setRetrieveEnv();
    const faissDir = process.env.FAISS_INDEX_PATH!;
    const idB = 'ollama__nomic-embed-text-latest';
    await fsp.mkdir(path.join(faissDir, 'models', idB), { recursive: true });
    await fsp.writeFile(path.join(faissDir, 'models', idB, 'model_name.txt'), 'nomic-embed-text:latest');

    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'hello', metadata: { source: '/tmp/x.md' }, score: 0.5 },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'q', model_name: idB });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`Model: ${idB}`);
  });

  it('handleRetrieveKnowledge without model_name does NOT prepend model_id footer (back-compat)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'hello', metadata: { source: '/tmp/x.md' }, score: 0.5 },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(result.content[0].text).not.toContain('Model:');
  });

  // --- handleKbStats (#54) -------------------------------------------------

  it('handleKbStats with no args returns one entry per registered KB', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'beta'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'one.md'), 'hello world');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'two.md'), '12345');
    await fsp.writeFile(path.join(tempDir, 'beta', 'long.md'), 'x'.repeat(100));

    getStatsMock.mockReturnValue({
      totalChunks: 7,
      chunkCountsByKb: { alpha: 4, beta: 3 },
      dim: 384,
    });

    const server = await freshServer();
    const result = await server['handleKbStats']({});

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const payload = JSON.parse(result.content[0].text);

    expect(Object.keys(payload.knowledge_bases).sort()).toEqual(['alpha', 'beta']);
    expect(payload.knowledge_bases.alpha.file_count).toBe(2);
    expect(payload.knowledge_bases.alpha.total_bytes_indexed).toBe(11 + 5);
    expect(payload.knowledge_bases.alpha.chunk_count).toBe(4);
    expect(payload.knowledge_bases.beta.file_count).toBe(1);
    expect(payload.knowledge_bases.beta.total_bytes_indexed).toBe(100);
    expect(payload.knowledge_bases.beta.chunk_count).toBe(3);

    expect(payload.embedding).toEqual({
      provider: 'huggingface',
      model: 'BAAI/bge-small-en-v1.5',
      dim: 384,
    });
    expect(payload.index_path).toBe(process.env.FAISS_INDEX_PATH);
    expect(typeof payload.server.version).toBe('string');
    expect(payload.server.version.length).toBeGreaterThan(0);
    expect(typeof payload.server.uptime_ms).toBe('number');
    expect(payload.server.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('handleKbStats with knowledge_base_name returns only that KB and asserts chunk_count', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'beta'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'aaa');
    await fsp.writeFile(path.join(tempDir, 'beta', 'b.md'), 'bbbb');

    getStatsMock.mockReturnValue({
      totalChunks: 9,
      // chunk_count for `alpha` must come straight from this map even though
      // there is also a `beta` entry — kb_stats with a name MUST scope.
      chunkCountsByKb: { alpha: 5, beta: 4 },
      dim: 768,
    });

    const server = await freshServer();
    const result = await server['handleKbStats']({ knowledge_base_name: 'alpha' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(Object.keys(payload.knowledge_bases)).toEqual(['alpha']);
    expect(payload.knowledge_bases.alpha.chunk_count).toBe(5);
    expect(payload.knowledge_bases.alpha.file_count).toBe(1);
    expect(payload.knowledge_bases.alpha.total_bytes_indexed).toBe(3);
    expect(payload.embedding.dim).toBe(768);
  });

  it('handleKbStats returns 0 chunk_count for a KB with no docs in the index', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'newkb'));
    await fsp.writeFile(path.join(tempDir, 'newkb', 'untouched.md'), 'data');

    getStatsMock.mockReturnValue({
      totalChunks: 0,
      chunkCountsByKb: {},
      dim: null,
    });

    const server = await freshServer();
    const result = await server['handleKbStats']({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.knowledge_bases.newkb.chunk_count).toBe(0);
    expect(payload.knowledge_bases.newkb.last_updated_at).toBeNull();
    expect(payload.embedding.dim).toBeNull();
  });

  it('handleKbStats with unknown knowledge_base_name returns KB_NOT_FOUND error', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));

    const server = await freshServer();
    const result = await server['handleKbStats']({ knowledge_base_name: 'doesnotexist' });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('KB_NOT_FOUND');
    expect(payload.error.message).toContain('doesnotexist');
  });

  it('handleKbStats derives last_updated_at from the most recent file mtime under <kb>/.index/', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'x');
    const sidecarDir = path.join(tempDir, 'alpha', '.index');
    await fsp.mkdir(sidecarDir, { recursive: true });
    const sidecar = path.join(sidecarDir, 'a.md');
    await fsp.writeFile(sidecar, 'somehash');
    // Pin a known mtime so the assertion is exact.
    const fixedMs = 1_700_000_000_000;
    await fsp.utimes(sidecar, fixedMs / 1000, fixedMs / 1000);

    const server = await freshServer();
    const result = await server['handleKbStats']({ knowledge_base_name: 'alpha' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.knowledge_bases.alpha.last_updated_at).toBe(
      new Date(fixedMs).toISOString(),
    );
  });

  it('handleListKnowledgeBases surfaces readdir errors as { isError: true } naming the failure', async () => {
    const missingDir = path.join(os.tmpdir(), `kb-server-missing-${Date.now()}-${Math.random()}`);
    process.env.KNOWLEDGE_BASES_ROOT_DIR = missingDir;
    process.env.FAISS_INDEX_PATH = path.join(missingDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleListKnowledgeBases']();

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('INTERNAL');
    // readdir on a non-existent path emits ENOENT; the handler must surface
    // enough of the underlying failure to be actionable by the caller.
    expect(payload.error.message).toMatch(/ENOENT|no such file/i);
  });

  // --- handleRetrieveKnowledge ----------------------------------------------

  it('handleRetrieveKnowledge formats multi-result responses with Result N, score, and source blocks', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    // Raw scores are chosen so the 2-decimal rounding in the handler
    // (score.toFixed(2)) produces a visibly different string than the raw
    // value — a regression that drops toFixed(2) would leak the raw digits.
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'Alpha content', metadata: { source: '/kb/a.md' }, score: 0.129876 },
      { pageContent: 'Beta content', metadata: { source: '/kb/b.md' }, score: 0.34567 },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'what is alpha' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text: string = result.content[0].text;

    expect(text).toContain('## Semantic Search Results');
    expect(text).toContain('**Result 1:**');
    expect(text).toContain('**Result 2:**');
    expect(text).toContain('**Score:** 0.13');
    expect(text).toContain('**Score:** 0.35');
    expect(text).not.toContain('0.129876');
    expect(text).not.toContain('0.34567');
    expect(text).toContain('Alpha content');
    expect(text).toContain('Beta content');
    expect(text).toContain('**Source:**');
    expect(text).toContain('"source": "/kb/a.md"');
    expect(text).toContain('"source": "/kb/b.md"');
    // Results are joined by a horizontal rule and the disclaimer is appended.
    expect(text).toContain('\n\n---\n\n');
    expect(text).toContain('Disclaimer:');
    // Result ordering preserved (Result 1 precedes Result 2).
    expect(text.indexOf('**Result 1:**')).toBeLessThan(text.indexOf('**Result 2:**'));
  });

  it('handleRetrieveKnowledge returns "_No similar results found._" when similaritySearch returns []', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'nothing matches' });

    expect(result.isError).toBeUndefined();
    const text: string = result.content[0].text;
    expect(text).toContain('## Semantic Search Results');
    expect(text).toContain('_No similar results found._');
    expect(text).not.toContain('**Result 1:**');
    expect(text).toContain('Disclaimer:');
  });

  it('handleRetrieveKnowledge forwards knowledge_base_name to updateIndex; passes undefined otherwise', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', knowledge_base_name: 'alpha' });
    expect(updateIndexMock).toHaveBeenLastCalledWith('alpha');

    await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(updateIndexMock).toHaveBeenLastCalledWith(undefined);

    expect(updateIndexMock).toHaveBeenCalledTimes(2);
  });

  it('handleRetrieveKnowledge serializes thrown errors as { isError: true } without crashing', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockRejectedValue(new Error('index boom'));
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'q' });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'index boom',
      },
    });
    // If similaritySearch itself throws, the same error-path must apply.
    similaritySearchMock.mockRejectedValueOnce(new Error('search boom'));
    updateIndexMock.mockResolvedValueOnce(undefined);
    const result2 = await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(result2.isError).toBe(true);
    expect(JSON.parse(result2.content[0].text)).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'search boom',
      },
    });
  });

  it('handleRetrieveKnowledge preserves KBError codes in the MCP error payload', async () => {
    await setRetrieveEnv();

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    updateIndexMock.mockRejectedValue(new KBError('PROVIDER_AUTH', 'provider credentials are invalid'));

    const result = await server['handleRetrieveKnowledge']({ query: 'q' });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: {
        code: 'PROVIDER_AUTH',
        message: 'provider credentials are invalid',
      },
    });
  });

  it('threshold argument flows through to similaritySearch(query, 10, threshold, kb, filters)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', threshold: 0.5 });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, 0.5, undefined, undefined);

    await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, undefined, undefined, undefined);

    expect(similaritySearchMock).toHaveBeenCalledTimes(2);
  });

  it('handleRetrieveKnowledge forwards knowledge_base_name to similaritySearch (#71)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', knowledge_base_name: 'alpha' });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, undefined, 'alpha', undefined);

    await server['handleRetrieveKnowledge']({
      query: 'q',
      knowledge_base_name: 'alpha',
      threshold: 0.25,
    });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, 0.25, 'alpha', undefined);
  });

  it('handleRetrieveKnowledge forwards extensions / path_glob / tags filters (#53)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({
      query: 'q',
      extensions: ['.md'],
      path_glob: 'runbooks/**',
      tags: ['ops', 'oncall'],
    });
    expect(similaritySearchMock).toHaveBeenLastCalledWith(
      'q',
      10,
      undefined,
      undefined,
      { extensions: ['.md'], pathGlob: 'runbooks/**', tags: ['ops', 'oncall'] },
    );

    await server['handleRetrieveKnowledge']({ query: 'q', extensions: ['.pdf'] });
    expect(similaritySearchMock).toHaveBeenLastCalledWith(
      'q',
      10,
      undefined,
      undefined,
      { extensions: ['.pdf'], pathGlob: undefined, tags: undefined },
    );
  });

  it('handleRetrieveKnowledge scopes returned sources to knowledge_base_name (#71)', async () => {
    const tempDir = await setRetrieveEnv();
    const alphaSource = path.join(tempDir, 'alpha', 'one.md');
    const betaSource = path.join(tempDir, 'beta', 'two.md');

    // The mock stands in for the post-fix similaritySearch contract: when a
    // knowledge_base_name is passed as the 4th arg, only that KB's documents
    // come back. On main the handler never passes the KB name, so kb is
    // undefined, both KBs leak through, and the "no beta source" assertion
    // below fails — demonstrating the bug.
    similaritySearchMock.mockImplementation(async (_query: string, _k: number, _threshold: number | undefined, kb?: string) => {
      const all = [
        { pageContent: 'Alpha body', metadata: { source: alphaSource }, score: 0.1 },
        { pageContent: 'Beta body', metadata: { source: betaSource }, score: 0.2 },
      ];
      if (!kb) return all;
      const prefix = path.join(tempDir, kb) + path.sep;
      return all.filter((d) => d.metadata.source.startsWith(prefix));
    });
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'q',
      knowledge_base_name: 'alpha',
    });

    expect(result.isError).toBeUndefined();
    const text: string = result.content[0].text;
    expect(text).toContain(`"source": ${JSON.stringify(alphaSource)}`);
    // The bug: before the fix, beta's source also leaks into the scoped
    // result. Asserting it does NOT appear is what proves the fix works.
    expect(text).not.toContain(`"source": ${JSON.stringify(betaSource)}`);
  });

  it('runStdio connects before active model warm-up completes so list tools are available (#87)', async () => {
    await setRetrieveEnv();
    let resolveUpdate!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      updateIndexMock.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((finish) => {
          resolveUpdate = finish;
        });
      });
    });
    hasLoadedIndexMock.mockReturnValue(false);

    const server = await freshServer();
    const connectMock = jest.fn().mockResolvedValue(undefined);
    server['mcp'].connect = connectMock;

    await expect(server['runStdio']()).resolves.toBeUndefined();
    expect(connectMock).toHaveBeenCalledTimes(1);

    await updateStarted;
    expect(updateIndexMock).toHaveBeenCalledTimes(1);
    resolveUpdate();
    await server['activeWarmupPromise'];
  });

  it('startup warm-up rebuilds the active model when initialize finds no loaded index (#87)', async () => {
    await setRetrieveEnv();
    hasLoadedIndexMock.mockReturnValue(false);
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    server['mcp'].connect = jest.fn().mockResolvedValue(undefined);
    server['mcp'].sendLoggingMessage = jest.fn().mockResolvedValue(undefined);

    await server['runStdio']();
    await server['activeWarmupPromise'];

    expect(updateIndexMock).toHaveBeenCalledTimes(1);
    expect(updateIndexMock.mock.calls[0][0]).toBeUndefined();
    expect(updateIndexMock.mock.calls[0][1]).toEqual({
      onProgress: expect.any(Function),
    });
  });

  it('startup warm-up does not rebuild when initialize loads a fresh index (#87)', async () => {
    await setRetrieveEnv();
    hasLoadedIndexMock.mockReturnValue(true);

    const server = await freshServer();
    server['mcp'].connect = jest.fn().mockResolvedValue(undefined);

    await server['runStdio']();
    await server['activeWarmupPromise'];

    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(updateIndexMock).not.toHaveBeenCalled();
  });

  it('startup warm-up emits MCP logging messages for rebuild progress (#87)', async () => {
    await setRetrieveEnv();
    hasLoadedIndexMock.mockReturnValue(false);
    updateIndexMock.mockImplementationOnce(async (
      _kb: string | undefined,
      opts: {
        onProgress: (progress: {
          processedFiles: number;
          totalFiles: number;
          currentFile: string;
          modelId: string;
        }) => Promise<void>;
      },
    ) => {
      await opts.onProgress({
        processedFiles: 10,
        totalFiles: 25,
        currentFile: '/tmp/kb/doc-10.md',
        modelId: 'huggingface__BAAI-bge-small-en-v1.5',
      });
    });

    const server = await freshServer();
    const sendLoggingMessageMock = jest.fn().mockResolvedValue(undefined);
    server['mcp'].connect = jest.fn().mockResolvedValue(undefined);
    server['mcp'].sendLoggingMessage = sendLoggingMessageMock;

    await server['runStdio']();
    await server['activeWarmupPromise'];

    expect(sendLoggingMessageMock).toHaveBeenCalledWith({
      level: 'info',
      logger: 'knowledge-base-server',
      data: 'Embedded 10/25 files for huggingface__BAAI-bge-small-en-v1.5',
    });
  });

  // Codex review on PR #121 caught that in SSE mode the root `this.mcp` is
  // never connected — every SSE session has its own `McpServer` (built via
  // `createMcpServer`). Calling `sendLoggingMessage` on the unconnected root
  // would silently drop the warm-up notifications. The fan-out across live
  // session servers is the user-visible fix.
  it('SSE warm-up logging fans out to every connected session McpServer (#87 / Codex review)', async () => {
    await setRetrieveEnv();
    hasLoadedIndexMock.mockReturnValue(false);
    updateIndexMock.mockImplementationOnce(async (
      _kb: string | undefined,
      opts: {
        onProgress: (progress: {
          processedFiles: number;
          totalFiles: number;
          currentFile: string;
          modelId: string;
        }) => Promise<void>;
      },
    ) => {
      await opts.onProgress({
        processedFiles: 10,
        totalFiles: 25,
        currentFile: '/tmp/kb/doc-10.md',
        modelId: 'huggingface__BAAI-bge-small-en-v1.5',
      });
    });

    const server = await freshServer();
    server['transportMode'] = 'sse';
    const rootSendLoggingMessageMock = jest.fn().mockResolvedValue(undefined);
    server['mcp'].sendLoggingMessage = rootSendLoggingMessageMock;

    const sessionA = { sendLoggingMessage: jest.fn().mockResolvedValue(undefined) };
    const sessionB = { sendLoggingMessage: jest.fn().mockResolvedValue(undefined) };
    server['sseHost'] = {
      getConnectedMcpServers: () => [sessionA, sessionB],
    };

    await server['warmActiveManager']();

    expect(rootSendLoggingMessageMock).not.toHaveBeenCalled();
    const expectedProgressArgs = {
      level: 'info',
      logger: 'knowledge-base-server',
      data: 'Embedded 10/25 files for huggingface__BAAI-bge-small-en-v1.5',
    };
    expect(sessionA.sendLoggingMessage).toHaveBeenCalledWith(expectedProgressArgs);
    expect(sessionB.sendLoggingMessage).toHaveBeenCalledWith(expectedProgressArgs);
  });

  it('SSE warm-up logging skips the broadcast when no clients are connected (#87 / Codex review)', async () => {
    await setRetrieveEnv();
    hasLoadedIndexMock.mockReturnValue(false);
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    server['transportMode'] = 'sse';
    const rootSendLoggingMessageMock = jest.fn().mockResolvedValue(undefined);
    server['mcp'].sendLoggingMessage = rootSendLoggingMessageMock;
    server['sseHost'] = {
      getConnectedMcpServers: () => [],
    };

    await expect(server['warmActiveManager']()).resolves.toBeUndefined();
    // The unconnected root must not be used as a fallback target; the bug
    // we're guarding against is exactly that silent drop.
    expect(rootSendLoggingMessageMock).not.toHaveBeenCalled();
  });

  // --- tool description overrides (#52, RFC 010 M2) -------------------------
  //
  // These tests assert behaviour visible at the MCP wire surface: the
  // `description` field the agent reads when picking which tool to call.
  // Inspecting `mcp.server._registeredTools` is the only path to that field
  // without spinning up a real client/transport — the SDK exposes neither a
  // public getter nor a `tools/list` shortcut on the server instance. The
  // shape is internal, so if a future SDK upgrade renames it these tests
  // fail loudly rather than silently passing on an empty map.

  function describeOf(server: any, toolName: string): string {
    const registered = server['mcp']._registeredTools as Record<string, { description?: string }>;
    expect(registered).toBeDefined();
    expect(registered[toolName]).toBeDefined();
    return registered[toolName].description ?? '';
  }

  it('with neither override env set, tool descriptions match the legacy hard-coded strings', async () => {
    delete process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION;
    delete process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION;
    await setRetrieveEnv();

    const server = await freshServer();

    expect(describeOf(server, 'list_knowledge_bases')).toBe(
      'Lists the available knowledge bases.'
    );
    expect(describeOf(server, 'retrieve_knowledge')).toBe(
      'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.'
    );
  });

  it('RETRIEVE_KNOWLEDGE_DESCRIPTION overrides only the retrieve_knowledge description', async () => {
    await setRetrieveEnv();
    process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION = 'custom retrieve desc';
    delete process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION;

    const server = await freshServer();

    expect(describeOf(server, 'retrieve_knowledge')).toBe('custom retrieve desc');
    // list_knowledge_bases must not be affected by the retrieve override.
    expect(describeOf(server, 'list_knowledge_bases')).toBe(
      'Lists the available knowledge bases.'
    );
  });

  it('LIST_KNOWLEDGE_BASES_DESCRIPTION overrides only the list_knowledge_bases description', async () => {
    await setRetrieveEnv();
    process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION = 'custom list desc';
    delete process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION;

    const server = await freshServer();

    expect(describeOf(server, 'list_knowledge_bases')).toBe('custom list desc');
    // retrieve_knowledge must not be affected by the list override.
    expect(describeOf(server, 'retrieve_knowledge')).toBe(
      'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.'
    );
  });

  it('empty-string override env vars fall back to the defaults, not the empty string', async () => {
    await setRetrieveEnv();
    process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION = '';
    process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION = '';

    const server = await freshServer();

    expect(describeOf(server, 'retrieve_knowledge')).toBe(
      'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.'
    );
    expect(describeOf(server, 'list_knowledge_bases')).toBe(
      'Lists the available knowledge bases.'
    );
  });

  // --- sanitizeMetadataForWire + FRONTMATTER_EXTRAS_WIRE_VISIBLE (RFC 011 §7.1 R1) ---

  it('handleRetrieveKnowledge strips frontmatter.extras from the wire by default (§9 S8 leak test)', async () => {
    await setRetrieveEnv();
    delete process.env.FRONTMATTER_EXTRAS_WIRE_VISIBLE;
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      {
        pageContent: 'chunk',
        metadata: {
          source: '/kb/paper.md',
          frontmatter: {
            arxiv_id: '2604.1',
            extras: { sentinel_key: 'SECRET_VALUE_XYZ' },
          },
        },
        score: 0.1,
      },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'q' });
    const text: string = result.content[0].text;

    // The sentinel value MUST NOT appear anywhere in the response body.
    expect(text).not.toContain('SECRET_VALUE_XYZ');
    expect(text).not.toContain('sentinel_key');
    expect(text).not.toContain('"extras"');
    // Other whitelisted fields are preserved.
    expect(text).toContain('"arxiv_id": "2604.1"');
  });

  it('handleRetrieveKnowledge surfaces frontmatter.extras when FRONTMATTER_EXTRAS_WIRE_VISIBLE=true', async () => {
    await setRetrieveEnv();
    process.env.FRONTMATTER_EXTRAS_WIRE_VISIBLE = 'true';
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      {
        pageContent: 'chunk',
        metadata: {
          source: '/kb/paper.md',
          frontmatter: {
            arxiv_id: '2604.1',
            extras: { sentinel_key: 'SECRET_VALUE_XYZ' },
          },
        },
        score: 0.1,
      },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({ query: 'q' });
    const text: string = result.content[0].text;

    expect(text).toContain('SECRET_VALUE_XYZ');
    expect(text).toContain('"extras"');
  });

  it('sanitizeMetadataForWire passes through metadata with no frontmatter unchanged', async () => {
    const { sanitizeMetadataForWire } = await import('./KnowledgeBaseServer.js');
    const md = { source: '/kb/a.md', relativePath: 'a.md', tags: ['x'] };
    expect(sanitizeMetadataForWire(md, false)).toBe(md);
    expect(sanitizeMetadataForWire(md, true)).toBe(md);
  });

  it('sanitizeMetadataForWire passes through metadata whose frontmatter has no extras', async () => {
    const { sanitizeMetadataForWire } = await import('./KnowledgeBaseServer.js');
    const md = {
      source: '/kb/a.md',
      frontmatter: { arxiv_id: '2604.1', title: 'X' },
    };
    // No extras present → identity (no clone needed).
    expect(sanitizeMetadataForWire(md, false)).toBe(md);
  });

  it('sanitizeMetadataForWire does not mutate the input object', async () => {
    const { sanitizeMetadataForWire } = await import('./KnowledgeBaseServer.js');
    const md = {
      source: '/kb/a.md',
      frontmatter: {
        arxiv_id: '2604.1',
        extras: { leak: 'bad' },
      },
    };
    const originalExtras = (md.frontmatter as any).extras;
    const result = sanitizeMetadataForWire(md, false);
    // Input preserved — critical: the same metadata object sits on the
    // Document cached inside FaissStore, so a mutating sanitizer would
    // corrupt it for subsequent queries.
    expect((md.frontmatter as any).extras).toBe(originalExtras);
    // Output diverges — extras removed from the returned clone.
    expect((result as any).frontmatter.extras).toBeUndefined();
    expect((result as any).frontmatter.arxiv_id).toBe('2604.1');
  });
});
