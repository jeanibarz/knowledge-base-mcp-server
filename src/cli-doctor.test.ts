import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { IndexUpdateSummary } from './FaissIndexManager.js';

const originalEnv = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME: process.env.HUGGINGFACE_MODEL_NAME,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  KB_ACTIVE_MODEL: process.env.KB_ACTIVE_MODEL,
  KB_INDEX_VERSION_RETENTION: process.env.KB_INDEX_VERSION_RETENTION,
  KB_FLAT_SEARCH_P95_ADVISORY_MS: process.env.KB_FLAT_SEARCH_P95_ADVISORY_MS,
  KB_AGE_BUDGET_HOURS: process.env.KB_AGE_BUDGET_HOURS,
  KB_AGE_BUDGET_HOURS_ALPHA: process.env.KB_AGE_BUDGET_HOURS_ALPHA,
  KB_AGE_BUDGET_HOURS_BETA: process.env.KB_AGE_BUDGET_HOURS_BETA,
  REINDEX_TRIGGER_PATH: process.env.REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS: process.env.REINDEX_TRIGGER_POLL_MS,
  KB_FS_WATCH: process.env.KB_FS_WATCH,
  KB_LLM_ENDPOINT: process.env.KB_LLM_ENDPOINT,
  KB_LLM_PROVIDER: process.env.KB_LLM_PROVIDER,
  KB_LLM_FAKE: process.env.KB_LLM_FAKE,
  KB_RELEVANCE_GATE: process.env.KB_RELEVANCE_GATE,
  KB_GATE_LLM_ENDPOINT: process.env.KB_GATE_LLM_ENDPOINT,
  KB_GATE_LLM_MODEL: process.env.KB_GATE_LLM_MODEL,
  KB_GATE_LLM_TIMEOUT_MS: process.env.KB_GATE_LLM_TIMEOUT_MS,
  KB_LLM_CONFIG_DIR: process.env.KB_LLM_CONFIG_DIR,
  KB_LLM_STATE_DIR: process.env.KB_LLM_STATE_DIR,
  KB_RERANK: process.env.KB_RERANK,
  KB_RERANK_MODEL: process.env.KB_RERANK_MODEL,
  KB_RERANK_TOP_N: process.env.KB_RERANK_TOP_N,
  HF_HOME: process.env.HF_HOME,
  TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE,
  HOME: process.env.HOME,
  MCP_TRANSPORT: process.env.MCP_TRANSPORT,
  MCP_PORT: process.env.MCP_PORT,
  MCP_BIND_ADDR: process.env.MCP_BIND_ADDR,
  KB_DAEMON_URL: process.env.KB_DAEMON_URL,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  EXTRACTION_TEXT_CACHE_DIR: process.env.EXTRACTION_TEXT_CACHE_DIR,
};

const MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';
const MODEL_NAME = 'BAAI/bge-small-en-v1.5';
const OLLAMA_MODEL_ID = 'ollama__nomic-embed-text-latest';
const OLLAMA_MODEL_NAME = 'nomic-embed-text:latest';
const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function freshDoctor(env: Record<string, string>): Promise<typeof import('./cli-doctor.js')> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  jest.resetModules();
  return import('./cli-doctor.js');
}

async function seedRegisteredModel(faissDir: string): Promise<string> {
  const modelDir = path.join(faissDir, 'models', MODEL_ID);
  await fsp.mkdir(modelDir, { recursive: true });
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), MODEL_NAME);
  await fsp.writeFile(path.join(faissDir, 'active.txt'), MODEL_ID);
  return modelDir;
}

async function seedVersionedIndex(modelDir: string): Promise<string> {
  const versionDir = path.join(modelDir, 'index.v1');
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(path.join(versionDir, 'faiss.index'), 'fake-index');
  await fsp.symlink('index.v1', path.join(modelDir, 'index'), 'dir');
  return versionDir;
}

async function seedDoctorBase(tempDir: string): Promise<{ rootDir: string; faissDir: string }> {
  const rootDir = path.join(tempDir, 'kbs');
  const faissDir = path.join(tempDir, '.faiss');
  await fsp.mkdir(rootDir, { recursive: true });
  const modelDir = await seedRegisteredModel(faissDir);
  await seedVersionedIndex(modelDir);
  return { rootDir, faissDir };
}

function persistedSuccessSummary(): IndexUpdateSummary {
  return {
    status: 'success',
    scope: 'global',
    model_id: MODEL_ID,
    started_at: '2026-05-12T10:00:00.000Z',
    finished_at: '2026-05-12T10:00:05.000Z',
    duration_ms: 5000,
    files_scanned: 4,
    files_changed: 2,
    files_unchanged: 2,
    files_skipped: 0,
    chunks_attempted: 5,
    chunks_added: 5,
    index_mutated: true,
    saved: true,
    sidecars_written: true,
    warning_count: 0,
    warnings: [],
    failure_count: 0,
    failures: [],
  };
}

function partialIndexUpdateSummary(): IndexUpdateSummary {
  return {
    ...persistedSuccessSummary(),
    status: 'partial',
    finished_at: '2026-05-12T10:00:05.000Z',
    failure_count: 37,
    failures: [{
      relative_path: 'failed.md',
      phase: 'indexing',
      code: 'EMBEDDING_FAILED',
      message: 'embedding failed',
    }],
  };
}

async function healthyLlmProbe(endpoint: string) {
  return {
    endpoint,
    health_url: endpoint.replace(/\/v1\/chat\/completions$/, '/health'),
    health_ok: true,
    chat_ok: true,
    detail: 'health and chat completion succeeded',
  };
}

function listen(server: net.Server, port = 0, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host }, () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) resolve(address.port);
      else reject(new Error('server did not report a TCP port'));
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const spy = jest.spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
  try {
    const code = await run();
    return { code, stdout };
  } finally {
    spy.mockRestore();
  }
}

describe('kb doctor', () => {
  const itOnPosix = process.platform === 'win32' ? it.skip : it;

  itOnPosix('reports safe FAISS index permissions without warnings', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-perms-safe-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      const versionDir = await seedVersionedIndex(modelDir);
      await fsp.chmod(faissDir, 0o700);
      await fsp.chmod(path.join(faissDir, 'active.txt'), 0o600);
      await fsp.chmod(modelDir, 0o700);
      await fsp.chmod(versionDir, 0o700);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.index_security.ownership_check).toBe('checked');
      expect(report.index_security.entries).toEqual([
        expect.objectContaining({ name: 'faiss_root', mode_octal: '0700', warnings: [] }),
        expect.objectContaining({ name: 'active_file', mode_octal: '0600', warnings: [] }),
        expect.objectContaining({ name: 'active_model_dir', mode_octal: '0700', warnings: [] }),
        expect.objectContaining({ name: 'active_index_version_dir', mode_octal: '0700', warnings: [] }),
      ]);
      expect(report.checks).toContainEqual({
        name: 'index_security',
        status: 'ok',
        detail: 'FAISS index boundary permissions look safe',
      });
      const md = formatDoctorMarkdown(report);
      expect(md).toContain('FAISS index security:');
      expect(md).toContain('active_index_version_dir:');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  itOnPosix('warns when FAISS index boundary paths are group or world writable', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-perms-unsafe-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      const versionDir = await seedVersionedIndex(modelDir);
      await fsp.chmod(faissDir, 0o777);
      await fsp.chmod(path.join(faissDir, 'active.txt'), 0o666);
      await fsp.chmod(modelDir, 0o770);
      await fsp.chmod(versionDir, 0o772);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.status).toBe('warn');
      const check = report.checks.find((c) => c.name === 'index_security');
      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('FAISS index boundary permission warning');
      expect(report.index_security.entries).toEqual([
        expect.objectContaining({
          name: 'faiss_root',
          permission_status: 'warn',
          warnings: expect.arrayContaining([
            'group_writable: mode 0777',
            'world_writable: mode 0777',
          ]),
        }),
        expect.objectContaining({
          name: 'active_file',
          permission_status: 'warn',
          warnings: expect.arrayContaining([
            'group_writable: mode 0666',
            'world_writable: mode 0666',
          ]),
        }),
        expect.objectContaining({
          name: 'active_model_dir',
          permission_status: 'warn',
          warnings: expect.arrayContaining(['group_writable: mode 0770']),
        }),
        expect.objectContaining({
          name: 'active_index_version_dir',
          permission_status: 'warn',
          warnings: expect.arrayContaining([
            'group_writable: mode 0772',
            'world_writable: mode 0772',
          ]),
        }),
      ]);
      const md = formatDoctorMarkdown(report);
      expect(md).toMatch(/WARN\s+index_security:/);
      expect(md).toContain('faiss_root:');
      expect(md).toContain('world_writable: mode 0777');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports active model, index version/mtime, backend health, and stale counts by KB', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const extractionCacheDir = path.join(faissDir, 'extracted-text');
      await fsp.mkdir(path.join(rootDir, 'alpha', '.index'), { recursive: true });
      await fsp.mkdir(path.join(rootDir, 'beta', '.index'), { recursive: true });
      const alphaOld = path.join(rootDir, 'alpha', 'old.md');
      const alphaNewer = path.join(rootDir, 'alpha', 'newer.md');
      const betaUnsided = path.join(rootDir, 'beta', 'unsidecarred.md');
      await fsp.writeFile(alphaOld, 'old');
      await fsp.writeFile(alphaNewer, 'newer');
      await fsp.writeFile(betaUnsided, 'beta');
      await fsp.writeFile(path.join(rootDir, 'alpha', '.index', 'old.md'), 'hash');
      await fsp.writeFile(path.join(rootDir, 'alpha', '.index', 'newer.md'), 'hash');
      await fsp.mkdir(extractionCacheDir, { recursive: true });
      const extractionCacheEntry = path.join(extractionCacheDir, `${'c'.repeat(64)}.txt`);
      await fsp.writeFile(extractionCacheEntry, 'cached extracted text');
      await fsp.writeFile(path.join(extractionCacheDir, 'README.txt'), 'ignored');

      const modelDir = await seedRegisteredModel(faissDir);
      const inactiveVersionDir = path.join(modelDir, 'index.v2');
      await fsp.mkdir(inactiveVersionDir, { recursive: true });
      await fsp.writeFile(path.join(inactiveVersionDir, 'faiss.index'), 'old-index');
      const versionDir = path.join(modelDir, 'index.v3');
      await fsp.mkdir(versionDir, { recursive: true });
      const binaryPath = path.join(versionDir, 'faiss.index');
      await fsp.writeFile(binaryPath, 'fake-index');
      await fsp.symlink('index.v3', path.join(modelDir, 'index'), 'dir');

      const indexMs = 1_700_000_000_000;
      const oldMs = indexMs - 10_000;
      const newerMs = indexMs + 10_000;
      await fsp.utimes(binaryPath, indexMs / 1000, indexMs / 1000);
      await fsp.utimes(alphaOld, oldMs / 1000, oldMs / 1000);
      await fsp.utimes(alphaNewer, newerMs / 1000, newerMs / 1000);
      await fsp.utimes(betaUnsided, oldMs / 1000, oldMs / 1000);
      await fsp.utimes(extractionCacheEntry, oldMs / 1000, oldMs / 1000);
      await fsp.mkdir(path.join(tempDir, 'build'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, 'build', 'cli.js'), '#!/usr/bin/env node\n');
      const linkedBin = path.join(tempDir, 'kb-linked');
      await fsp.symlink(path.join(tempDir, 'build', 'cli.js'), linkedBin);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_INDEX_VERSION_RETENTION: '2',
        EXTRACTION_TEXT_CACHE_DIR: extractionCacheDir,
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: linkedBin,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: {
          status: 'success',
          scope: 'global',
          model_id: MODEL_ID,
          started_at: new Date(indexMs - 1000).toISOString(),
          finished_at: new Date(indexMs).toISOString(),
          duration_ms: 1000,
          files_scanned: 2,
          files_changed: 1,
          files_unchanged: 1,
          files_skipped: 0,
          chunks_attempted: 3,
          chunks_added: 3,
          index_mutated: true,
          saved: true,
          sidecars_written: true,
          warning_count: 0,
          warnings: [],
          failure_count: 0,
          failures: [],
        },
      });

      expect(report.status).toBe('warn');
      expect(report.active_model).toEqual({
        model_id: MODEL_ID,
        provider: 'huggingface',
        model_name: MODEL_NAME,
      });
      expect(report.index.version).toBe('index.v3');
      expect(report.index.mtime).toBe(new Date(indexMs).toISOString());
      expect(report.index.storage).toMatchObject({
        active_version_bytes: Buffer.byteLength('fake-index'),
        inactive_version_count: 1,
        inactive_version_bytes: Buffer.byteLength('old-index'),
        total_version_bytes: Buffer.byteLength('fake-index') + Buffer.byteLength('old-index'),
        retention_previous_versions: 2,
      });
      expect(report.extraction_cache).toMatchObject({
        cache_dir: extractionCacheDir,
        exists: true,
        entry_count: 1,
        total_bytes: Buffer.byteLength('cached extracted text'),
        oldest_mtime: new Date(oldMs).toISOString(),
        newest_mtime: new Date(oldMs).toISOString(),
        ignored_entry_count: 1,
        error_count: 0,
      });
      expect(report.checks).toContainEqual({
        name: 'extraction_cache',
        status: 'ok',
        detail: expect.stringContaining('1 cache entry'),
      });
      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'ok',
        detail: 'latest index update is success (scope=global, 0 failure(s))',
      });
      expect(report.backend).toMatchObject({ healthy: true, detail: 'backend ok' });
      expect(report.last_index_update).toMatchObject({
        status: 'success',
        scope: 'global',
        files_changed: 1,
        files_unchanged: 1,
      });
      expect(report.cli.symlinked_checkout_path).toBe(tempDir);
      expect(report.stale_counts_by_kb.alpha).toEqual({ modified_files: 1, new_files: 0 });
      expect(report.stale_counts_by_kb.beta).toEqual({ modified_files: 0, new_files: 1 });
      expect(report.quarantine_counts_by_kb).toEqual({ alpha: 0, beta: 0 });
      expect(report.incomplete_models).toEqual([]);

      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('Status: WARN');
      expect(markdown).toContain(`Active model: ${MODEL_ID}`);
      expect(markdown).toContain('Last index update: success (global, 1000ms, 1 changed, 1 unchanged, 0 skipped)');
      expect(markdown).toContain('Index storage:');
      expect(markdown).toContain('inactive across 1 retained inactive version(s); retention=2');
      expect(markdown).toContain('Extracted-text cache:');
      expect(markdown).toContain(`path: ${extractionCacheDir}`);
      expect(markdown).toContain('entries: 1, bytes=21 B, exists=yes');
      expect(markdown).toContain('alpha: 1 modified, 0 new');
      expect(markdown).toContain('beta: 0 modified, 1 new');
      expect(markdown).toContain('Ingest quarantine by KB:\n  alpha: 0 quarantined\n  beta: 0 quarantined');
      expect(markdown).toContain('Incomplete model dirs:\n  (none)');

      const json = JSON.parse(JSON.stringify(report)) as typeof report;
      expect(json.stale_counts_by_kb.alpha.modified_files).toBe(1);
      expect(json.quarantine_counts_by_kb.alpha).toBe(0);
      expect(json.last_index_update.saved).toBe(true);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports legacy indexes without an embedding canary as not recorded', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-canary-missing-'));
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.embedding_canary).toMatchObject({
        status: 'not_recorded',
        similarity: null,
      });
      expect(report.checks).toContainEqual({
        name: 'embedding_canary',
        status: 'ok',
        detail: expect.stringContaining('not recorded'),
      });
      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'ok',
        detail: 'no completed index update recorded',
      });
      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('Embedding canary:');
      expect(markdown).toContain('status: not_recorded');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('grades a partial rebuild and keeps fresh-index staleness non-ok', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-partial-index-update-'));
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);
      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: partialIndexUpdateSummary(),
      });

      expect(report.status).toBe('warn');
      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'warn',
        detail: 'latest index update is partial (scope=global, 37 failure(s))',
      });
      expect(report.checks).toContainEqual({
        name: 'staleness',
        status: 'warn',
        detail: expect.stringContaining('latest index update is partial with 37 failure(s)'),
      });
      expect(formatDoctorMarkdown(report)).toMatch(/WARN\s+index_update:/);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('grades a non-zero failure count even when the summary status is success', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-index-update-failures-'));
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);
      const summary = persistedSuccessSummary();
      summary.failure_count = 2;
      const { buildDoctorReport } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: summary,
      });

      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'warn',
        detail: 'latest index update is success (scope=global, 2 failure(s))',
      });
      expect(report.checks.find((check) => check.name === 'staleness')?.status).toBe('warn');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('grades a failed index update as an error and keeps staleness non-ok', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-failed-index-update-'));
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);
      const summary = persistedSuccessSummary();
      summary.status = 'failed';
      summary.failure_count = 1;
      summary.failures = [{
        relative_path: 'failed.md',
        phase: 'save',
        code: 'INDEX_SAVE_FAILED',
        message: 'index save failed',
      }];
      const { buildDoctorReport } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: summary,
      });

      expect(report.status).toBe('error');
      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'error',
        detail: 'latest index update is failed (scope=global, 1 failure(s))',
      });
      expect(report.checks.find((check) => check.name === 'staleness')?.status).toBe('warn');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('grades deferred or skipped files as an incomplete index update', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-index-update-deferrals-'));
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);
      const summary = persistedSuccessSummary();
      summary.warning_count = 1;
      summary.files_skipped = 1;
      const { buildDoctorReport } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: summary,
      });

      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'warn',
        detail: 'latest index update is success (scope=global, 0 failure(s), 1 warning(s), 1 skipped file(s))',
      });
      expect(report.checks).toContainEqual({
        name: 'staleness',
        status: 'warn',
        detail: expect.stringContaining(
          'latest index update is success with 0 failure(s), 1 warning(s), 1 skipped file(s)',
        ),
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('grades a persisted partial index update in a fresh doctor process', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-persisted-partial-update-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'alpha', 'a.md'), 'alpha');
      const modelDir = await seedRegisteredModel(faissDir);
      await fsp.writeFile(
        path.join(modelDir, 'last-index-update.json'),
        JSON.stringify({
          schema_version: 'kb.last-index-update.v1',
          summary: partialIndexUpdateSummary(),
        }),
      );

      const { buildDoctorReport, runDoctor } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.last_index_update.status).toBe('partial');
      expect(report.checks).toContainEqual({
        name: 'index_update',
        status: 'warn',
        detail: 'latest index update is partial (scope=global, 37 failure(s))',
      });
      expect(report.checks.find((check) => check.name === 'staleness')?.status).toBe('warn');

      const routed = await captureStdout(() => runDoctor(['--format=json']));
      const routedReport = JSON.parse(routed.stdout) as {
        status: string;
        last_index_update: { status: string };
        checks: Array<{ name: string; status: string }>;
      };
      expect(routed.code).toBe(routedReport.status === 'error' ? 1 : 0);
      expect(routedReport).toMatchObject({
        last_index_update: { status: 'partial' },
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'index_update', status: 'warn' }),
        ]),
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns when the persisted embedding canary no longer matches the active provider', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-canary-drift-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const fakeModelId = 'fake__bag-256d';
      const modelDir = path.join(faissDir, 'models', fakeModelId);
      const versionDir = path.join(modelDir, 'index.v1');
      await fsp.mkdir(rootDir, { recursive: true });
      await fsp.mkdir(versionDir, { recursive: true });
      await fsp.writeFile(path.join(modelDir, 'model_name.txt'), 'bag-256d');
      await fsp.writeFile(path.join(faissDir, 'active.txt'), fakeModelId);
      await fsp.writeFile(path.join(versionDir, 'faiss.index'), 'fake-index');
      await fsp.writeFile(path.join(versionDir, 'docstore.json'), '{}');
      await fsp.symlink('index.v1', path.join(modelDir, 'index'), 'dir');

      const {
        EMBEDDING_CANARY_ID,
        EMBEDDING_CANARY_TEXT_SHA256,
      } = await import('./faiss-store-layout.js');
      await fsp.writeFile(path.join(versionDir, 'integrity.json'), JSON.stringify({
        schema_version: 'kb.index-integrity.v1',
        written_at: '2026-06-13T00:00:00.000Z',
        model_id: fakeModelId,
        index_type: 'flat',
        embedding_canary: {
          canary_id: EMBEDDING_CANARY_ID,
          text_sha256: EMBEDDING_CANARY_TEXT_SHA256,
          embedding_role: 'document',
          captured_at: '2026-06-13T00:00:00.000Z',
          dimensions: 2,
          vector: [1, 0],
        },
        files: {
          'faiss.index': { sha256: '0'.repeat(64) },
          'docstore.json': { sha256: '1'.repeat(64) },
        },
      }), 'utf-8');

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'fake',
      });

      const report = await buildDoctorReport({
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.embedding_canary).toMatchObject({
        status: 'warn',
        canary_id: EMBEDDING_CANARY_ID,
        next_action: expect.stringContaining('docs/operations/switching-embedding-models.md'),
      });
      expect(report.checks).toContainEqual({
        name: 'embedding_canary',
        status: 'warn',
        detail: expect.stringContaining('incompatible'),
      });
      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('status: warn');
      expect(markdown).toContain('next_action: Review docs/operations/switching-embedding-models.md');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks Ollama backend unhealthy when the active embedding model is missing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-ollama-missing-model-'));
    const oldFetch = global.fetch;
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const modelDir = path.join(faissDir, 'models', OLLAMA_MODEL_ID);
      await fsp.mkdir(rootDir, { recursive: true });
      await fsp.mkdir(modelDir, { recursive: true });
      await fsp.writeFile(path.join(modelDir, 'model_name.txt'), OLLAMA_MODEL_NAME);
      await fsp.writeFile(path.join(faissDir, 'active.txt'), OLLAMA_MODEL_ID);
      await seedVersionedIndex(modelDir);

      const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('http://127.0.0.1:11434/api/embed');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: OLLAMA_MODEL_NAME,
          input: expect.stringContaining('kb doctor'),
        });
        return new Response(JSON.stringify({
          error: `model "${OLLAMA_MODEL_NAME}" not found, try pulling it first`,
        }), { status: 404 });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: OLLAMA_MODEL_NAME,
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      });

      const report = await buildDoctorReport({
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: persistedSuccessSummary(),
        daemonStatsPayload: async () => null,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(report.status).toBe('error');
      expect(report.backend).toMatchObject({
        provider: 'ollama',
        healthy: false,
      });
      expect(report.backend.detail).toContain('failed embedding probe');
      expect(report.backend.detail).toContain('model "nomic-embed-text:latest" not found');
      expect(report.checks).toContainEqual({
        name: 'backend',
        status: 'error',
        detail: report.backend.detail,
      });
      expect(formatDoctorMarkdown(report)).toMatch(/ERROR\s+backend:/);
    } finally {
      global.fetch = oldFetch;
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns when stale-count filesystem enumeration is partial', async () => {
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-enum-failure-'));
    const blockedDir = path.join(tempDir, 'kbs', 'alpha', 'blocked');
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);
      await fsp.mkdir(path.join(rootDir, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'alpha', 'ok.md'), 'ok');
      await fsp.mkdir(blockedDir, { recursive: true });
      await fsp.chmod(blockedDir, 0o000);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        lastIndexUpdateSummary: persistedSuccessSummary(),
      });

      const stalenessCheck = report.checks.find((check) => check.name === 'staleness');
      expect(stalenessCheck).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining('1 filesystem enumeration failure(s)'),
      });
      expect(report.filesystem.enumeration_failures.failure_count).toBe(1);
      expect(report.filesystem.enumeration_failures.failures[0]).toMatchObject({
        kbName: 'alpha',
        path: blockedDir,
        code: 'EACCES',
      });

      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('Filesystem enumeration:');
      expect(markdown).toContain('1 failure(s); stale counts may be partial');
      expect(markdown).toContain('alpha:');
    } finally {
      await fsp.chmod(blockedDir, 0o700).catch(() => undefined);
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports stale model write locks with owner metadata and recovery guidance', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-locks-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      const lockPath = path.join(modelDir, '.kb-write.lock');
      const ownerPath = path.join(modelDir, '.kb-write.lock.owner.json');
      await fsp.mkdir(lockPath);
      await fsp.writeFile(ownerPath, JSON.stringify({
        schema_version: 'kb.write-lock-owner.v1',
        pid: 999999999,
        command: 'kb search --refresh stale',
        cwd: tempDir,
        hostname: 'test-host',
        started_at: '2026-05-22T00:00:00.000Z',
      }));
      const oldMs = Date.now() - 60_000;
      await fsp.utimes(lockPath, oldMs / 1000, oldMs / 1000);

      const { buildDoctorLocksReport, formatDoctorLocksMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
      });

      const report = await buildDoctorLocksReport();

      expect(report).toMatchObject({
        schema_version: 'kb.doctor.locks.v1',
        status: 'warn',
        summary: {
          total: 1,
          held: 0,
          stale_suspected: 1,
          unknown: 0,
        },
      });
      expect(report.locks).toEqual([
        expect.objectContaining({
          model_id: MODEL_ID,
          model_name: MODEL_NAME,
          present: true,
          lock_kind: 'directory',
          stale_suspected: true,
          status: 'stale',
          owner: expect.objectContaining({
            pid: 999999999,
            live: false,
            command: 'kb search --refresh stale',
            source: 'metadata',
          }),
          next_action: expect.stringContaining('recorded owner PID is no longer live'),
        }),
      ]);
      const markdown = formatDoctorLocksMarkdown(report);
      expect(markdown).toContain('Status: WARN');
      expect(markdown).toContain('STALE huggingface__BAAI-bge-small-en-v1.5');
      expect(markdown).toContain('owner: pid=999999999, live=no');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports active external LLM profile readiness in JSON and markdown', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-llm-external-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const llmConfigDir = path.join(tempDir, 'llm-config');
      const llmStateDir = path.join(tempDir, 'llm-state');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      await seedVersionedIndex(modelDir);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: llmStateDir,
        KB_RELEVANCE_GATE: 'off',
        KB_GATE_LLM_ENDPOINT: '',
      });
      const { createExternalProfile, writeActiveProfile, writeProfile } = await import('./llm-profiles.js');
      const profile = await createExternalProfile(
        'local-research-agent',
        'http://127.0.0.1:8080',
        'local-research-agent',
      );
      await writeProfile(profile);
      await writeActiveProfile(profile.name);

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: async (endpoint) => ({
          endpoint,
          health_url: 'http://127.0.0.1:8080/health',
          health_ok: true,
          chat_ok: true,
          detail: 'health and chat completion succeeded',
        }),
      });

      expect(report.llm_endpoint).toMatchObject({
        status: 'ok',
        endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
        health_url: 'http://127.0.0.1:8080/health',
        endpoint_source: 'profile',
        profile_name: 'local-research-agent',
        profile_mode: 'external',
        managed_by: 'local-research-agent',
        unit_name: null,
        health_ok: true,
        chat_ok: true,
        next_action: null,
      });
      expect(report.checks).toContainEqual({
        name: 'llm_endpoint',
        status: 'ok',
        detail: expect.stringContaining('ready; profile=local-research-agent'),
      });
      expect(report.gate_llm_endpoint).toMatchObject({
        status: 'skipped',
        configured: false,
        source: 'not_configured',
      });
      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('LLM endpoint:');
      expect(markdown).toContain('source: profile');
      expect(markdown).toContain('managed_by: local-research-agent');
      expect(markdown).toContain('chat_ok: yes');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('includes relevance-gate readiness in the full doctor report', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-gate-full-report-'));
    try {
      const { rootDir, faissDir } = await seedDoctorBase(tempDir);
      const llmConfigDir = path.join(tempDir, 'llm-config');
      const llmStateDir = path.join(tempDir, 'llm-state');
      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: llmStateDir,
        KB_LLM_ENDPOINT: '',
        KB_LLM_PROVIDER: 'local',
        KB_LLM_FAKE: 'off',
        KB_RELEVANCE_GATE: 'on',
        KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:9090',
        KB_GATE_LLM_MODEL: 'gate-model',
        KB_GATE_LLM_TIMEOUT_MS: '100',
      });
      const probed: string[] = [];
      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: async (endpoint) => {
          probed.push(endpoint);
          const gate = endpoint.startsWith('http://127.0.0.1:9090/');
          return {
            endpoint,
            health_url: endpoint.replace(/\/v1\/chat\/completions$/, '/health'),
            health_ok: !gate,
            chat_ok: !gate,
            detail: gate
              ? 'health failed: gate unavailable'
              : 'health and chat completion succeeded',
          };
        },
      });

      expect(probed).toEqual([
        'http://127.0.0.1:8080/v1/chat/completions',
        'http://127.0.0.1:9090/v1/chat/completions',
      ]);
      expect(report.status).toBe('warn');
      expect(report.gate_llm_endpoint).toMatchObject({
        name: 'gate_llm_endpoint',
        kind: 'http',
        status: 'error',
        configured: true,
        target: 'http://127.0.0.1:9090/v1/chat/completions',
        source: 'env',
        detail: expect.stringContaining('gate unavailable'),
      });
      expect(report.checks).toContainEqual({
        name: 'gate_llm_endpoint',
        status: 'warn',
        detail: expect.stringContaining('gate unavailable'),
      });
      expect(formatDoctorMarkdown(report)).toContain('Gate LLM endpoint:');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns on an unhealthy managed LLM endpoint without starting the service', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-llm-managed-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const llmConfigDir = path.join(tempDir, 'llm-config');
      const llmStateDir = path.join(tempDir, 'llm-state');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      await seedVersionedIndex(modelDir);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: llmStateDir,
        KB_RELEVANCE_GATE: 'off',
        KB_GATE_LLM_ENDPOINT: '',
      });
      const { createManagedProfile, writeActiveProfile, writeProfile } = await import('./llm-profiles.js');
      const modelPath = path.join(tempDir, 'model.gguf');
      await fsp.writeFile(modelPath, 'model-bytes', 'utf-8');
      const profile = await createManagedProfile({
        name: 'qwen',
        runnerBin: '/bin/llama-server',
        modelPath,
        port: 8091,
      });
      await writeProfile(profile);
      await writeActiveProfile(profile.name);

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: async (endpoint) => ({
          endpoint,
          health_url: 'http://127.0.0.1:8091/health',
          health_ok: false,
          chat_ok: false,
          detail: 'health failed: connect ECONNREFUSED; chat failed: local LLM request failed: connect ECONNREFUSED',
        }),
      });

      expect(report.llm_endpoint).toMatchObject({
        status: 'warn',
        endpoint: 'http://127.0.0.1:8091/v1/chat/completions',
        endpoint_source: 'profile',
        profile_name: 'qwen',
        profile_mode: 'managed',
        unit_name: 'kb-llm@qwen.service',
        managed_by: null,
        health_ok: false,
        chat_ok: false,
      });
      expect(report.llm_endpoint.next_action).toContain('kb llm start --profile=qwen');
      expect(report.checks).toContainEqual({
        name: 'llm_endpoint',
        status: 'warn',
        detail: expect.stringContaining('not ready; profile=qwen'),
      });
      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('unit: kb-llm@qwen.service');
      expect(markdown).toContain('chat_ok: no');
      expect(markdown).toContain('next_action: Run kb llm start --profile=qwen');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses KB_LLM_ENDPOINT before the active LLM profile', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-llm-env-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const llmConfigDir = path.join(tempDir, 'llm-config');
      const llmStateDir = path.join(tempDir, 'llm-state');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      await seedVersionedIndex(modelDir);

      const { buildDoctorReport } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: llmStateDir,
        KB_LLM_ENDPOINT: 'http://127.0.0.1:9999',
        KB_RELEVANCE_GATE: 'off',
        KB_GATE_LLM_ENDPOINT: '',
      });
      const { createExternalProfile, writeActiveProfile, writeProfile } = await import('./llm-profiles.js');
      const profile = await createExternalProfile('active-profile', 'http://127.0.0.1:8080');
      await writeProfile(profile);
      await writeActiveProfile(profile.name);

      const probed: string[] = [];
      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: async (endpoint) => {
          probed.push(endpoint);
          return {
            endpoint,
            health_url: 'http://127.0.0.1:9999/health',
            health_ok: true,
            chat_ok: false,
            detail: 'health HTTP 200; chat failed: local LLM returned non-JSON response: Unexpected token',
          };
        },
      });

      expect(probed).toEqual(['http://127.0.0.1:9999/v1/chat/completions']);
      expect(report.llm_endpoint).toMatchObject({
        status: 'warn',
        endpoint_source: 'env',
        profile_name: 'env',
        profile_mode: 'external',
        health_ok: true,
        chat_ok: false,
      });
      expect(report.llm_endpoint.detail).toContain('chat failed');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the production LLM endpoint probe when no test probe is injected', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-llm-default-probe-'));
    const oldFetch = global.fetch;
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const llmConfigDir = path.join(tempDir, 'llm-config');
      const llmStateDir = path.join(tempDir, 'llm-state');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      await seedVersionedIndex(modelDir);

      const fetchMock = jest.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          return new Response('{"status":"ok"}', { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const { buildDoctorReport } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: llmStateDir,
        KB_LLM_ENDPOINT: '',
        KB_LLM_PROVIDER: 'local',
        KB_LLM_FAKE: 'off',
        KB_RELEVANCE_GATE: 'on',
        KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:9090',
        KB_GATE_LLM_MODEL: 'gate-model',
        KB_GATE_LLM_TIMEOUT_MS: '100',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
      });

      expect(report.llm_endpoint).toMatchObject({
        status: 'ok',
        endpoint_source: 'default',
        profile_name: 'local-research-agent',
        profile_mode: 'external',
        managed_by: 'local-research-agent',
        endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
        health_url: 'http://127.0.0.1:8080/health',
        health_ok: true,
        chat_ok: true,
      });
      expect(report.gate_llm_endpoint).toMatchObject({
        status: 'ok',
        configured: true,
        target: 'http://127.0.0.1:9090/v1/chat/completions',
      });
      const calls = fetchMock.mock.calls as unknown as Array<[
        string | URL | Request,
        RequestInit | undefined,
      ]>;
      const gateChatCall = calls.find(([input]) => String(input) === 'http://127.0.0.1:9090/v1/chat/completions');
      expect(gateChatCall).toBeDefined();
      expect(JSON.parse(String(gateChatCall?.[1]?.body))).toMatchObject({ model: 'gate-model' });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/health',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      timeoutSpy.mockRestore();
      global.fetch = oldFetch;
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports reindex-trigger configuration, filesystem state, and freshness in markdown and JSON', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-trigger-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const modelDir = await seedRegisteredModel(faissDir);
      const versionDir = await seedVersionedIndex(modelDir);
      const binaryPath = path.join(versionDir, 'faiss.index');
      const triggerPath = path.join(rootDir, '.reindex-trigger');
      await fsp.writeFile(triggerPath, '');

      const indexMs = 1_700_000_000_000;
      const triggerMs = indexMs + 5_000;
      await fsp.utimes(binaryPath, indexMs / 1000, indexMs / 1000);
      await fsp.utimes(triggerPath, triggerMs / 1000, triggerMs / 1000);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        REINDEX_TRIGGER_PATH: triggerPath,
        REINDEX_TRIGGER_POLL_MS: '2000',
        KB_FS_WATCH: '1',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.reindex_trigger).toMatchObject({
        status: 'warn',
        enabled: true,
        poll_ms: 2000,
        poll_ms_source: 'env',
        path: triggerPath,
        path_source: 'env',
        kb_fs_watch_enabled: true,
        trigger_file: {
          exists: true,
          kind: 'file',
          mtime: new Date(triggerMs).toISOString(),
        },
        parent: {
          path: rootDir,
          exists: true,
          writable: true,
        },
        freshness: {
          index_mtime: new Date(indexMs).toISOString(),
          trigger_mtime: new Date(triggerMs).toISOString(),
          trigger_newer_than_index: true,
        },
      });
      expect(report.reindex_trigger.warnings).toEqual([
        'trigger file is newer than the active index; a refresh may be pending',
      ]);
      expect(report.checks).toContainEqual({
        name: 'reindex_trigger',
        status: 'warn',
        detail: expect.stringContaining('reindex-trigger warning'),
      });

      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('Reindex trigger:');
      expect(markdown).toContain(`path: ${triggerPath} (env)`);
      expect(markdown).toContain('poll: 2000ms (env)');
      expect(markdown).toContain('freshness: trigger newer than active index');
      expect(markdown).toContain('configuration and filesystem state only');
      expect(markdown).not.toContain('actively watching: yes');

      const json = JSON.parse(JSON.stringify(report)) as typeof report;
      expect(json.reindex_trigger.freshness.trigger_newer_than_index).toBe(true);
      expect(json.reindex_trigger.limitation).toContain('cannot prove');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns when a KB has quarantined ingest failures', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-quarantine-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'alpha', 'bad.md'), 'bad');
      await seedRegisteredModel(faissDir);

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      const { recordIngestFailure } = await import('./ingest-quarantine.js');
      await recordIngestFailure({
        kbPath: path.join(rootDir, 'alpha'),
        relativePath: 'bad.md',
        sourceHash: 'hash-bad',
        error: new Error('cannot parse'),
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.quarantine_counts_by_kb).toEqual({ alpha: 1 });
      expect(report.checks).toContainEqual({
        name: 'INGEST_QUARANTINE_NONZERO',
        status: 'warn',
        detail: '1 quarantined ingest file(s) detected',
      });
      expect(formatDoctorMarkdown(report)).toContain('Ingest quarantine by KB:\n  alpha: 1 quarantined');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the persisted update summary for a fresh-process doctor report', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-persisted-summary-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'alpha', 'a.md'), 'alpha');
      const modelDir = await seedRegisteredModel(faissDir);
      await fsp.writeFile(
        path.join(modelDir, 'last-index-update.json'),
        JSON.stringify({
          schema_version: 'kb.last-index-update.v1',
          summary: persistedSuccessSummary(),
        }),
      );

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.last_index_update).toMatchObject({
        status: 'success',
        scope: 'global',
        model_id: MODEL_ID,
        duration_ms: 5000,
        files_changed: 2,
        files_unchanged: 2,
      });
      expect(formatDoctorMarkdown(report)).toContain(
        'Last index update: success (global, 5000ms, 2 changed, 2 unchanged, 0 skipped)',
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns about stale incomplete model directories', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-incomplete-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'alpha'), { recursive: true });
      const staleId = 'ollama__nomic-embed-text';
      await seedRegisteredModel(faissDir);
      await fsp.mkdir(path.join(faissDir, 'models', staleId), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', staleId, '.adding'), JSON.stringify({
        schema_version: 'kb.model-adding.v1',
        model_id: staleId,
        provider: 'ollama',
        model_name: 'nomic-embed-text',
        pid: 999999999,
        started_at: '2026-05-11T10:00:00.000Z',
      }));

      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.checks).toContainEqual({
        name: 'incomplete_models',
        status: 'warn',
        detail: '1 stale incomplete model directory detected',
      });
      expect(report.incomplete_models).toEqual([expect.objectContaining({
        model_id: staleId,
        status: 'stale_interrupted',
        pid: 999999999,
        recovery_command: 'kb models add ollama nomic-embed-text --recover --yes',
      })]);
      expect(formatDoctorMarkdown(report)).toContain(
        `stale_interrupted ${staleId}: previous kb models add writer pid 999999999 is no longer running`,
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an error report when no active model/index/backend is healthy', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-error-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'alpha'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'alpha', 'note.md'), 'note');

      const { buildDoctorReport } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: false, detail: 'backend down' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.status).toBe('error');
      expect(report.active_model.model_id).toBeNull();
      expect(report.index.binary_path).toBeNull();
      expect(report.backend.healthy).toBe(false);
      expect(report.stale_counts_by_kb.alpha).toEqual({ modified_files: 0, new_files: 1 });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports endpoint readiness for available bind and reachable configured HTTP targets', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-endpoints-ok-'));
    const reserved = net.createServer();
    try {
      const port = await listen(reserved);
      await closeServer(reserved);
      const { buildEndpointReadinessReport, formatEndpointReadinessMarkdown } = await freshDoctor({
        MCP_TRANSPORT: 'http',
        MCP_BIND_ADDR: '127.0.0.1',
        MCP_PORT: String(port),
        KB_DAEMON_URL: 'http://127.0.0.1:17799',
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        KB_LLM_ENDPOINT: 'http://127.0.0.1:8080',
        KB_RELEVANCE_GATE: 'off',
        KB_GATE_LLM_ENDPOINT: '',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });
      const fetchMock = jest.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:17799/health') {
          return new Response('{"status":"ok"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'http://127.0.0.1:11434/api/tags') {
          return new Response('{"models":[]}', { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const report = await buildEndpointReadinessReport({
        fetchImpl: fetchMock as unknown as typeof fetch,
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.status).toBe('ok');
      expect(report.endpoints).toEqual([
        expect.objectContaining({
          name: 'mcp_bind',
          status: 'ok',
          configured: true,
          target: `127.0.0.1:${port}`,
        }),
        expect.objectContaining({
          name: 'kb_daemon',
          status: 'ok',
          target: 'http://127.0.0.1:17799/health',
        }),
        expect.objectContaining({
          name: 'embedding_ollama',
          status: 'ok',
          target: 'http://127.0.0.1:11434/api/tags',
        }),
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'ok',
          target: 'http://127.0.0.1:8080/v1/chat/completions',
        }),
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'skipped',
          configured: false,
        }),
      ]);
      const markdown = formatEndpointReadinessMarkdown(report);
      expect(markdown).toContain('Endpoint readiness:');
      expect(markdown).toContain('OK      mcp_bind');
      expect(JSON.parse(JSON.stringify(report)).schema_version).toBe('kb.doctor.endpoints.v1');
    } finally {
      await closeServer(reserved).catch(() => undefined);
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('probes a configured gate endpoint and preserves ask endpoint behavior', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-gate-endpoint-'));
    try {
      const probed: string[] = [];
      const probedModels: Array<string | undefined> = [];
      const probedTimeouts: Array<number | undefined> = [];
      let gateHealthOk = true;
      let gateChatOk = true;
      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'stdio',
        KB_DAEMON_URL: '',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: 'http://127.0.0.1:8080',
        KB_LLM_PROVIDER: 'local',
        KB_LLM_FAKE: 'off',
        KB_RELEVANCE_GATE: 'on',
        KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:9090',
        KB_GATE_LLM_MODEL: 'gate-model',
        KB_GATE_LLM_TIMEOUT_MS: '100',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });

      const probe = async (
        endpoint: string,
        options?: { model?: string; chatTimeoutMs?: number },
      ) => {
        probed.push(endpoint);
        probedModels.push(options?.model);
        probedTimeouts.push(options?.chatTimeoutMs);
        const gate = endpoint.startsWith('http://127.0.0.1:9090/');
        return {
          endpoint,
          health_url: `${endpoint.replace(/\/v1\/chat\/completions$/, '')}/health`,
          health_ok: !gate || gateHealthOk,
          chat_ok: !gate || gateChatOk,
          detail: gate && (!gateHealthOk || !gateChatOk)
            ? 'health failed: gate unavailable'
            : 'health and chat completion succeeded',
        };
      };

      const healthyReport = await buildEndpointReadinessReport({ llmEndpointProbe: probe });

      expect(healthyReport.status).toBe('ok');
      expect(healthyReport.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'ok',
          target: 'http://127.0.0.1:8080/v1/chat/completions',
        }),
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'ok',
          configured: true,
          source: 'env',
          target: 'http://127.0.0.1:9090/v1/chat/completions',
        }),
      ]));

      gateHealthOk = false;
      const unhealthyReport = await buildEndpointReadinessReport({ llmEndpointProbe: probe });

      expect(unhealthyReport.status).toBe('error');
      expect(probed).toEqual([
        'http://127.0.0.1:8080/v1/chat/completions',
        'http://127.0.0.1:9090/v1/chat/completions',
        'http://127.0.0.1:8080/v1/chat/completions',
        'http://127.0.0.1:9090/v1/chat/completions',
      ]);
      expect(probedModels).toEqual([undefined, 'gate-model', undefined, 'gate-model']);
      expect(probedTimeouts).toEqual([undefined, 100, undefined, 100]);
      expect(unhealthyReport.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'ok',
          target: 'http://127.0.0.1:8080/v1/chat/completions',
        }),
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'error',
          configured: true,
          source: 'env',
          target: 'http://127.0.0.1:9090/v1/chat/completions',
          detail: expect.stringContaining('gate unavailable'),
        }),
      ]));

      gateHealthOk = true;
      gateChatOk = false;
      const chatUnhealthyReport = await buildEndpointReadinessReport({ llmEndpointProbe: probe });
      expect(chatUnhealthyReport.status).toBe('error');
      expect(chatUnhealthyReport.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'error',
          target: 'http://127.0.0.1:9090/v1/chat/completions',
          detail: expect.stringContaining('gate unavailable'),
        }),
      ]));

      const rejectedReport = await buildEndpointReadinessReport({
        llmEndpointProbe: async (endpoint) => {
          if (endpoint.startsWith('http://127.0.0.1:9090/')) {
            throw new Error('connection reset');
          }
          return healthyLlmProbe(endpoint);
        },
      });

      expect(rejectedReport.status).toBe('error');
      expect(rejectedReport.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'error',
          configured: true,
          target: 'http://127.0.0.1:9090/v1/chat/completions',
          source: 'env',
          detail: 'Gate LLM endpoint probe failed: connection reset',
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the default probe with the gate model and timeout', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-gate-endpoint-default-probe-'));
    try {
      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'stdio',
        KB_DAEMON_URL: '',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: '',
        KB_LLM_PROVIDER: 'local',
        KB_LLM_FAKE: 'off',
        KB_RELEVANCE_GATE: 'on',
        KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:9090',
        KB_GATE_LLM_MODEL: 'gate-model',
        KB_GATE_LLM_TIMEOUT_MS: '100',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });
      const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          expect(init?.method).toBe('GET');
          return new Response('{"status":"ok"}', { status: 200 });
        }
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gate-model' });
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const report = await buildEndpointReadinessReport({
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(report.status).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(report.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'ok',
          configured: true,
          target: 'http://127.0.0.1:9090/v1/chat/completions',
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['disabled', 'off', 'http://127.0.0.1:9090'],
    ['unset', 'on', ''],
  ])('skips the gate endpoint when the gate is %s', async (_caseName, gateSetting, endpoint) => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-gate-endpoint-skipped-'));
    try {
      const probe = jest.fn(healthyLlmProbe);
      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'stdio',
        KB_DAEMON_URL: '',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: '',
        KB_RELEVANCE_GATE: gateSetting,
        KB_GATE_LLM_ENDPOINT: endpoint,
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });

      const report = await buildEndpointReadinessReport({ llmEndpointProbe: probe });

      expect(report.status).toBe('ok');
      expect(probe).not.toHaveBeenCalled();
      expect(report.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'skipped',
          configured: false,
        }),
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'skipped',
          configured: false,
          source: 'not_configured',
          target: null,
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips an unset gate endpoint while retaining an explicitly configured ask endpoint', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-gate-endpoint-ask-configured-'));
    try {
      const probe = jest.fn(healthyLlmProbe);
      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'stdio',
        KB_DAEMON_URL: '',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: 'http://127.0.0.1:8080',
        KB_RELEVANCE_GATE: 'on',
        KB_GATE_LLM_ENDPOINT: '',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });

      const report = await buildEndpointReadinessReport({ llmEndpointProbe: probe });

      expect(report.status).toBe('ok');
      expect(probe).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/chat/completions');
      expect(report.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'ok',
          target: 'http://127.0.0.1:8080/v1/chat/completions',
        }),
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'skipped',
          configured: false,
          target: null,
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips a configured gate endpoint when the fake judge is active', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-gate-endpoint-fake-'));
    try {
      const probe = jest.fn(healthyLlmProbe);
      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'stdio',
        KB_DAEMON_URL: '',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: '',
        KB_LLM_FAKE: 'on',
        KB_RELEVANCE_GATE: 'on',
        KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:9090',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });

      const report = await buildEndpointReadinessReport({ llmEndpointProbe: probe });

      expect(report.status).toBe('ok');
      expect(probe).not.toHaveBeenCalled();
      expect(report.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'skipped',
          configured: false,
          target: null,
          detail: 'KB_LLM_FAKE is enabled; the gate uses the in-process fake judge',
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports endpoint errors for occupied bind targets and malformed endpoint config', async () => {
    const occupied = net.createServer();
    try {
      const port = await listen(occupied);
      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'sse',
        MCP_BIND_ADDR: '127.0.0.1',
        MCP_PORT: String(port),
        KB_DAEMON_URL: 'not a url',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: '',
        KB_RELEVANCE_GATE: 'off',
        KB_GATE_LLM_ENDPOINT: '',
        KB_LLM_CONFIG_DIR: path.join(os.tmpdir(), 'kb-doctor-endpoints-empty-config'),
        KB_LLM_STATE_DIR: path.join(os.tmpdir(), 'kb-doctor-endpoints-empty-state'),
      });

      const report = await buildEndpointReadinessReport({
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.status).toBe('error');
      expect(report.endpoints).toEqual([
        expect.objectContaining({
          name: 'mcp_bind',
          status: 'error',
          detail: expect.stringContaining('EADDRINUSE'),
        }),
        expect.objectContaining({
          name: 'kb_daemon',
          status: 'error',
          source: 'invalid',
          detail: expect.stringContaining('invalid KB_DAEMON_URL'),
        }),
        expect.objectContaining({
          name: 'embedding_ollama',
          status: 'skipped',
          configured: false,
        }),
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'skipped',
          configured: false,
        }),
        expect.objectContaining({
          name: 'gate_llm_endpoint',
          status: 'skipped',
          configured: false,
        }),
      ]);
    } finally {
      await closeServer(occupied);
    }
  });

  it('reports malformed transport and dangling active LLM profile as endpoint errors', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-endpoints-config-errors-'));
    try {
      const llmConfigDir = path.join(tempDir, 'llm-config');
      await fsp.mkdir(llmConfigDir, { recursive: true });
      await fsp.writeFile(path.join(llmConfigDir, 'active.txt'), 'missing-profile\n');

      const { buildEndpointReadinessReport } = await freshDoctor({
        MCP_TRANSPORT: 'htp',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: '',
      });

      const report = await buildEndpointReadinessReport({
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.status).toBe('error');
      expect(report.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'mcp_bind',
          status: 'error',
          source: 'invalid',
          detail: 'invalid MCP_TRANSPORT="htp"; expected one of stdio|sse|http',
        }),
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'error',
          source: 'invalid',
          detail: 'active LLM profile "missing-profile" is configured but profile file is missing',
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('routes --endpoints through runDoctor with JSON output and exit codes', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-run-endpoints-'));
    try {
      const { runDoctor } = await freshDoctor({
        MCP_TRANSPORT: '',
        MCP_PORT: '',
        MCP_BIND_ADDR: '',
        KB_DAEMON_URL: '',
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        KB_LLM_ENDPOINT: '',
        KB_RELEVANCE_GATE: 'off',
        KB_GATE_LLM_ENDPOINT: '',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });

      const ok = await captureStdout(() => runDoctor(['--endpoints', '--format=json']));
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({
        schema_version: 'kb.doctor.endpoints.v1',
        status: 'ok',
        endpoints: expect.arrayContaining([
          expect.objectContaining({ name: 'mcp_bind', status: 'skipped' }),
        ]),
      });

      process.env.MCP_PORT = '0';
      const error = await captureStdout(() => runDoctor(['--endpoints', '--format=json']));
      expect(error.code).toBe(1);
      expect(JSON.parse(error.stdout)).toMatchObject({
        schema_version: 'kb.doctor.endpoints.v1',
        status: 'error',
        endpoints: expect.arrayContaining([
          expect.objectContaining({
            name: 'mcp_bind',
            status: 'error',
            detail: 'invalid MCP_PORT="0"; expected integer in [1, 65535]',
          }),
        ]),
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('routes --locks through runDoctor with JSON output', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-run-locks-'));
    try {
      const { runDoctor } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kbs'),
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
      });

      const ok = await captureStdout(() => runDoctor(['--locks', '--format=json']));
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({
        schema_version: 'kb.doctor.locks.v1',
        status: 'ok',
        summary: {
          total: 0,
          held: 0,
          stale_suspected: 0,
          unknown: 0,
        },
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  itOnPosix('routes --kb-symlinks through runDoctor with JSON output', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-run-kb-symlinks-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const alphaDir = path.join(rootDir, 'alpha');
      const betaDir = path.join(rootDir, 'beta');
      const outsideDir = path.join(tempDir, 'outside');
      await fsp.mkdir(alphaDir, { recursive: true });
      await fsp.mkdir(betaDir, { recursive: true });
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(betaDir, 'inside.md'), 'inside');
      await fsp.writeFile(path.join(outsideDir, 'outside.md'), 'outside');
      await fsp.symlink(path.join(betaDir, 'inside.md'), path.join(alphaDir, 'inside-link.md'));
      await fsp.symlink(path.join(outsideDir, 'outside.md'), path.join(alphaDir, 'outside-link.md'));
      await fsp.symlink(path.join(alphaDir, 'missing.md'), path.join(alphaDir, 'broken-link.md'));
      await fsp.symlink('loop-b', path.join(alphaDir, 'loop-a'));
      await fsp.symlink('loop-a', path.join(alphaDir, 'loop-b'));

      const { runDoctor } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
      });

      const ok = await captureStdout(() => runDoctor(['--kb-symlinks', '--format=json']));
      expect(ok.code).toBe(0);
      const report = JSON.parse(ok.stdout);
      expect(report.schema_version).toBe('kb.doctor.kb_symlinks.v1');
      expect(report.status).toBe('warn');
      expect(report.inventory.summary).toEqual({
        total: 5,
        inside_root: 1,
        escaping: 1,
        broken: 1,
        loop_or_error: 2,
        scan_error_count: 0,
        sample_limit: 5,
      });
      expect(report.inventory.symlinks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kbName: 'alpha',
          relative_path: path.join('alpha', 'inside-link.md'),
          classification: 'inside_root',
        }),
        expect.objectContaining({
          relative_path: path.join('alpha', 'outside-link.md'),
          classification: 'escaping',
        }),
        expect.objectContaining({
          relative_path: path.join('alpha', 'broken-link.md'),
          classification: 'broken',
          error_code: 'ENOENT',
        }),
        expect.objectContaining({
          relative_path: path.join('alpha', 'loop-a'),
          classification: 'loop_or_error',
          error_code: 'ELOOP',
        }),
      ]));
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('routes --kb-symlinks scan errors through runDoctor with JSON output and exit codes', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-run-kb-symlinks-error-'));
    try {
      const missingRoot = path.join(tempDir, 'missing-kbs');
      const { runDoctor } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: missingRoot,
      });

      const error = await captureStdout(() => runDoctor(['--kb-symlinks', '--format=json']));
      expect(error.code).toBe(1);
      expect(JSON.parse(error.stdout)).toMatchObject({
        schema_version: 'kb.doctor.kb_symlinks.v1',
        status: 'error',
        inventory: {
          root_dir: missingRoot,
          root_realpath: null,
          summary: expect.objectContaining({
            total: 0,
            scan_error_count: 1,
          }),
          scan_errors: [
            expect.objectContaining({
              path: missingRoot,
              code: 'ENOENT',
            }),
          ],
        },
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  itOnPosix('formats --kb-symlinks markdown without following symlink directories', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-md-kb-symlinks-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const alphaDir = path.join(rootDir, 'alpha');
      const outsideDir = path.join(tempDir, 'outside');
      await fsp.mkdir(alphaDir, { recursive: true });
      await fsp.mkdir(path.join(outsideDir, 'nested'), { recursive: true });
      await fsp.writeFile(path.join(outsideDir, 'nested', 'secret.md'), 'outside');
      await fsp.symlink(outsideDir, path.join(alphaDir, 'outside-dir'));

      const { buildDoctorKbSymlinksReport, formatDoctorKbSymlinksMarkdown, runDoctor } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
      });

      const report = await buildDoctorKbSymlinksReport();
      expect(report.inventory.summary).toMatchObject({
        total: 1,
        escaping: 1,
      });
      const markdown = formatDoctorKbSymlinksMarkdown(report);
      expect(markdown).toContain('Symlinks: 1 total, 0 inside-root, 1 escaping');
      expect(markdown).toContain(`${path.join('alpha', 'outside-dir')} ->`);
      expect(markdown).not.toContain('secret.md');

      const routed = await captureStdout(() => runDoctor(['--kb-symlinks']));
      expect(routed.code).toBe(0);
      expect(routed.stdout).toContain('Symlinks: 1 total, 0 inside-root, 1 escaping');
      expect(routed.stdout).toContain(`${path.join('alpha', 'outside-dir')} ->`);
      expect(routed.stdout).not.toContain('secret.md');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses --format=json, --endpoints, --locks, --kb-symlinks, and rejects unsupported formats', async () => {
    const { parseDoctorArgs } = await freshDoctor({});
    expect(parseDoctorArgs(['--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: false,
      endpoints: false,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs(['--reindex-trigger'])).toEqual({
      format: 'md',
      reindexTrigger: true,
      endpoints: false,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs(['--endpoints', '--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: false,
      endpoints: true,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs(['--locks', '--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: false,
      endpoints: false,
      locks: true,
      kbSymlinks: false,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs(['--kb-symlinks', '--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: false,
      endpoints: false,
      locks: false,
      kbSymlinks: true,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs(['--reindex-trigger', '--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: true,
      endpoints: false,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs([])).toEqual({
      format: 'md',
      reindexTrigger: false,
      endpoints: false,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: null,
    });
    expect(parseDoctorArgs(['--bug-report=/tmp/out'])).toEqual({
      format: 'md',
      reindexTrigger: false,
      endpoints: false,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: {
        outputParentDir: '/tmp/out',
        includeCommand: false,
        command: undefined,
      },
    });
    expect(parseDoctorArgs([
      '--bug-report',
      '--include-command',
      '--',
      'node',
      '-e',
      'process.exit(1)',
    ])).toEqual({
      format: 'md',
      reindexTrigger: false,
      endpoints: false,
      locks: false,
      kbSymlinks: false,
      integrity: false,
      bugReport: {
        outputParentDir: undefined,
        includeCommand: true,
        command: ['node', '-e', 'process.exit(1)'],
      },
    });
    expect(() => parseDoctorArgs(['--format=yaml'])).toThrow(/invalid --format/);
    expect(() => parseDoctorArgs(['--bug-report', '--include-command'])).toThrow(/requires/);
    expect(() => parseDoctorArgs(['--endpoints', '--locks'])).toThrow(/cannot be combined/);
    expect(() => parseDoctorArgs(['--locks', '--kb-symlinks'])).toThrow(/cannot be combined/);
  });

  describe('age budgets (issue #218)', () => {
    async function seedKbWithSidecarMtime(
      rootDir: string,
      kbName: string,
      sidecarMtimeMs: number,
    ): Promise<void> {
      const indexDir = path.join(rootDir, kbName, '.index');
      await fsp.mkdir(indexDir, { recursive: true });
      const sidecar = path.join(indexDir, 'note.md');
      await fsp.writeFile(sidecar, 'hash');
      await fsp.utimes(sidecar, sidecarMtimeMs / 1000, sidecarMtimeMs / 1000);
      await fsp.writeFile(path.join(rootDir, kbName, 'note.md'), 'note');
    }

    it('omits the age_budget check entirely when no budgets are configured', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-age-none-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        await seedKbWithSidecarMtime(rootDir, 'alpha', Date.now() - 1000);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        });
        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });
        expect(report.age_budgets).toEqual({});
        expect(report.age_budget_config_errors).toEqual([]);
        expect(report.checks.some((c) => c.name === 'age_budget')).toBe(false);
        expect(formatDoctorMarkdown(report)).toContain('Age budgets:\n  (no budgets configured)');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('emits an AGE_BUDGET_BREACH warning when a KB is over budget', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-age-breach-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        const nowMs = Date.now();
        // alpha aged ~47h (over budget=24); beta aged ~12h (within budget=72).
        await seedKbWithSidecarMtime(rootDir, 'alpha', nowMs - 47 * 3_600_000);
        await seedKbWithSidecarMtime(rootDir, 'beta', nowMs - 12 * 3_600_000);

        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          KB_AGE_BUDGET_HOURS_ALPHA: '24',
          KB_AGE_BUDGET_HOURS_BETA: '72',
        });
        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });
        expect(report.age_budgets.alpha).toMatchObject({
          configured_hours: 24,
          breach: true,
        });
        expect(report.age_budgets.alpha.current_age_hours).not.toBeNull();
        expect(report.age_budgets.beta).toMatchObject({
          configured_hours: 72,
          breach: false,
        });
        const ageBudgetCheck = report.checks.find((c) => c.name === 'age_budget');
        expect(ageBudgetCheck?.status).toBe('warn');
        expect(ageBudgetCheck?.detail).toContain('kb=alpha');
        expect(ageBudgetCheck?.detail).toContain('budget=24h');
        const md = formatDoctorMarkdown(report);
        expect(md).toContain('AGE_BUDGET_BREACH: kb=alpha');
        expect(md).toContain('beta: age=');
        expect(md).toContain('budget=72h, ok');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('uses the global KB_AGE_BUDGET_HOURS fallback for KBs without a per-KB override', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-age-global-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        const nowMs = Date.now();
        await seedKbWithSidecarMtime(rootDir, 'alpha', nowMs - 100 * 3_600_000);
        const { buildDoctorReport } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          KB_AGE_BUDGET_HOURS: '24',
        });
        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });
        expect(report.age_budgets.alpha).toMatchObject({
          configured_hours: 24,
          breach: true,
        });
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('surfaces an error-level check when KB_AGE_BUDGET_HOURS_<KB> is malformed', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-age-bad-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        await seedKbWithSidecarMtime(rootDir, 'alpha', Date.now() - 1000);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          KB_AGE_BUDGET_HOURS_ALPHA: '0',
        });
        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });
        expect(report.age_budget_config_errors).toEqual([
          expect.objectContaining({
            env_var: 'KB_AGE_BUDGET_HOURS_ALPHA',
            raw_value: '0',
          }),
        ]);
        // Affected KB falls back to "no budget", so it does not appear in age_budgets.
        expect(report.age_budgets.alpha).toBeUndefined();
        const ageBudgetCheck = report.checks.find((c) => c.name === 'age_budget');
        expect(ageBudgetCheck?.status).toBe('error');
        expect(report.status).toBe('error');
        expect(formatDoctorMarkdown(report)).toContain(
          'CONFIG_ERROR: KB_AGE_BUDGET_HOURS_ALPHA="0"',
        );
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('provider call telemetry (issue #210)', () => {
    it('omits the provider_calls check when no telemetry has been recorded', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-pc-empty-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
        });
        const { ProviderCallMetrics } = await import('./metrics.js');
        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          providerCallMetrics: new ProviderCallMetrics({ now: () => 0 }),
        });
        expect(report.provider_calls).toEqual({});
        expect(report.checks.some((c) => c.name === 'provider_calls')).toBe(false);
        expect(formatDoctorMarkdown(report)).toContain(
          'Provider calls:\n  (no provider calls observed)',
        );
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('emits an OK provider_calls check when error rate is within budget', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-pc-ok-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
        });
        const { ProviderCallMetrics } = await import('./metrics.js');
        const metrics = new ProviderCallMetrics({ now: () => 1_700_000_000_000 });
        for (let index = 0; index < 100; index += 1) {
          metrics.record('huggingface__bge', { latencyMs: index, ok: true });
        }
        // 1 error out of 101 — under the 5% threshold.
        metrics.record('huggingface__bge', { latencyMs: 50, ok: false });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          providerCallMetrics: metrics,
        });
        const check = report.checks.find((c) => c.name === 'provider_calls');
        expect(check?.status).toBe('ok');
        expect(check?.detail).toContain('101 call(s)');
        const md = formatDoctorMarkdown(report);
        expect(md).toContain('model=huggingface__bge calls=101 errors=1');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('warns when error rate is above 5% and renders a WARN marker in markdown', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-pc-warn-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
        });
        const { ProviderCallMetrics } = await import('./metrics.js');
        const metrics = new ProviderCallMetrics({ now: () => 1_700_000_000_000 });
        // 8 errors / 10 calls — well above the 5% threshold.
        for (let index = 0; index < 2; index += 1) {
          metrics.record('ollama__nomic', { latencyMs: 5, ok: true });
        }
        for (let index = 0; index < 8; index += 1) {
          metrics.record('ollama__nomic', { latencyMs: 250, ok: false });
        }

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          providerCallMetrics: metrics,
        });
        const check = report.checks.find((c) => c.name === 'provider_calls');
        expect(check?.status).toBe('warn');
        expect(check?.detail).toContain('model=ollama__nomic');
        expect(check?.detail).toContain('errors=8/10');
        const md = formatDoctorMarkdown(report);
        expect(md).toContain('model=ollama__nomic calls=10 errors=8');
        expect(md).toMatch(/p50=\d+(\.\d+)?ms p95=\d+(\.\d+)?ms p99=\d+(\.\d+)?ms tokens=n\/a, WARN/);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('renders bounded chat-completion telemetry without adding a health check', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-llm-metrics-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
        });
        const { LlmCallMetrics } = await import('./metrics.js');
        const llmMetrics = new LlmCallMetrics({ now: () => 1_700_000_000_000 });
        llmMetrics.record('ask', {
          latencyMs: 12,
          ok: true,
          promptTokens: 20,
          completionTokens: 7,
          attempts: 2,
          provider: 'openrouter',
          model: 'deepseek-chat',
        });
        llmMetrics.record('gate', { latencyMs: 5, ok: false });
        const { AnswerCache } = await import('./ask-answer-cache.js');
        const answerCache = new AnswerCache({ enabled: false, indexPath: faissDir });
        await answerCache.get('0'.repeat(64));

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          llmCallMetrics: llmMetrics,
          answerCache,
        });
        expect(report.llm_calls?.ask).toMatchObject({ count: 1, errors: 0, prompt_tokens: 20 });
        expect(report.llm_calls?.gate).toMatchObject({ count: 1, errors: 1 });
        expect(report.llm_calls?.ask).toMatchObject({
          attempts: 2,
          retries: 1,
          attribution: [expect.objectContaining({ provider: 'openrouter', model: 'deepseek', attempts: 2 })],
        });
        expect(report.answer_cache?.outcomes).toEqual({ hit: 0, miss: 0, not_applicable: 1 });
        expect(report.checks.some((check) => check.name === 'llm_calls')).toBe(false);
        expect(formatDoctorMarkdown(report)).toContain(
          'operation=ask calls=1 errors=0 p95=29ms prompt_tokens=20 completion_tokens=7',
        );
        expect(formatDoctorMarkdown(report)).toContain('attempts=2 retries=1');
        expect(formatDoctorMarkdown(report)).toContain('Answer cache: hits=0 misses=0 writes=0');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('provider circuit breaker check (issue #747)', () => {
    async function doctorWithBreaker(
      configure?: (breaker: InstanceType<typeof import('./provider-breaker.js').ProviderBreakerRegistry>) => Promise<void>,
    ) {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-breaker-'));
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      await fsp.mkdir(faissDir, { recursive: true });
      const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
        KNOWLEDGE_BASES_ROOT_DIR: rootDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      const { ProviderBreakerRegistry } = await import('./provider-breaker.js');
      const breaker = new ProviderBreakerRegistry({
        failureThreshold: 1,
        cooldownMs: 30_000,
        now: () => 1_700_000_000_000,
      });
      if (configure !== undefined) await configure(breaker);
      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: healthyLlmProbe,
        providerBreaker: breaker,
      });
      return { report, formatDoctorMarkdown, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
    }

    it('omits the provider_circuit check when no breaker has tracked a call', async () => {
      const { report, formatDoctorMarkdown, cleanup } = await doctorWithBreaker();
      try {
        expect(report.provider_circuits).toEqual([]);
        expect(report.checks.some((c) => c.name === 'provider_circuit')).toBe(false);
        expect(formatDoctorMarkdown(report)).toContain(
          'Provider circuit breakers:\n  (no provider breakers tracked)',
        );
      } finally {
        await cleanup();
      }
    });

    it('emits an OK check when all tracked breakers are closed', async () => {
      const { report, formatDoctorMarkdown, cleanup } = await doctorWithBreaker(async (breaker) => {
        await breaker.run('embedding:ollama:http://localhost:11434:nomic', async () => 'ok');
      });
      try {
        const check = report.checks.find((c) => c.name === 'provider_circuit');
        expect(check?.status).toBe('ok');
        expect(check?.detail).toContain('1 provider breaker(s) tracked, all closed');
        expect(formatDoctorMarkdown(report)).toContain('embedding/ollama closed');
      } finally {
        await cleanup();
      }
    });

    it('warns with trip time and cooldown when a breaker is open', async () => {
      const { report, formatDoctorMarkdown, cleanup } = await doctorWithBreaker(async (breaker) => {
        await breaker
          .run('embedding:ollama:http://localhost:11434:nomic', async () => {
            throw new Error('provider down');
          })
          .catch(() => {});
      });
      try {
        const check = report.checks.find((c) => c.name === 'provider_circuit');
        expect(check?.status).toBe('warn');
        expect(check?.detail).toContain('1 provider breaker(s) not closed');
        expect(check?.detail).toContain('embedding/ollama open');
        expect(check?.detail).toContain('cooldown=30s');
        const md = formatDoctorMarkdown(report);
        expect(md).toContain('embedding/ollama open');
        expect(md).toContain(', WARN');
      } finally {
        await cleanup();
      }
    });
  });

  describe('dense flat-search latency advisory (issue #604)', () => {
    it('reports active index type/factory and warns only with a suggest-only hint above threshold', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-flat-latency-warn-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_FLAT_SEARCH_P95_ADVISORY_MS: '50',
        });
        const { SearchLatencyMetrics } = await import('./metrics.js');
        const searchMetrics = new SearchLatencyMetrics({ now: () => 1_700_000_000_000 });
        searchMetrics.record({
          mode: 'dense',
          status: 'success',
          totalMs: 130,
          stageDurationsMs: { faiss_search: 80 },
        });
        searchMetrics.record({
          mode: 'dense',
          status: 'success',
          totalMs: 180,
          stageDurationsMs: { faiss_search: 140 },
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          searchMetrics,
        });

        expect(report.index.type).toBe('flat');
        expect(report.index.factory).toBe('Flat');
        expect(report.dense_search_latency).toMatchObject({
          active_index: { type: 'flat', factory: 'Flat' },
          sample_count: 2,
          threshold_ms: 50,
          advisory: {
            code: 'FLAT_SCAN_P95_ABOVE_THRESHOLD',
            docs: expect.arrayContaining([
              'docs/operations/index-quantization.md#hnsw--ann-status',
              'https://github.com/jeanibarz/knowledge-base-mcp-server/issues/596',
            ]),
          },
        });
        const latencyCheck = report.checks.find((c) => c.name === 'flat_search_latency');
        expect(latencyCheck?.status).toBe('warn');
        expect(latencyCheck?.detail).toContain('not auto-enabled');
        expect(latencyCheck?.detail).toContain('issue #596 is blocked');
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toContain('Index type: flat');
        expect(markdown).toContain('Index factory: Flat');
        expect(markdown).toContain('Dense search latency:');
        expect(markdown).toContain('HINT Dense flat-search p95');
        expect(markdown).toContain('docs/architecture/adr/0011-hnsw-binding-evaluation.md');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('uses daemon stats latency when the doctor process has no local search histogram', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-flat-latency-daemon-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const { buildDoctorReport } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_FLAT_SEARCH_P95_ADVISORY_MS: '50',
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          daemonStatsPayload: async () => ({
            dense_search_latency: {
              mode: 'dense',
              stage: 'faiss_search',
              status: 'success',
              active_index: { type: 'flat', factory: 'Flat' },
              sample_count: 5,
              p50_ms: 25,
              p95_ms: 90,
              threshold_ms: 50,
              since_started_at: '2026-06-12T10:00:00.000Z',
              advisory: {
                code: 'FLAT_SCAN_P95_ABOVE_THRESHOLD',
                message: 'daemon p95 warning',
                docs: ['docs/architecture/adr/0011-hnsw-binding-evaluation.md'],
              },
            },
          }),
        });

        expect(report.dense_search_latency).toMatchObject({
          sample_count: 5,
          p95_ms: 90,
          advisory: { message: 'daemon p95 warning' },
        });
        expect(report.checks).toContainEqual({
          name: 'flat_search_latency',
          status: 'warn',
          detail: 'daemon p95 warning',
        });
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps missing dense latency quiet in doctor checks', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-flat-latency-empty-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
        });
        const { SearchLatencyMetrics } = await import('./metrics.js');

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          searchMetrics: new SearchLatencyMetrics({ now: () => 0 }),
        });

        expect(report.dense_search_latency).toBeNull();
        expect(report.checks.some((c) => c.name === 'flat_search_latency')).toBe(false);
        expect(formatDoctorMarkdown(report)).toContain(
          'Dense search latency:\n  (no dense faiss_search latency observed)',
        );
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps below-threshold observed dense latency quiet in doctor checks', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-flat-latency-ok-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_FLAT_SEARCH_P95_ADVISORY_MS: '50',
        });
        const { SearchLatencyMetrics } = await import('./metrics.js');
        const searchMetrics = new SearchLatencyMetrics({ now: () => 1_700_000_000_000 });
        searchMetrics.record({
          mode: 'dense',
          status: 'success',
          totalMs: 200,
          stageDurationsMs: { faiss_search: 12 },
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
          searchMetrics,
        });

        expect(report.dense_search_latency).toMatchObject({
          active_index: { type: 'flat', factory: 'Flat' },
          sample_count: 1,
          threshold_ms: 50,
          advisory: null,
        });
        expect(report.dense_search_latency?.p95_ms).toBeLessThanOrEqual(50);
        expect(report.checks.some((c) => c.name === 'flat_search_latency')).toBe(false);
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toContain('Dense search latency:');
        expect(markdown).toContain('p95=');
        expect(markdown).not.toContain('HINT Dense flat-search p95');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('reranker health', () => {
    it('reports the reranker as OK when disabled', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-rerank-off-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_RERANK: 'off',
          HF_HOME: path.join(tempDir, 'hf'),
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });

        expect(report.reranker).toEqual({
          enabled: false,
          model: RERANK_MODEL,
          top_n: 40,
          status: 'ok',
          cache_path: null,
          detail: 'KB_RERANK is off',
        });
        expect(report.checks).toContainEqual({
          name: 'reranker',
          status: 'ok',
          detail: 'KB_RERANK is off',
        });
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toContain('Reranker:');
        expect(markdown).toContain('enabled: no');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('reports invalid reranker configuration as an error', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-rerank-invalid-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_RERANK: 'on',
          KB_RERANK_TOP_N: '0',
          HF_HOME: path.join(tempDir, 'hf'),
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });

        expect(report.status).toBe('error');
        expect(report.reranker).toMatchObject({
          enabled: false,
          model: '<invalid>',
          top_n: 0,
          status: 'error',
          cache_path: null,
        });
        expect(report.reranker.detail).toContain('KB_RERANK_TOP_N');
        const check = report.checks.find((c) => c.name === 'reranker');
        expect(check?.status).toBe('error');
        expect(check?.detail).toContain('KB_RERANK_TOP_N');
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toContain('status: error');
        expect(markdown).toContain('model: <invalid>');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('warns when enabled and the reranker model cache is missing', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-rerank-cache-missing-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const hfHome = path.join(tempDir, 'hf');
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_RERANK: 'on',
          HF_HOME: hfHome,
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });

        expect(report.status).toBe('warn');
        expect(report.reranker).toMatchObject({
          enabled: true,
          model: RERANK_MODEL,
          top_n: 40,
          status: 'warn',
          cache_path: null,
        });
        expect(report.reranker.detail).toContain('cache not found');
        const check = report.checks.find((c) => c.name === 'reranker');
        expect(check?.status).toBe('warn');
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toContain('enabled: yes');
        expect(markdown).toContain('cache_path: <not found>');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('reports OK when enabled and the reranker model cache is present', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-rerank-cache-present-'));
      try {
        const { rootDir, faissDir } = await seedDoctorBase(tempDir);
        const hfHome = path.join(tempDir, 'hf');
        const modelCachePath = path.join(hfHome, 'hub', 'models--Xenova--ms-marco-MiniLM-L-6-v2');
        await fsp.mkdir(modelCachePath, { recursive: true });
        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'huggingface',
          HUGGINGFACE_MODEL_NAME: MODEL_NAME,
          HUGGINGFACE_API_KEY: 'test-key',
          KB_RERANK: 'on',
          HF_HOME: hfHome,
        });

        const report = await buildDoctorReport({
          backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });

        expect(report.reranker).toEqual({
          enabled: true,
          model: RERANK_MODEL,
          top_n: 40,
          status: 'ok',
          cache_path: modelCachePath,
          detail: 'reranker model cache found',
        });
        expect(report.checks).toContainEqual({
          name: 'reranker',
          status: 'ok',
          detail: 'reranker model cache found',
        });
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toContain(`cache_path: ${modelCachePath}`);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('fake provider (issue #204)', () => {
    it('reports backend WARN with a "testing only" detail when active provider is fake', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-fake-'));
      try {
        const rootDir = path.join(tempDir, 'kbs');
        const faissDir = path.join(tempDir, '.faiss');
        await fsp.mkdir(rootDir, { recursive: true });
        await fsp.mkdir(faissDir, { recursive: true });

        const fakeModelId = 'fake__bag-256d';
        const modelDir = path.join(faissDir, 'models', fakeModelId);
        const versionDir = path.join(modelDir, 'index.v3');
        await fsp.mkdir(versionDir, { recursive: true });
        await fsp.writeFile(path.join(modelDir, 'model_name.txt'), 'bag-256d');
        await fsp.writeFile(path.join(faissDir, 'active.txt'), fakeModelId);
        await fsp.writeFile(path.join(versionDir, 'faiss.index'), 'fake-index');
        await fsp.symlink('index.v3', path.join(modelDir, 'index'), 'dir');

        const { buildDoctorReport, formatDoctorMarkdown } = await freshDoctor({
          KNOWLEDGE_BASES_ROOT_DIR: rootDir,
          FAISS_INDEX_PATH: faissDir,
          EMBEDDING_PROVIDER: 'fake',
        });

        // Use the default backend health check — fake should report healthy
        // (no daemon/key) but the doctor must elevate the row to WARN.
        const report = await buildDoctorReport({
          packageRoot: tempDir,
          invokedPath: null,
          packageVersion: '9.9.9',
          llmEndpointProbe: healthyLlmProbe,
        });

        expect(report.active_model.provider).toBe('fake');
        expect(report.backend.healthy).toBe(true);
        expect(report.backend.detail).toMatch(/testing only/i);
        const backendCheck = report.checks.find((c) => c.name === 'backend');
        expect(backendCheck?.status).toBe('warn');
        // Backend WARN must not flip the overall status to error.
        expect(report.status).toBe('warn');
        const markdown = formatDoctorMarkdown(report);
        expect(markdown).toMatch(/Backend: ok — fake provider/);
        expect(markdown).toMatch(/WARN\s+backend: fake provider/);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
