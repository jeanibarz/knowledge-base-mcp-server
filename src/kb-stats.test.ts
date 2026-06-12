import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Issue #157 — direct tests for the computeKbStats data layer extracted out
// of KnowledgeBaseServer.handleKbStats (#54). The integration tests in
// KnowledgeBaseServer.test.ts cover the MCP wire wrapping; these cover the
// pure data contract that a future `kb stats` CLI will consume.

interface FakeManager {
  embeddingProvider: string;
  modelName: string;
  modelId: string;
  getStats(): {
    totalChunks: number;
    chunkCountsByKb: Record<string, number>;
    dim: number | null;
    indexType: 'flat' | 'sq8';
  };
  getLastIndexUpdateSummary(): unknown;
}

function makeManager(opts: {
  provider?: string;
  modelName?: string;
  modelId?: string;
  chunkCountsByKb?: Record<string, number>;
  dim?: number | null;
  indexType?: 'flat' | 'sq8';
  lastIndexUpdateSummary?: unknown;
}): FakeManager {
  const modelId = opts.modelId ?? 'huggingface__BAAI-bge-small-en-v1.5';
  return {
    embeddingProvider: opts.provider ?? 'huggingface',
    modelName: opts.modelName ?? 'BAAI/bge-small-en-v1.5',
    modelId,
    getStats: () => ({
      totalChunks: Object.values(opts.chunkCountsByKb ?? {}).reduce((s, n) => s + n, 0),
      chunkCountsByKb: opts.chunkCountsByKb ?? {},
      dim: opts.dim ?? null,
      indexType: opts.indexType ?? 'flat',
    }),
    getLastIndexUpdateSummary: () => opts.lastIndexUpdateSummary ?? ({
      status: 'never_run',
      scope: null,
      model_id: modelId,
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
    }),
  };
}

function successfulSummary(modelId = 'huggingface__BAAI-bge-small-en-v1.5') {
  return {
    status: 'success',
    scope: 'global',
    model_id: modelId,
    started_at: '2026-05-12T10:00:00.000Z',
    finished_at: '2026-05-12T10:00:05.000Z',
    duration_ms: 5000,
    files_scanned: 3,
    files_changed: 2,
    files_unchanged: 1,
    files_skipped: 0,
    chunks_attempted: 4,
    chunks_added: 4,
    index_mutated: true,
    saved: true,
    sidecars_written: true,
    failure_count: 0,
    failures: [],
  };
}

async function freshKbStats(env: Record<string, string>): Promise<typeof import('./kb-stats.js')> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  jest.resetModules();
  return import('./kb-stats.js');
}

describe('computeKbStats', () => {
  const originalEnv = {
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    KB_FLAT_SEARCH_P95_ADVISORY_MS: process.env.KB_FLAT_SEARCH_P95_ADVISORY_MS,
    INGEST_EXCLUDE_PATHS: process.env.INGEST_EXCLUDE_PATHS,
    INGEST_EXTRA_EXTENSIONS: process.env.INGEST_EXTRA_EXTENSIONS,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns one row per registered KB with file_count, total_bytes_indexed, chunk_count', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'beta'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'one.md'), 'hello world'); // 11 bytes
    await fsp.writeFile(path.join(tempDir, 'alpha', 'two.md'), '12345');       // 5
    await fsp.writeFile(path.join(tempDir, 'beta', 'long.md'), 'x'.repeat(100));

    const { computeKbStats } = await freshKbStats({
      KNOWLEDGE_BASES_ROOT_DIR: tempDir,
      FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
    });

    const manager = makeManager({
      chunkCountsByKb: { alpha: 4, beta: 3 },
      dim: 384,
    });

    const startedAt = Date.now() - 5;
    const payload = await computeKbStats(manager as any, {
      serverVersion: '9.9.9',
      startedAt,
    });

    expect(Object.keys(payload.knowledge_bases).sort()).toEqual(['alpha', 'beta']);
    // RFC 017 added the additive `contextual_preface` field; use
    // toMatchObject so the assertion remains agnostic to the new block
    // (which is verified separately in its own test).
    expect(payload.knowledge_bases.alpha).toMatchObject({
      file_count: 2,
      chunk_count: 4,
      total_bytes_indexed: 16,
      last_updated_at: null,
    });
    expect(payload.knowledge_bases.beta).toMatchObject({
      file_count: 1,
      chunk_count: 3,
      total_bytes_indexed: 100,
    });
    expect(payload.quarantined).toEqual({ alpha: 0, beta: 0 });
    expect(payload.embedding).toEqual({
      provider: 'huggingface',
      model: 'BAAI/bge-small-en-v1.5',
      dim: 384,
      index_type: 'flat',
      index_factory: 'Flat',
    });
    expect(payload.index_path).toBe(path.join(tempDir, '.faiss'));
    expect(payload.last_index_update).toMatchObject({
      status: 'never_run',
      model_id: 'huggingface__BAAI-bge-small-en-v1.5',
    });
    expect(payload.server.version).toBe('9.9.9');
    expect(payload.server.uptime_ms).toBeGreaterThanOrEqual(0);

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('surfaces a contextual_preface failure breakdown derived from sidecars (#409)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-contextual-'));
    const faissPath = path.join(tempDir, '.faiss');
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'beta'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'doc.md'), 'body');
    await fsp.writeFile(path.join(tempDir, 'beta', 'doc.md'), 'body');

    const sidecarDir = path.join(faissPath, '.contextual-prefaces', 'alpha');
    await fsp.mkdir(sidecarDir, { recursive: true });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await fsp.writeFile(
      path.join(sidecarDir, 'doc.json'),
      JSON.stringify({
        schema_version: 'contextual-preface.sidecar.v1',
        model: 'mock-llm',
        chunks: [
          { chunk_index: 0, chunk_hash: 'h0', preface: 'ctx 0' },
          { chunk_index: 1, chunk_hash: 'h1', preface: 'ctx 1' },
          { chunk_index: 2, chunk_hash: 'h2', preface: null, error_code: 'llm_unreachable', next_retry_after: future },
        ],
      }),
    );

    const { computeKbStats } = await freshKbStats({
      KNOWLEDGE_BASES_ROOT_DIR: tempDir,
      FAISS_INDEX_PATH: faissPath,
    });
    const manager = makeManager({ chunkCountsByKb: { alpha: 3, beta: 2 } });
    const payload = await computeKbStats(manager as any, {
      serverVersion: '0.0.0',
      startedAt: Date.now(),
    });

    const alpha = payload.knowledge_bases.alpha.contextual_preface;
    expect(alpha?.covered_chunks).toBe(2);
    expect(alpha?.null_preface_chunks).toBe(1);
    expect(alpha?.reindex_state).toBe('partial');
    expect(alpha?.model).toBe('mock-llm');
    expect(alpha?.failures).toEqual({
      retry_pending: 1,
      by_error_code: { llm_unreachable: 1 },
    });

    // A KB with no sidecars still carries a zeroed `failures` block.
    const beta = payload.knowledge_bases.beta.contextual_preface;
    expect(beta?.reindex_state).toBe('never');
    expect(beta?.failures).toEqual({ retry_pending: 0, by_error_code: {} });

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('scopes to a single KB when knowledgeBaseName is set', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-scope-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'beta'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'aaa');
    await fsp.writeFile(path.join(tempDir, 'beta', 'b.md'), 'bbbb');

    const { computeKbStats } = await freshKbStats({
      KNOWLEDGE_BASES_ROOT_DIR: tempDir,
      FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
    });

    const manager = makeManager({
      chunkCountsByKb: { alpha: 5, beta: 4 },
      dim: 768,
    });

    const payload = await computeKbStats(manager as any, {
      knowledgeBaseName: 'alpha',
      serverVersion: '0.0.0',
      startedAt: Date.now(),
    });

    expect(Object.keys(payload.knowledge_bases)).toEqual(['alpha']);
    expect(payload.knowledge_bases.alpha.chunk_count).toBe(5);
    expect(payload.embedding.dim).toBe(768);

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it("throws KBError('KB_NOT_FOUND') when knowledgeBaseName is unregistered (handler maps to wire shape)", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-missing-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));

    const { computeKbStats } = await freshKbStats({
      KNOWLEDGE_BASES_ROOT_DIR: tempDir,
      FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
    });
    const { KBError } = await import('./errors.js');

    const manager = makeManager({});
    await expect(
      computeKbStats(manager as any, {
        knowledgeBaseName: 'doesnotexist',
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      }),
    ).rejects.toMatchObject({
      // Throws the typed error rather than wrapping in MCP shape — the
      // handler is responsible for transport conversion (#157 boundary).
      code: 'KB_NOT_FOUND',
    });
    // Sanity: the thrown error is a real KBError instance, not a plain Error.
    await expect(
      computeKbStats(manager as any, {
        knowledgeBaseName: 'doesnotexist',
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      }),
    ).rejects.toBeInstanceOf(KBError);

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('derives last_updated_at from the most recent mtime under <kb>/.index/', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-mtime-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    const sidecarDir = path.join(tempDir, 'alpha', '.index');
    await fsp.mkdir(sidecarDir, { recursive: true });
    const sidecar = path.join(sidecarDir, 'a.md');
    await fsp.writeFile(sidecar, 'hash');
    const fixedMs = 1_700_000_000_000;
    await fsp.utimes(sidecar, fixedMs / 1000, fixedMs / 1000);

    const { computeKbStats } = await freshKbStats({
      KNOWLEDGE_BASES_ROOT_DIR: tempDir,
      FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
    });

    const manager = makeManager({});
    const payload = await computeKbStats(manager as any, {
      knowledgeBaseName: 'alpha',
      serverVersion: '0.0.0',
      startedAt: Date.now(),
    });
    expect(payload.knowledge_bases.alpha.last_updated_at).toBe(new Date(fixedMs).toISOString());

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('uses a persisted update summary when the fresh manager summary is never_run', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-persisted-summary-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const modelId = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(kbRoot, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(kbRoot, 'alpha', 'a.md'), 'alpha');
      await fsp.mkdir(path.join(faissDir, 'models', modelId), { recursive: true });
      await fsp.writeFile(
        path.join(faissDir, 'models', modelId, 'last-index-update.json'),
        JSON.stringify({
          schema_version: 'kb.last-index-update.v1',
          summary: successfulSummary(modelId),
        }),
      );

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
        FAISS_INDEX_PATH: faissDir,
      });

      const payload = await computeKbStats(makeManager({ modelId }) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      });

      expect(payload.last_index_update).toMatchObject({
        status: 'success',
        scope: 'global',
        model_id: modelId,
        duration_ms: 5000,
        files_changed: 2,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to the fresh manager summary when the persisted summary is missing or malformed', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-persisted-summary-fallback-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const modelId = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(kbRoot, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(kbRoot, 'alpha', 'a.md'), 'alpha');

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
        FAISS_INDEX_PATH: faissDir,
      });

      const missing = await computeKbStats(makeManager({ modelId }) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      });
      expect(missing.last_index_update).toMatchObject({
        status: 'never_run',
        model_id: modelId,
      });

      await fsp.mkdir(path.join(faissDir, 'models', modelId), { recursive: true });
      await fsp.writeFile(
        path.join(faissDir, 'models', modelId, 'last-index-update.json'),
        '{not-json',
      );

      const malformed = await computeKbStats(makeManager({ modelId }) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      });
      expect(malformed.last_index_update).toMatchObject({
        status: 'never_run',
        model_id: modelId,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an empty provider_calls map by default and a populated one after telemetry is recorded (issue #210)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-metrics-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'alpha'));
      await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'a');

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });
      const { ProviderCallMetrics } = await import('./metrics.js');
      const metrics = new ProviderCallMetrics({ now: () => 1_700_000_000_000 });

      const empty = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
        metrics,
      });
      expect(empty.provider_calls).toEqual({});

      metrics.record('huggingface__bge-small', { latencyMs: 5, ok: true });
      metrics.record('huggingface__bge-small', { latencyMs: 50, ok: false });
      metrics.record('huggingface__bge-small', { latencyMs: 250, ok: true, tokensIn: 12 });

      const populated = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
        metrics,
      });
      const row = populated.provider_calls['huggingface__bge-small'];
      expect(row.count).toBe(3);
      expect(row.errors).toBe(1);
      expect(row.tokens_in).toBe(12);
      expect(row.latency_ms.p95).toBeGreaterThanOrEqual(row.latency_ms.p50);
      expect(row.since_started_at).toBe(new Date(1_700_000_000_000).toISOString());
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('summarizes dense flat-search latency and emits an advisory above the p95 threshold (#604)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-search-latency-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'alpha'));
      await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'a');

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
        KB_FLAT_SEARCH_P95_ADVISORY_MS: '50',
      });
      const { SearchLatencyMetrics } = await import('./metrics.js');
      const searchMetrics = new SearchLatencyMetrics({ now: () => 1_700_000_000_000 });
      searchMetrics.record({
        mode: 'dense',
        status: 'success',
        totalMs: 125,
        stageDurationsMs: { faiss_search: 75 },
      });
      searchMetrics.record({
        mode: 'dense',
        status: 'success',
        totalMs: 160,
        stageDurationsMs: { faiss_search: 125 },
      });

      const payload = await computeKbStats(makeManager({ indexType: 'flat' }) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
        searchMetrics,
      });

      expect(payload.embedding).toMatchObject({
        index_type: 'flat',
        index_factory: 'Flat',
      });
      expect(payload.dense_search_latency).toMatchObject({
        mode: 'dense',
        stage: 'faiss_search',
        status: 'success',
        active_index: { type: 'flat', factory: 'Flat' },
        sample_count: 2,
        p50_ms: 100,
        p95_ms: 280,
        threshold_ms: 50,
        since_started_at: new Date(1_700_000_000_000).toISOString(),
        advisory: {
          code: 'FLAT_SCAN_P95_ABOVE_THRESHOLD',
          docs: expect.arrayContaining([
            'docs/architecture/adr/0010-hnsw-binding-evaluation.md',
            'https://github.com/jeanibarz/knowledge-base-mcp-server/issues/596',
          ]),
        },
      });
      expect(payload.dense_search_latency?.advisory?.message).toContain('not auto-enabled');
      expect(payload.dense_search_latency?.advisory?.message).toContain('issue #596 is blocked');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps dense latency advisory quiet when search timing is missing or below threshold (#604)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-search-latency-quiet-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'alpha'));
      await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'a');

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
        KB_FLAT_SEARCH_P95_ADVISORY_MS: '50',
      });
      const { SearchLatencyMetrics } = await import('./metrics.js');
      const emptyMetrics = new SearchLatencyMetrics({ now: () => 1 });

      const missing = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
        searchMetrics: emptyMetrics,
      });
      expect(missing.dense_search_latency).toBeUndefined();

      const lowMetrics = new SearchLatencyMetrics({ now: () => 1_700_000_000_000 });
      lowMetrics.record({
        mode: 'dense',
        status: 'success',
        totalMs: 15,
        stageDurationsMs: { faiss_search: 12 },
      });
      const belowThreshold = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
        searchMetrics: lowMetrics,
      });
      expect(belowThreshold.dense_search_latency?.advisory).toBeNull();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('includes remote transport counters only when supplied by the server (issue #430)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-transport-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'alpha'));
      await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'a');

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });

      const withoutTransport = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      });
      expect(withoutTransport.remote_transport).toBeUndefined();

      const remoteTransportStats = {
        transport: 'sse' as const,
        sessions_opened: 2,
        sessions_closed: 1,
        current_sessions: 1,
        in_flight_requests: 0,
        requests_total: 5,
        response_status_buckets: {
          '1xx': 0,
          '2xx': 3,
          '3xx': 0,
          '4xx': 2,
          '5xx': 0,
        },
        auth_failures: 1,
        origin_denials: 1,
        last_error: null,
      };
      const withTransport = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
        remoteTransportStats,
      });
      expect(withTransport.remote_transport).toEqual(remoteTransportStats);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('respects INGEST_EXCLUDE_PATHS so excluded files do not contribute to file_count or bytes', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-exclude-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    await fsp.mkdir(path.join(tempDir, 'alpha', 'pdfs'));
    await fsp.writeFile(path.join(tempDir, 'alpha', 'note.md'), 'hello');         // 5
    await fsp.writeFile(path.join(tempDir, 'alpha', 'pdfs', 'paper.md'), 'xxx');  // excluded by pattern

    const { computeKbStats } = await freshKbStats({
      KNOWLEDGE_BASES_ROOT_DIR: tempDir,
      FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      INGEST_EXCLUDE_PATHS: 'pdfs/**',
    });

    const manager = makeManager({});
    const payload = await computeKbStats(manager as any, {
      serverVersion: '0.0.0',
      startedAt: Date.now(),
    });
    expect(payload.knowledge_bases.alpha.file_count).toBe(1);
    expect(payload.knowledge_bases.alpha.total_bytes_indexed).toBe(5);

    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('reports per-KB ingest quarantine counts', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-stats-quarantine-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'alpha'));
      await fsp.mkdir(path.join(tempDir, 'beta'));
      await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'aaa');
      await fsp.writeFile(path.join(tempDir, 'beta', 'b.md'), 'bbbb');

      const { computeKbStats } = await freshKbStats({
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });
      const { recordIngestFailure } = await import('./ingest-quarantine.js');
      await recordIngestFailure({
        kbPath: path.join(tempDir, 'alpha'),
        relativePath: 'a.md',
        sourceHash: 'hash-a',
        error: new Error('bad input'),
      });

      const payload = await computeKbStats(makeManager({}) as any, {
        serverVersion: '0.0.0',
        startedAt: Date.now(),
      });

      expect(payload.quarantined).toEqual({ alpha: 1, beta: 0 });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('enumerateIngestableKbFiles', () => {
  it('returns one entry per requested KB, preserving input order', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-enum-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'alpha'));
      await fsp.mkdir(path.join(tempDir, 'beta'));
      await fsp.writeFile(path.join(tempDir, 'alpha', 'a.md'), 'a');
      await fsp.writeFile(path.join(tempDir, 'beta', 'b.md'), 'b');

      const { enumerateIngestableKbFiles } = await import('./kb-fs.js');
      const out = await enumerateIngestableKbFiles(tempDir, ['beta', 'alpha']);
      expect(out.map((e) => e.kbName)).toEqual(['beta', 'alpha']);
      expect(out[0].kbPath).toBe(path.join(tempDir, 'beta'));
      expect(out[0].filePaths.map((p) => path.basename(p))).toEqual(['b.md']);
      expect(out[1].filePaths.map((p) => path.basename(p))).toEqual(['a.md']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('applies extraExtensions and excludePaths from options', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-enum-opts-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'kb'));
      await fsp.mkdir(path.join(tempDir, 'kb', 'logs'));
      await fsp.writeFile(path.join(tempDir, 'kb', 'note.md'), 'a');
      await fsp.writeFile(path.join(tempDir, 'kb', 'data.csv'), 'a,b');
      await fsp.writeFile(path.join(tempDir, 'kb', 'logs', 'r.md'), 'a');

      const { enumerateIngestableKbFiles } = await import('./kb-fs.js');
      const out = await enumerateIngestableKbFiles(tempDir, ['kb'], {
        extraExtensions: ['.csv'],
        excludePaths: ['logs/**'],
      });
      const names = out[0].filePaths.map((p) => path.basename(p)).sort();
      expect(names).toEqual(['data.csv', 'note.md']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an empty filePaths array for a missing KB directory', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-enum-missing-'));
    try {
      const { enumerateIngestableKbFiles } = await import('./kb-fs.js');
      const out = await enumerateIngestableKbFiles(tempDir, ['ghost']);
      // getFilesRecursively logs and returns [] on ENOENT — caller-stable.
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        kbName: 'ghost',
        kbPath: path.join(tempDir, 'ghost'),
        filePaths: [],
        diagnostics: {
          failure_count: 1,
          failures: [{
            path: path.join(tempDir, 'ghost'),
            code: 'ENOENT',
            message: expect.stringContaining('no such file or directory'),
          }],
        },
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
