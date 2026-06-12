import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SimilaritySearchTiming } from './FaissIndexManager.js';

const initializeMock = jest.fn();
const updateIndexMock = jest.fn();
const reloadPersistedIndexMock = jest.fn();
const similaritySearchMock = jest.fn();
const expandWithNeighborContextMock = jest.fn((results: unknown) => results);
const hasLoadedIndexMock = jest.fn(() => true);
// Issue #54 — kb_stats reads chunk_count + dim from the manager. Default to
// an empty store so tests that don't care about stats still see a sane shape.
const getStatsMock = jest.fn(() => ({
  totalChunks: 0,
  chunkCountsByKb: {} as Record<string, number>,
  dim: null as number | null,
}));
const getLastIndexUpdateSummaryMock = jest.fn(() => ({
  status: 'never_run',
  scope: null,
  model_id: 'huggingface__BAAI-bge-small-en-v1.5',
  started_at: null,
  finished_at: null,
  duration_ms: null,
  files_scanned: 0,
  files_changed: 0,
  files_unchanged: 0,
  files_skipped: 0,
  chunks_attempted: 0,
  chunks_added: 0,
  index_mutated: false,
  saved: false,
  sidecars_written: false,
  failure_count: 0,
  failures: [],
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
    reloadPersistedIndex: reloadPersistedIndexMock,
    similaritySearch: similaritySearchMock,
    expandWithNeighborContext: expandWithNeighborContextMock,
    getStats: getStatsMock,
    getLastIndexUpdateSummary: getLastIndexUpdateSummaryMock,
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
process.setMaxListeners(100);

describe('KnowledgeBaseServer handlers', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    LOG_FILE: process.env.LOG_FILE,
    KB_LOG_FORMAT: process.env.KB_LOG_FORMAT,
    KB_LLM_ENDPOINT: process.env.KB_LLM_ENDPOINT,
    KB_LLM_FAKE: process.env.KB_LLM_FAKE,
    KB_RERANK: process.env.KB_RERANK,
    KB_RERANK_TOP_N: process.env.KB_RERANK_TOP_N,
    ASK_KNOWLEDGE_DESCRIPTION: process.env.ASK_KNOWLEDGE_DESCRIPTION,
    RETRIEVE_KNOWLEDGE_DESCRIPTION: process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION,
    LIST_KNOWLEDGE_BASES_DESCRIPTION: process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION,
    KB_INGEST_ENABLED: process.env.KB_INGEST_ENABLED,
    INGEST_EXTRA_EXTENSIONS: process.env.INGEST_EXTRA_EXTENSIONS,
    INGEST_EXCLUDE_PATHS: process.env.INGEST_EXCLUDE_PATHS,
    KB_DENSE_DEGRADE_ON_PROVIDER_ERROR: process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR,
  };

  beforeEach(() => {
    initializeMock.mockReset();
    updateIndexMock.mockReset();
    reloadPersistedIndexMock.mockReset();
    similaritySearchMock.mockReset();
    expandWithNeighborContextMock.mockReset();
    expandWithNeighborContextMock.mockImplementation((results: unknown) => results);
    hasLoadedIndexMock.mockReset();
    hasLoadedIndexMock.mockReturnValue(true);
    getStatsMock.mockReset();
    getStatsMock.mockReturnValue({ totalChunks: 0, chunkCountsByKb: {}, dim: null });
    process.env.KB_LOG_FORMAT = 'text';
    getLastIndexUpdateSummaryMock.mockReset();
    getLastIndexUpdateSummaryMock.mockReturnValue({
      status: 'never_run',
      scope: null,
      model_id: 'huggingface__BAAI-bge-small-en-v1.5',
      started_at: null,
      finished_at: null,
      duration_ms: null,
      files_scanned: 0,
      files_changed: 0,
      files_unchanged: 0,
      files_skipped: 0,
      chunks_attempted: 0,
      chunks_added: 0,
      index_mutated: false,
      saved: false,
      sidecars_written: false,
      failure_count: 0,
      failures: [],
    });
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

  async function exists(target: string): Promise<boolean> {
    try {
      await fsp.stat(target);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return false;
      }
      throw error;
    }
  }

  async function readCanonicalEvents(logFile: string): Promise<Array<Record<string, any>>> {
    await new Promise((resolve) => setImmediate(resolve));
    const contents = await fsp.readFile(logFile, 'utf-8');
    return contents
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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

  it('handleRetrieveKnowledge expands neighbor context only when requested', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    const semanticResults = [
      {
        pageContent: 'match',
        metadata: { source: '/tmp/doc.md', chunkIndex: 1 },
        score: 0.5,
      },
    ];
    similaritySearchMock.mockResolvedValue(semanticResults);
    expandWithNeighborContextMock.mockReturnValue([
      {
        ...semanticResults[0],
        matchType: 'semantic',
        semanticMatch: true,
        contextChunks: [
          {
            pageContent: 'neighbor',
            metadata: { source: '/tmp/doc.md', chunkIndex: 2 },
            matchType: 'context',
            semanticMatch: false,
            contextDirection: 'after',
            contextDistance: 1,
          },
        ],
      },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'q',
      context_before: 1,
      context_after: 1,
    });

    expect(expandWithNeighborContextMock).toHaveBeenCalledWith(
      semanticResults,
      { before: 1, after: 1 },
    );
    expect(result.content[0].text).toContain('semantic match');
    expect(result.content[0].text).toContain('Context chunks');
    expect(result.content[0].text).toContain('neighbor');
  });

  it('handleRetrieveKnowledge rejects neighbor context for hybrid mode', async () => {
    await setRetrieveEnv();

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'q',
      search_mode: 'hybrid',
      context_window: 1,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('VALIDATION');
    expect(similaritySearchMock).not.toHaveBeenCalled();
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
      index_type: 'flat',
      index_factory: 'Flat',
    });
    expect(payload.index_path).toBe(process.env.FAISS_INDEX_PATH);
    expect(payload.last_index_update.status).toBe('never_run');
    expect(payload.last_index_update.model_id).toBe('huggingface__BAAI-bge-small-en-v1.5');
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

  it('handleKbStats includes remote transport counters when HTTP mode is active (#430)', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'aaa');

    const remoteTransportStats = {
      transport: 'http' as const,
      sessions_opened: 2,
      sessions_closed: 1,
      current_sessions: 1,
      in_flight_requests: 3,
      requests_total: 8,
      response_status_buckets: {
        '1xx': 0,
        '2xx': 5,
        '3xx': 0,
        '4xx': 2,
        '5xx': 1,
      },
      auth_failures: 1,
      origin_denials: 1,
      last_error: {
        at: '2026-05-20T07:00:00.000Z',
        message: 'socket parse error',
      },
    };

    const server = await freshServer();
    server['transportMode'] = 'http';
    server['httpHost'] = {
      getRuntimeStats: () => remoteTransportStats,
    } as any;

    const result = await server['handleKbStats']({});

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.remote_transport).toEqual(remoteTransportStats);
  });

  it('handleMetricsExport renders production stats with remote transport counters', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'aaa');

    getStatsMock.mockReturnValue({
      totalChunks: 2,
      chunkCountsByKb: { alpha: 2 },
      dim: 384,
    });

    const server = await freshServer();
    server['transportMode'] = 'http';
    server['httpHost'] = {
      getRuntimeStats: () => ({
        transport: 'http' as const,
        sessions_opened: 1,
        sessions_closed: 0,
        current_sessions: 1,
        in_flight_requests: 0,
        requests_total: 3,
        response_status_buckets: {
          '1xx': 0,
          '2xx': 2,
          '3xx': 0,
          '4xx': 1,
          '5xx': 0,
        },
        auth_failures: 1,
        origin_denials: 0,
        last_error: null,
      }),
    } as any;

    const text = await server['handleMetricsExport']();

    expect(text).toContain('kb_knowledge_base_chunks{kb="alpha"} 2');
    expect(text).toContain('# TYPE kb_remote_transport_requests counter');
    expect(text).toContain('kb_remote_transport_requests_total 3');
    expect(text.endsWith('# EOF\n')).toBe(true);
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

  // --- ingest tools (#51) ---------------------------------------------------

  it('handleAddDocument writes content and updates that KB immediately', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: '# New note\n\nHello ingest.',
    });

    expect(result.isError).toBeUndefined();
    const documentPath = path.join(tempDir, 'alpha', 'notes', 'new.md');
    await expect(fsp.readFile(documentPath, 'utf-8')).resolves.toBe('# New note\n\nHello ingest.');
    expect(updateIndexMock).toHaveBeenCalledWith('alpha');
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      absolute_path: documentPath,
      indexed: true,
    });
  });

  it('handleAddDocument removes a new file when indexing fails after the write', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    updateIndexMock.mockRejectedValue(new Error('index boom'));

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: '# New note\n',
    });

    expect(result.isError).toBe(true);
    expect(updateIndexMock).toHaveBeenCalledWith('alpha');
    const documentPath = path.join(tempDir, 'alpha', 'notes', 'new.md');
    await expect(exists(documentPath)).resolves.toBe(false);
    await expect(exists(path.dirname(documentPath))).resolves.toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      error: {
        code: 'INTERNAL',
        rollback: {
          attempted: true,
          succeeded: true,
          message: 'removed newly written document',
        },
      },
    });
    expect(payload.error.message).toContain('index boom');
  });

  it('handleAddDocument restores overwritten content when indexing fails after the write', async () => {
    const tempDir = await setRetrieveEnv();
    const documentPath = path.join(tempDir, 'alpha', 'notes', 'existing.md');
    await fsp.mkdir(path.dirname(documentPath), { recursive: true });
    await fsp.writeFile(documentPath, 'old content');
    await fsp.chmod(documentPath, 0o640);
    updateIndexMock.mockRejectedValue(new Error('index boom'));

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/existing.md',
      content: 'new content',
    });

    expect(result.isError).toBe(true);
    await expect(fsp.readFile(documentPath, 'utf-8')).resolves.toBe('old content');
    const stat = await fsp.stat(documentPath);
    expect(stat.mode & 0o777).toBe(0o640);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      error: {
        rollback: {
          attempted: true,
          succeeded: true,
          message: 'restored previous document content',
        },
      },
    });
    expect(payload.error.message).toContain('index boom');
  });

  it('handleAddDocument reloads the previous FAISS state when indexing mutates memory but does not save', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    updateIndexMock.mockRejectedValueOnce(new Error('save boom'));
    getLastIndexUpdateSummaryMock.mockReturnValue({
      status: 'failed',
      scope: null,
      model_id: 'huggingface__BAAI-bge-small-en-v1.5',
      started_at: null,
      finished_at: null,
      duration_ms: null,
      files_scanned: 1,
      files_changed: 1,
      files_unchanged: 0,
      files_skipped: 0,
      chunks_attempted: 1,
      chunks_added: 1,
      index_mutated: true,
      saved: false,
      sidecars_written: false,
      failure_count: 1,
      failures: [],
    });

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: '# New note\n',
    });

    expect(result.isError).toBe(true);
    expect(updateIndexMock).toHaveBeenCalledTimes(1);
    expect(updateIndexMock).toHaveBeenCalledWith('alpha');
    expect(reloadPersistedIndexMock).toHaveBeenCalledTimes(1);
    await expect(exists(path.join(tempDir, 'alpha', 'notes', 'new.md'))).resolves.toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.rollback).toMatchObject({
      attempted: true,
      succeeded: true,
      message: 'removed newly written document; reloaded previous FAISS index state',
    });
  });

  it('handleAddDocument force-rebuilds FAISS when indexing saved before failing sidecar writes', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    updateIndexMock
      .mockRejectedValueOnce(new Error('sidecar boom'))
      .mockResolvedValueOnce(undefined);
    getLastIndexUpdateSummaryMock.mockReturnValue({
      status: 'failed',
      scope: null,
      model_id: 'huggingface__BAAI-bge-small-en-v1.5',
      started_at: null,
      finished_at: null,
      duration_ms: null,
      files_scanned: 1,
      files_changed: 1,
      files_unchanged: 0,
      files_skipped: 0,
      chunks_attempted: 1,
      chunks_added: 1,
      index_mutated: true,
      saved: true,
      sidecars_written: false,
      failure_count: 1,
      failures: [],
    });

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: '# New note\n',
    });

    expect(result.isError).toBe(true);
    expect(updateIndexMock).toHaveBeenNthCalledWith(1, 'alpha');
    expect(updateIndexMock).toHaveBeenNthCalledWith(2, undefined, { force: true });
    expect(reloadPersistedIndexMock).not.toHaveBeenCalled();
    await expect(exists(path.join(tempDir, 'alpha', 'notes', 'new.md'))).resolves.toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.rollback).toMatchObject({
      attempted: true,
      succeeded: true,
      message: 'removed newly written document; rebuilt FAISS index from rolled-back files',
    });
  });

  it('handleAddDocument reports rollback failure when cleanup cannot remove the new file', async () => {
    const tempDir = await setRetrieveEnv();
    const notesDir = path.join(tempDir, 'alpha', 'notes');
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    updateIndexMock.mockImplementationOnce(async () => {
      await fsp.chmod(notesDir, 0o500);
      throw new Error('index boom');
    });

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: 'new content',
    });

    await fsp.chmod(notesDir, 0o700);
    expect(result.isError).toBe(true);
    await expect(fsp.readFile(path.join(notesDir, 'new.md'), 'utf-8')).resolves.toBe('new content');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.message).toContain('index boom');
    expect(payload.error.rollback).toMatchObject({
      attempted: true,
      succeeded: false,
    });
    expect(payload.error.rollback.message).toBeTruthy();
  });

  it('handleAddDocument rejects path traversal and does not update the index', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'alpha',
      path: '../escape.md',
      content: 'nope',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('VALIDATION');
    expect(payload.error.message).toContain('escapes KB root');
    await expect(exists(path.join(tempDir, 'escape.md'))).resolves.toBe(false);
    expect(updateIndexMock).not.toHaveBeenCalled();
  });

  it('handleAddDocument returns KB_NOT_FOUND for a missing KB', async () => {
    await setRetrieveEnv();

    const server = await freshServer();
    const result = await server['handleAddDocument']({
      knowledge_base_name: 'missing',
      path: 'doc.md',
      content: 'nope',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('KB_NOT_FOUND');
    expect(updateIndexMock).not.toHaveBeenCalled();
  });

  it('handleDeleteDocument removes the file and hash sidecar without re-indexing', async () => {
    const tempDir = await setRetrieveEnv();
    const documentPath = path.join(tempDir, 'alpha', 'notes', 'old.md');
    const sidecarPath = path.join(tempDir, 'alpha', '.index', 'notes', 'old.md');
    await fsp.mkdir(path.dirname(documentPath), { recursive: true });
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsp.writeFile(documentPath, 'old');
    await fsp.writeFile(sidecarPath, 'hash');

    const server = await freshServer();
    const result = await server['handleDeleteDocument']({
      knowledge_base_name: 'alpha',
      path: 'notes/old.md',
    });

    expect(result.isError).toBeUndefined();
    await expect(exists(documentPath)).resolves.toBe(false);
    await expect(exists(sidecarPath)).resolves.toBe(false);
    expect(updateIndexMock).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      knowledge_base_name: 'alpha',
      path: 'notes/old.md',
      absolute_path: documentPath,
      sidecar_path: sidecarPath,
      deleted: true,
    });
  });

  it('handleDeleteDocument rejects path traversal and leaves files intact', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    const siblingPath = path.join(tempDir, 'escape.md');
    await fsp.writeFile(siblingPath, 'keep');

    const server = await freshServer();
    const result = await server['handleDeleteDocument']({
      knowledge_base_name: 'alpha',
      path: '../escape.md',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('VALIDATION');
    expect(payload.error.message).toContain('escapes KB root');
    await expect(fsp.readFile(siblingPath, 'utf-8')).resolves.toBe('keep');
    expect(updateIndexMock).not.toHaveBeenCalled();
  });

  it('handleDeleteDocument returns KB_NOT_FOUND for a missing KB', async () => {
    await setRetrieveEnv();

    const server = await freshServer();
    const result = await server['handleDeleteDocument']({
      knowledge_base_name: 'missing',
      path: 'doc.md',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('KB_NOT_FOUND');
    expect(updateIndexMock).not.toHaveBeenCalled();
  });

  it('handleReindexKnowledgeBase forces a scoped KB update', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const result = await server['handleReindexKnowledgeBase']({
      knowledge_base_name: 'alpha',
    });

    expect(result.isError).toBeUndefined();
    expect(updateIndexMock).toHaveBeenCalledWith('alpha', { force: true });
    const payload = JSON.parse(result.content[0].text);
    // The rebuild always covers every KB (FAISS has no per-vector delete),
    // so the response advertises scope: 'global' even when a KB name was
    // passed. The KB name is preserved as a caller-provided echo.
    expect(payload).toEqual({ knowledge_base_name: 'alpha', reindexed: true, scope: 'global' });
  });

  it('handleReindexKnowledgeBase forces a global update when no KB is named', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const result = await server['handleReindexKnowledgeBase']({});

    expect(result.isError).toBeUndefined();
    expect(updateIndexMock).toHaveBeenCalledWith(undefined, { force: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ knowledge_base_name: null, reindexed: true, scope: 'global' });
  });

  it('handleReindexKnowledgeBase rejects path-like KB names', async () => {
    await setRetrieveEnv();

    const server = await freshServer();
    const result = await server['handleReindexKnowledgeBase']({
      knowledge_base_name: '../alpha',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('KB_NOT_FOUND');
    expect(updateIndexMock).not.toHaveBeenCalled();
  });

  it('handleReindexKnowledgeBase returns KB_NOT_FOUND for a missing KB', async () => {
    await setRetrieveEnv();

    const server = await freshServer();
    const result = await server['handleReindexKnowledgeBase']({
      knowledge_base_name: 'missing',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('KB_NOT_FOUND');
    expect(updateIndexMock).not.toHaveBeenCalled();
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

  // --- MCP Resources (#49) --------------------------------------------------

  it('resources/list returns kb:// URIs across multiple KBs for ingestable files', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-list-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'docs'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'beta'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'guide.md'), '# Guide\n');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'notes.txt'), 'notes\n');
    await fsp.writeFile(path.join(tempDir, 'beta', 'paper.pdf'), Buffer.from('%PDF-1.4\n'));
    await fsp.writeFile(path.join(tempDir, 'beta', 'page.html'), '<h1>Page</h1>');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleListResources']();

    expect(result.resources.map((resource: { uri: string }) => resource.uri).sort()).toEqual([
      'kb://alpha/docs/guide.md',
      'kb://alpha/notes.txt',
      'kb://beta/page.html',
    ]);
    expect(result.resources.find((resource: { uri: string }) => resource.uri === 'kb://alpha/docs/guide.md')).toMatchObject({
      name: 'docs/guide.md',
      mimeType: 'text/markdown',
    });
    expect(result.resources.find((resource: { uri: string }) => resource.uri === 'kb://beta/page.html')).toMatchObject({
      mimeType: 'text/html',
    });
    expect(result.resources.map((resource: { uri: string }) => resource.uri)).not.toContain(
      'kb://beta/paper.pdf',
    );
  });

  it('resources/list supports KB and prefix filters with cursor pagination', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-page-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'docs'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'alpha', 'notes'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'beta', 'docs'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'guide.md'), '# Guide\n');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'glossary.md'), '# Glossary\n');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'plan.md'), '# Plan\n');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'notes', 'general.md'), '# General\n');
    await fsp.writeFile(path.join(tempDir, 'beta', 'docs', 'guide.md'), '# Beta\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const firstPage = await server['handleListResources']({
      kbName: 'alpha',
      prefix: 'docs/g',
      limit: 1,
    });

    expect(firstPage.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      'kb://alpha/docs/glossary.md',
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await server['handleListResources']({ cursor: firstPage.nextCursor });

    expect(secondPage.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      'kb://alpha/docs/guide.md',
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('resources/list keeps full listing as the no-parameter default', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-default-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'docs'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'beta', 'docs'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'a.md'), '# A\n');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'b.md'), '# B\n');
    await fsp.writeFile(path.join(tempDir, 'beta', 'docs', 'c.md'), '# C\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleListResources']();

    expect(result.resources.map((resource: { uri: string }) => resource.uri).sort()).toEqual([
      'kb://alpha/docs/a.md',
      'kb://alpha/docs/b.md',
      'kb://beta/docs/c.md',
    ]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('resources/list paginates the unfiltered listing across KB boundaries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-unfiltered-page-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'docs'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'beta', 'docs'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'a.md'), '# A\n');
    await fsp.writeFile(path.join(tempDir, 'beta', 'docs', 'b.md'), '# B\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const firstPage = await server['handleListResources']({ limit: 1 });

    expect(firstPage.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      'kb://alpha/docs/a.md',
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await server['handleListResources']({ cursor: firstPage.nextCursor });

    expect(secondPage.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      'kb://beta/docs/b.md',
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('resources/list rejects client-forged cursors with unsafe filters', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-forged-cursor-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'safe.md'), '# Safe\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const forgedCursor = `kbres1.${Buffer.from(JSON.stringify({
      v: 1,
      offset: 0,
      kbName: '../outside',
      prefix: '',
      limit: 10,
    }), 'utf-8').toString('base64url')}`;

    await expect(server['handleListResources']({ cursor: forgedCursor })).rejects.toThrow(
      /invalid resources\/list cursor/,
    );
  });

  it('resources/read returns markdown text for an existing file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-read-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'docs'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'onboarding.md'), '# Onboarding\n\nWelcome.\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleReadResource']('kb://alpha/docs/onboarding.md');

    expect(result.contents).toEqual([
      {
        uri: 'kb://alpha/docs/onboarding.md',
        mimeType: 'text/markdown',
        text: '# Onboarding\n\nWelcome.\n',
      },
    ]);
  });

  it('resources/read returns PDF bytes as a base64 blob', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-pdf-'));
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0a, 0xff]);
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'paper.pdf'), pdfBytes);

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXTRA_EXTENSIONS = '.pdf';

    const server = await freshServer();
    const listResult = await server['handleListResources']();
    expect(listResult.resources).toContainEqual({
      uri: 'kb://alpha/paper.pdf',
      name: 'paper.pdf',
      description: 'Document in knowledge base "alpha"',
      mimeType: 'application/pdf',
    });

    const result = await server['handleReadResource']('kb://alpha/paper.pdf');

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.uri).toBe('kb://alpha/paper.pdf');
    expect(content.mimeType).toBe('application/pdf');
    expect('blob' in content ? content.blob : undefined).toBe(pdfBytes.toString('base64'));
    expect('text' in content ? content.text : undefined).toBeUndefined();
  });

  it('resources/list and resources/read honor ingest filters and quarantine state', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-ingest-policy-'));
    const kbPath = path.join(tempDir, 'alpha');
    await fsp.mkdir(path.join(kbPath, 'docs'), { recursive: true });
    await fsp.mkdir(path.join(kbPath, 'drafts'), { recursive: true });
    await fsp.mkdir(path.join(kbPath, 'logs'), { recursive: true });
    await fsp.writeFile(path.join(kbPath, 'docs', 'guide.md'), '# Guide\n');
    await fsp.writeFile(path.join(kbPath, 'docs', 'quarantined.md'), '# Broken\n');
    await fsp.writeFile(path.join(kbPath, 'drafts', 'hidden.md'), '# Draft\n');
    await fsp.writeFile(path.join(kbPath, 'logs', 'today.md'), '# Logs\n');
    await fsp.writeFile(path.join(kbPath, 'paper.pdf'), Buffer.from('%PDF-1.4\n'));
    await fsp.symlink('../docs/guide.md', path.join(kbPath, 'drafts', 'guide-link.md'));
    const { recordIngestFailure } = await import('./ingest-quarantine.js');
    await recordIngestFailure({
      kbPath,
      relativePath: 'docs/quarantined.md',
      error: new Error('loader rejected file'),
    });

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.INGEST_EXCLUDE_PATHS = 'drafts/**';

    const server = await freshServer();
    const result = await server['handleListResources']();
    const uris = result.resources.map((resource: { uri: string }) => resource.uri).sort();

    expect(uris).toEqual(['kb://alpha/docs/guide.md']);
    await expect(server['handleReadResource']('kb://alpha/docs/guide.md')).resolves.toMatchObject({
      contents: [{ uri: 'kb://alpha/docs/guide.md', text: '# Guide\n' }],
    });
    await expect(server['handleReadResource']('kb://alpha/docs/quarantined.md')).rejects.toThrow(
      /resource quarantined by ingest pipeline: "docs\/quarantined\.md"/,
    );
    await expect(server['handleReadResource']('kb://alpha/drafts/hidden.md')).rejects.toThrow(
      /resource excluded by ingest filters: "drafts\/hidden\.md"/,
    );
    await expect(server['handleReadResource']('kb://alpha/drafts/guide-link.md')).rejects.toThrow(
      /resource excluded by ingest filters: "drafts\/guide-link\.md"/,
    );
    await expect(server['handleReadResource']('kb://alpha/logs/today.md')).rejects.toThrow(
      /resource excluded by ingest filters: "logs\/today\.md"/,
    );
    await expect(server['handleReadResource']('kb://alpha/paper.pdf')).rejects.toThrow(
      /resource excluded by ingest filters: "paper\.pdf"/,
    );
  });

  it('resources/list and resources/read round-trip filenames with reserved URI characters', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-reserved-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'issues'), { recursive: true });
    // Filenames covering reserved chars `decodeURI` would leave literal:
    //   `#` (%23), `?` (%3F), `&` (%26), `+` (%2B), `=` (%3D), space (%20)
    const filename = 'bug#42 &v=2+rev?.md';
    await fsp.writeFile(path.join(tempDir, 'alpha', 'issues', filename), '# Reserved\n');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const listResult = await server['handleListResources']();
    const entry = listResult.resources.find((resource: { uri: string }) =>
      resource.uri.includes('issues/'),
    );
    expect(entry).toBeDefined();
    // The list URI must be percent-encoded so MCP clients can use it as-is.
    expect(entry!.uri).toBe(
      `kb://alpha/issues/${encodeURIComponent(filename)}`,
    );

    const readResult = await server['handleReadResource'](entry!.uri);
    expect(readResult.contents).toEqual([
      {
        uri: entry!.uri,
        mimeType: 'text/markdown',
        text: '# Reserved\n',
      },
    ]);
  });

  it('resources/read rejects a non-existent file with a clean error', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-missing-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    await expect(server['handleReadResource']('kb://alpha/missing.md')).rejects.toThrow(
      /path not found: "missing\.md"/,
    );
  });

  it.each([
    ['plain parent traversal', 'kb://alpha/../secret.md'],
    ['absolute path payload', 'kb://alpha//etc/passwd'],
    ['encoded parent traversal', 'kb://alpha/%2E%2E/secret.md'],
    ['encoded slash traversal', 'kb://alpha/..%2Fsecret.md'],
    ['encoded absolute path', 'kb://alpha/%2Fetc%2Fpasswd'],
  ])('resources/read rejects %s', async (_label, uri) => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-traversal-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'safe.md'), 'safe');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    await expect(server['handleReadResource'](uri)).rejects.toThrow(/path escapes KB root/);
  });

  it('resources/list excludes dot-prefixed files and directories', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-server-resources-dot-'));
    await fsp.mkdir(path.join(tempDir, 'alpha', '.faiss'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'alpha', '.index'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'alpha', 'docs'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, '.hidden-root'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'visible.md'), 'visible');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'docs', 'guide.md'), 'guide');
    await fsp.writeFile(path.join(tempDir, 'alpha', '.reindex-trigger'), '');
    await fsp.writeFile(path.join(tempDir, 'alpha', '.faiss', 'hidden.md'), 'hidden');
    await fsp.writeFile(path.join(tempDir, 'alpha', '.index', 'hidden.md'), 'hidden');
    await fsp.writeFile(path.join(tempDir, 'alpha', '.hidden.md'), 'hidden');
    await fsp.writeFile(path.join(tempDir, '.hidden-root', 'hidden.md'), 'hidden');

    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';

    const server = await freshServer();
    const result = await server['handleListResources']();
    const uris = result.resources.map((resource: { uri: string }) => resource.uri).sort();

    expect(uris).toEqual([
      'kb://alpha/docs/guide.md',
      'kb://alpha/visible.md',
    ]);
    expect(uris.join('\n')).not.toContain('.faiss');
    expect(uris.join('\n')).not.toContain('.index');
    expect(uris.join('\n')).not.toContain('.reindex-trigger');
    expect(uris.join('\n')).not.toContain('.hidden');
  });

  // --- handleRetrieveKnowledge ----------------------------------------------

  it('handleRetrieveKnowledge formats multi-result responses with Result N, score, and source blocks', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    // Raw scores are chosen so the 2-decimal rounding in the handler
    // (score.toFixed(2)) produces a visibly different string than the raw
    // value — a regression that drops toFixed(2) would leak the raw digits.
    similaritySearchMock.mockImplementation(async (...args: unknown[]) => {
      const timing = args[5] as SimilaritySearchTiming;
      timing.embed_query_ms = 3;
      timing.faiss_search_ms = 5;
      timing.query_cache_telemetry = {
        enabled: true,
        outcome: 'disk_hit',
        model_id: 'huggingface__BAAI-bge-small-en-v1.5',
        elapsed_ms: 2,
      };
      return [
        { pageContent: 'Alpha content', metadata: { source: '/kb/a.md' }, score: 0.129876 },
        { pageContent: 'Beta content', metadata: { source: '/kb/b.md' }, score: 0.34567 },
      ];
    });

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

  it('handleRetrieveKnowledge returns dense gate verdicts in structuredContent and markdown', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'Alpha content', metadata: { source: '/kb/a.md', chunkIndex: 0 }, score: 0.2 },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'what is alpha',
      gate: 'on',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('> _Relevance gate: injected; kept 1/1._');
    expect((result as any).structuredContent.gate_verdict).toMatchObject({
      state: 'injected',
      input_count: 1,
      output_count: 1,
    });
  });

  it('handleRetrieveKnowledge returns hybrid gate verdicts in structuredContent and markdown', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha content');
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'Alpha content', metadata: { source: '/kb/a.md', chunkIndex: 0 }, score: 0.2 },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'what is alpha',
      knowledge_base_name: 'alpha',
      search_mode: 'hybrid',
      gate: 'on',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('> _Mode: hybrid');
    expect(result.content[0].text).toContain('> _Relevance gate: injected; kept 2/2._');
    expect((result as any).structuredContent.gate_verdict).toMatchObject({
      state: 'injected',
      input_count: 2,
      output_count: 2,
    });
  });

  it('handleRetrieveKnowledge fails closed on provider errors by default', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_UNAVAILABLE', 'embedding provider unavailable'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'alpha',
      knowledge_base_name: 'alpha',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect((result as any).structuredContent?.degraded).toBeUndefined();
  });

  it('handleRetrieveKnowledge degrades dense retrieval to lexical-only when opted in', async () => {
    const tempDir = await setRetrieveEnv();
    const logFile = path.join(tempDir, 'canonical.log');
    process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR = 'on';
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha lexical fallback content');
    await fsp.writeFile(path.join(tempDir, 'alpha', 'second.md'), 'Second alpha fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_TIMEOUT', 'embedding provider timed out'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'alpha fallback',
      knowledge_base_name: 'alpha',
      gate: 'on',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('> _Mode: degraded lexical-only (reason: provider_timeout; original mode dense)._');
    expect(result.content[0].text).toContain('Alpha lexical fallback content');
    expect(result.content[0].text).toContain('Second alpha fallback content');
    expect((result as any).structuredContent).toMatchObject({
      degraded: true,
      degrade_reason: 'provider_timeout',
      gate_verdict: {
        state: 'injected',
        input_count: 2,
        output_count: 2,
      },
    });
    const events = (await readCanonicalEvents(logFile))
      .filter((event) => event.tool === 'retrieve_knowledge');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      search_mode: 'dense',
      degraded: true,
      degrade_reason: 'provider_timeout',
      result_count: 2,
    });
    expect(events[0].error).toBeUndefined();
  });

  it('handleRetrieveKnowledge does not degrade dense retrieval when metadata filters are present', async () => {
    const tempDir = await setRetrieveEnv();
    process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR = 'on';
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_TIMEOUT', 'embedding provider timed out'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'alpha',
      knowledge_base_name: 'alpha',
      extensions: ['.md'],
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('PROVIDER_TIMEOUT');
    expect((result as any).structuredContent?.degraded).toBeUndefined();
  });

  it('handleRetrieveKnowledge does not degrade provider auth errors', async () => {
    const tempDir = await setRetrieveEnv();
    process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR = 'on';
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_AUTH', 'missing provider credentials'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'alpha',
      knowledge_base_name: 'alpha',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('PROVIDER_AUTH');
    expect((result as any).structuredContent?.degraded).toBeUndefined();
  });

  it('handleRetrieveKnowledge returns the provider error when no lexical leg is available', async () => {
    await setRetrieveEnv();
    process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR = 'on';
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_UNAVAILABLE', 'embedding provider unavailable'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'alpha',
      knowledge_base_name: 'missing-kb',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect((result as any).structuredContent?.degraded).toBeUndefined();
  });

  it('handleRetrieveKnowledge returns the provider error when every lexical leg fails', async () => {
    const tempDir = await setRetrieveEnv();
    process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR = 'on';
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { LexicalIndex } = await import('./lexical-index.js');
    jest.spyOn(LexicalIndex, 'load').mockRejectedValueOnce(new Error('broken lexical index'));
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_UNAVAILABLE', 'embedding provider unavailable'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'alpha',
      knowledge_base_name: 'alpha',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect((result as any).structuredContent?.degraded).toBeUndefined();
  });

  it('handleRetrieveKnowledge fails closed for hybrid provider errors by default', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Hybrid lexical fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_UNAVAILABLE', 'embedding provider unavailable'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'hybrid fallback',
      knowledge_base_name: 'alpha',
      search_mode: 'hybrid',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect((result as any).structuredContent?.degraded).toBeUndefined();
  });

  it('handleRetrieveKnowledge degrades hybrid retrieval to lexical-only when opted in', async () => {
    const tempDir = await setRetrieveEnv();
    const logFile = path.join(tempDir, 'canonical.log');
    process.env.KB_DENSE_DEGRADE_ON_PROVIDER_ERROR = 'on';
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Hybrid lexical fallback content');
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    const { searchLatencyMetrics } = await import('./metrics.js');
    searchLatencyMetrics.reset();
    const { KBError } = await import('./errors.js');
    similaritySearchMock.mockRejectedValue(new KBError('PROVIDER_UNAVAILABLE', 'embedding provider unavailable'));

    const result = await server['handleRetrieveKnowledge']({
      query: 'hybrid fallback',
      knowledge_base_name: 'alpha',
      search_mode: 'hybrid',
      gate: 'on',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(
      '> _Mode: degraded lexical-only (reason: provider_unavailable; original mode hybrid); dense fetched 0, lexical fetched 1',
    );
    expect(result.content[0].text).toContain('Hybrid lexical fallback content');
    expect((result as any).structuredContent).toMatchObject({
      degraded: true,
      degrade_reason: 'provider_unavailable',
      gate_verdict: {
        state: 'injected',
        input_count: 1,
        output_count: 1,
      },
    });
    const events = (await readCanonicalEvents(logFile))
      .filter((event) => event.tool === 'retrieve_knowledge');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      search_mode: 'hybrid',
      degraded: true,
      degrade_reason: 'provider_unavailable',
      result_count: 1,
    });
    expect(searchLatencyMetrics.snapshot().degraded).toEqual({
      hybrid: { provider_unavailable: 1 },
    });
  });

  it('handleRetrieveKnowledge reranks hybrid results before returning markdown', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'winner.md'), 'Lexical winner content');
    process.env.KB_RERANK = 'on';
    process.env.KB_RERANK_TOP_N = '2';
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'Dense loser content', metadata: { source: '/kb/dense-loser.md', chunkIndex: 0 }, score: 0.2 },
    ]);

    const server = await freshServer();
    const { setRerankerFactoryForTests } = await import('./reranker.js');
    const restoreFactory = setRerankerFactoryForTests(async () => ({
      id: 'stub-reranker',
      rerank: async (_query: string, candidates: string[]) =>
        candidates.map((candidate) => (candidate.includes('Lexical winner') ? 10 : 0)),
    }));
    try {
      const result = await server['handleRetrieveKnowledge']({
        query: 'winner',
        knowledge_base_name: 'alpha',
        search_mode: 'hybrid',
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('rerank stub-reranker');
      expect(text.indexOf('Lexical winner content')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('Lexical winner content')).toBeLessThan(text.indexOf('Dense loser content'));
    } finally {
      restoreFactory();
    }
  });

  it('handleRetrieveKnowledge reports malformed hybrid reranker config with a stable code', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'Alpha content');
    process.env.KB_RERANK = 'on';
    process.env.KB_RERANK_TOP_N = 'nope';
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'Alpha content', metadata: { source: '/kb/a.md', chunkIndex: 0 }, score: 0.2 },
    ]);

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'what is alpha',
      knowledge_base_name: 'alpha',
      search_mode: 'hybrid',
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatchObject({
      code: 'RERANK_CONFIG_INVALID',
      message: 'invalid KB_RERANK_TOP_N="nope" (expected integer 1-1000)',
    });
  });

  it('handleRetrieveKnowledge emits one canonical event with redacted query and result fields (#216)', async () => {
    const tempDir = await setRetrieveEnv();
    const logFile = path.join(tempDir, 'canonical.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockImplementation(async (...args: unknown[]) => {
      const timing = args[5] as SimilaritySearchTiming;
      timing.embed_query_ms = 3;
      timing.faiss_search_ms = 5;
      timing.query_cache_telemetry = {
        enabled: true,
        outcome: 'disk_hit',
        model_id: 'huggingface__BAAI-bge-small-en-v1.5',
        elapsed_ms: 2,
      };
      return [
        { pageContent: 'Alpha content', metadata: { source: '/kb/a.md' }, score: 0.129876 },
        { pageContent: 'Beta content', metadata: { source: '/kb/b.md' }, score: 0.34567 },
      ];
    });

    const server = await freshServer();
    const result = await server['handleRetrieveKnowledge']({
      query: 'raw private query',
      knowledge_base_name: 'alpha',
      threshold: 0.75,
    });

    expect(result.isError).toBeUndefined();
    const events = await readCanonicalEvents(logFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema_version: 'kb-canonical.v1',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      model_id: 'huggingface__BAAI-bge-small-en-v1.5',
      kb_scope: 'alpha',
      k: 10,
      threshold: 0.75,
      search_mode: 'dense',
      result_count: 2,
      top_score: 0.129876,
      top_sources: ['/kb/a.md', '/kb/b.md'],
      cache: 'disk_hit',
      query_cache: {
        enabled: true,
        outcome: 'disk_hit',
        model_id: 'huggingface__BAAI-bge-small-en-v1.5',
        elapsed_ms: 2,
      },
    });
    expect(events[0].query_sha256).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(events[0])).not.toContain('raw private query');
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

  it('handleAskKnowledge returns cited structured local-LLM answers without mutating the index', async () => {
    await setRetrieveEnv();
    process.env.KB_LLM_FAKE = 'on';
    delete process.env.KB_LLM_ENDPOINT;
    similaritySearchMock.mockResolvedValue([
      {
        pageContent: 'Rollback approval requires the release lead.',
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'runbooks/rollback.md',
          loc: { lines: { from: 4, to: 8 } },
        },
        score: 0.1,
      },
    ]);

    const server = await freshServer();
    const result = await server['handleAskKnowledge']({
      query: 'Who approves rollback?',
      knowledge_base_name: 'ops',
      task_context: 'answer an incident rollback question',
    });

    expect(result.isError).toBeUndefined();
    expect(updateIndexMock).not.toHaveBeenCalled();
    expect(initializeMock).toHaveBeenCalledWith({ readOnly: true });
    expect(reloadPersistedIndexMock).not.toHaveBeenCalled();
    expect(similaritySearchMock).toHaveBeenCalledWith(
      'Who approves rollback?',
      8,
      undefined,
      'ops',
      undefined,
      expect.any(Object),
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.answer).toContain('Rollback approval requires the release lead.');
    expect(payload.abstention_reason).toBeNull();
    expect(payload.citations).toEqual([
      {
        knowledge_base: 'ops',
        path: 'runbooks/rollback.md',
        score: 0.1,
        chunk_id: 'ops/runbooks/rollback.md#L4-L8',
        chunk_ids: ['ops/runbooks/rollback.md#L4-L8'],
      },
    ]);
    expect(payload.llm).toMatchObject({
      profile: 'fake',
      source: 'fake',
      model: 'kb-fake-llm',
    });
    expect(payload.retrieval).toMatchObject({
      embedding_model: 'huggingface__BAAI-bge-small-en-v1.5',
      k: 8,
      knowledge_base: 'ops',
      task_context_provided: true,
    });
    expect(payload.context_packing.included_chunks).toBe(1);
    expect(payload.timing).toMatchObject({
      context_included_chunks: 1,
      context_excluded_chunks: 0,
    });
    expect((result as any).structuredContent).toEqual(payload);
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

  it('handleRetrieveKnowledge emits canonical errors with RFC 009 category mapping (#216)', async () => {
    const tempDir = await setRetrieveEnv();
    const logFile = path.join(tempDir, 'canonical-error.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';

    const server = await freshServer();
    const { KBError } = await import('./errors.js');
    updateIndexMock.mockRejectedValue(new KBError('PROVIDER_TIMEOUT', 'provider timed out'));

    const result = await server['handleRetrieveKnowledge']({ query: 'q' });

    expect(result.isError).toBe(true);
    const events = await readCanonicalEvents(logFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema_version: 'kb-canonical.v1',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      error: {
        code: 'PROVIDER_TIMEOUT',
        category: 'provider',
      },
    });
  });

  it('threshold argument flows through to similaritySearch(query, 10, threshold, kb, filters)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', threshold: 0.5 });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, 0.5, undefined, undefined, expect.any(Object));

    await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, undefined, undefined, undefined, expect.any(Object));

    expect(similaritySearchMock).toHaveBeenCalledTimes(2);
  });

  it('handleRetrieveKnowledge forwards knowledge_base_name to similaritySearch (#71)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', knowledge_base_name: 'alpha' });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, undefined, 'alpha', undefined, expect.any(Object));

    await server['handleRetrieveKnowledge']({
      query: 'q',
      knowledge_base_name: 'alpha',
      threshold: 0.25,
    });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, 0.25, 'alpha', undefined, expect.any(Object));
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
      expect.any(Object),
    );

    await server['handleRetrieveKnowledge']({ query: 'q', extensions: ['.pdf'] });
    expect(similaritySearchMock).toHaveBeenLastCalledWith(
      'q',
      10,
      undefined,
      undefined,
      { extensions: ['.pdf'], pathGlob: undefined, tags: undefined },
      expect.any(Object),
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
  // would silently drop the warm-up notifications. Issue #157 step 4
  // pushed the fan-out into the host (`SseHost.notify` / `StreamableHttp-
  // Host.notify`); the test now pins the server's contract with the host
  // — "delegate to notify, never touch the root mcp" — and the per-session
  // iteration is covered in `transport/sse.test.ts` + `transport/http.
  // test.ts`.
  it('SSE warm-up logging delegates to sseHost.notify; never reaches the unconnected root mcp (#87, #157 step 4)', async () => {
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

    const notifyMock = jest.fn().mockResolvedValue(undefined);
    server['sseHost'] = { notify: notifyMock };

    await server['warmActiveManager']();

    expect(rootSendLoggingMessageMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(
      'info',
      'knowledge-base-server',
      'Embedded 10/25 files for huggingface__BAAI-bge-small-en-v1.5',
    );
  });

  it('warm-up logging in SSE mode does not crash when sseHost is unset (graceful no-op, #157 step 4)', async () => {
    await setRetrieveEnv();
    hasLoadedIndexMock.mockReturnValue(false);
    updateIndexMock.mockResolvedValue(undefined);

    const server = await freshServer();
    server['transportMode'] = 'sse';
    const rootSendLoggingMessageMock = jest.fn().mockResolvedValue(undefined);
    server['mcp'].sendLoggingMessage = rootSendLoggingMessageMock;
    // sseHost intentionally undefined — the dispatcher must not fall back
    // to the unconnected root mcp, which is the bug this guards against.

    await expect(server['warmActiveManager']()).resolves.toBeUndefined();
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

  function registeredToolNames(server: any): string[] {
    const registered = server['mcp']._registeredTools as Record<string, unknown>;
    expect(registered).toBeDefined();
    return Object.keys(registered);
  }

  it('KB_INGEST_ENABLED=false hides MCP ingest tools while preserving read tools and resources', async () => {
    const tempDir = await setRetrieveEnv();
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'note.md'), '# Alpha\n');

    delete process.env.KB_INGEST_ENABLED;
    const defaultServer = await freshServer();
    expect(registeredToolNames(defaultServer)).toEqual(expect.arrayContaining([
      'add_document',
      'delete_document',
      'reindex_knowledge_base',
    ]));

    process.env.KB_INGEST_ENABLED = 'false';
    const readOnlyServer = await freshServer();
    const tools = registeredToolNames(readOnlyServer);

    expect(tools).toEqual(expect.arrayContaining([
      'list_knowledge_bases',
      'retrieve_knowledge',
      'ask_knowledge',
      'list_models',
      'kb_stats',
      'diff_index',
    ]));
    expect(tools).not.toContain('add_document');
    expect(tools).not.toContain('delete_document');
    expect(tools).not.toContain('reindex_knowledge_base');

    const resources = await readOnlyServer['handleListResources']();
    expect(resources.resources.map((resource: { uri: string }) => resource.uri)).toContain('kb://alpha/note.md');
  });

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
    expect(describeOf(server, 'ask_knowledge')).toContain('Answers a question from retrieved knowledge-base context');
    expect(describeOf(server, 'ask_knowledge')).toContain('abstention_reason');
    expect(describeOf(server, 'delete_document')).toContain('FAISS does not support vector deletion');
    expect(describeOf(server, 'delete_document')).toContain('orphan vectors');
    expect(describeOf(server, 'diff_index')).toContain('retrieval-result churn');
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
    const { sanitizeMetadataForWire } = await import('./formatter.js');
    const md = { source: '/kb/a.md', relativePath: 'a.md', tags: ['x'] };
    expect(sanitizeMetadataForWire(md, false)).toBe(md);
    expect(sanitizeMetadataForWire(md, true)).toBe(md);
  });

  it('sanitizeMetadataForWire passes through metadata whose frontmatter has no extras', async () => {
    const { sanitizeMetadataForWire } = await import('./formatter.js');
    const md = {
      source: '/kb/a.md',
      frontmatter: { arxiv_id: '2604.1', title: 'X' },
    };
    // No extras present → identity (no clone needed).
    expect(sanitizeMetadataForWire(md, false)).toBe(md);
  });

  it('sanitizeMetadataForWire does not mutate the input object', async () => {
    const { sanitizeMetadataForWire } = await import('./formatter.js');
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
