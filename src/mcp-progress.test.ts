// Issue #795 — MCP `notifications/progress` for long-running tool calls.
//
// Drives a real in-memory MCP transport: a client calls `retrieve_knowledge`
// with a `_meta.progressToken` (the SDK sets it automatically when an
// `onprogress` callback is supplied) and we assert the server streams ordered
// `notifications/progress` frames with strictly increasing `progress`. A second
// case with no token asserts the strict no-op contract — a call that did not
// opt in must not receive any progress frame.
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const updateIndexMock = jest.fn().mockResolvedValue(undefined);
const similaritySearchMock = jest.fn().mockResolvedValue([
  { pageContent: 'hello world', metadata: { source: '/tmp/doc.md' }, score: 0.5 },
]);

const FaissIndexManagerMock: any = jest.fn().mockImplementation(
  (opts?: { provider?: string; modelName?: string }) => {
    const provider = opts?.provider ?? 'huggingface';
    const modelName = opts?.modelName ?? 'BAAI/bge-small-en-v1.5';
    const modelId = `${provider}__${modelName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-')}`;
    const faissPath = process.env.FAISS_INDEX_PATH ?? '/tmp/kb-progress-mock';
    return {
      initialize: jest.fn(),
      updateIndex: updateIndexMock,
      similaritySearch: similaritySearchMock,
      expandWithNeighborContext: (results: unknown) => results,
      getStats: () => ({ totalChunks: 0, chunkCountsByKb: {}, dim: null }),
      modelDir: path.join(faissPath, 'models', modelId),
      modelId,
      modelName,
      embeddingProvider: provider,
      get hasLoadedIndex() {
        return true;
      },
    };
  },
);
FaissIndexManagerMock.bootstrapLayout = jest.fn().mockResolvedValue(undefined);

jest.mock('./FaissIndexManager.js', () => ({
  __esModule: true,
  FaissIndexManager: FaissIndexManagerMock,
}));

// The constructor registers a SIGINT listener per server instance.
process.setMaxListeners(100);

interface ProgressFrame {
  progress: number;
  total?: number;
  message?: string;
}

describe('MCP notifications/progress (issue #795)', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    KB_LOG_FORMAT: process.env.KB_LOG_FORMAT,
  };

  afterEach(() => {
    for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.removeAllListeners('SIGINT');
    jest.clearAllMocks();
    updateIndexMock.mockResolvedValue(undefined);
    similaritySearchMock.mockResolvedValue([
      { pageContent: 'hello world', metadata: { source: '/tmp/doc.md' }, score: 0.5 },
    ]);
  });

  async function seedActiveModel(): Promise<void> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-progress-'));
    const faissDir = path.join(tempDir, '.faiss');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = 'test-key';
    process.env.KB_LOG_FORMAT = 'text';

    const modelId = 'huggingface__BAAI-bge-small-en-v1.5';
    const modelDir = path.join(faissDir, 'models', modelId);
    await fsp.mkdir(modelDir, { recursive: true });
    await fsp.writeFile(path.join(modelDir, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
    await fsp.writeFile(path.join(faissDir, 'active.txt'), modelId);
  }

  async function connectedClient(): Promise<{ client: Client; mcp: McpServer }> {
    jest.resetModules();
    const { KnowledgeBaseServer } = await import('./KnowledgeBaseServer.js');
    const server = new KnowledgeBaseServer();
    const mcp = (server as unknown as { mcp: McpServer }).mcp;
    const client = new Client({ name: 'progress-test', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, mcp };
  }

  it('streams ordered, strictly-increasing progress frames when a progressToken is supplied', async () => {
    await seedActiveModel();
    const { client, mcp } = await connectedClient();
    const frames: ProgressFrame[] = [];

    try {
      const result = await client.callTool(
        { name: 'retrieve_knowledge', arguments: { query: 'hello' } },
        undefined,
        { onprogress: (p) => frames.push(p as ProgressFrame) },
      );
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await mcp.close();
    }

    // The dense retrieve path emits one frame per coarse stage.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].progress).toBeGreaterThan(frames[i - 1].progress);
    }
    // `total` is advertised so hosts can render a determinate bar.
    expect(frames.every((f) => f.total === 4)).toBe(true);
  });

  it('emits no progress frames when the client did not opt in', async () => {
    await seedActiveModel();
    const { client, mcp } = await connectedClient();
    // A progress frame carrying an unknown token trips the SDK's built-in
    // progress handler, which surfaces via `onerror`. An unsolicited frame
    // (the spec violation we must avoid) would therefore land here.
    const errors: Error[] = [];
    client.onerror = (err) => errors.push(err);

    try {
      const result = await client.callTool({
        name: 'retrieve_knowledge',
        arguments: { query: 'hello' },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await mcp.close();
    }

    expect(errors).toHaveLength(0);
  });
});
