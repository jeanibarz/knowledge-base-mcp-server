import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const initializeMock = jest.fn();
const updateIndexMock = jest.fn();
const similaritySearchMock = jest.fn();

jest.mock('./FaissIndexManager.js', () => ({
  __esModule: true,
  FaissIndexManager: jest.fn().mockImplementation(() => ({
    initialize: initializeMock,
    updateIndex: updateIndexMock,
    similaritySearch: similaritySearchMock,
  })),
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
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
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
    expect(result.content[0].text).toMatch(/^Error listing knowledge bases:/);
    // readdir on a non-existent path emits ENOENT; the handler must surface
    // enough of the underlying failure to be actionable by the caller.
    expect(result.content[0].text).toMatch(/ENOENT|no such file/i);
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
    expect(result.content[0].text).toMatch(/^Error retrieving knowledge:/);
    expect(result.content[0].text).toContain('index boom');
    // If similaritySearch itself throws, the same error-path must apply.
    similaritySearchMock.mockRejectedValueOnce(new Error('search boom'));
    updateIndexMock.mockResolvedValueOnce(undefined);
    const result2 = await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain('search boom');
  });

  it('threshold argument flows through to similaritySearch(query, 10, threshold, kb)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', threshold: 0.5 });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, 0.5, undefined);

    await server['handleRetrieveKnowledge']({ query: 'q' });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, undefined, undefined);

    expect(similaritySearchMock).toHaveBeenCalledTimes(2);
  });

  it('handleRetrieveKnowledge forwards knowledge_base_name to similaritySearch (#71)', async () => {
    await setRetrieveEnv();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([]);

    const server = await freshServer();

    await server['handleRetrieveKnowledge']({ query: 'q', knowledge_base_name: 'alpha' });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, undefined, 'alpha');

    await server['handleRetrieveKnowledge']({
      query: 'q',
      knowledge_base_name: 'alpha',
      threshold: 0.25,
    });
    expect(similaritySearchMock).toHaveBeenLastCalledWith('q', 10, 0.25, 'alpha');
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
});
