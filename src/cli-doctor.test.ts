import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME: process.env.HUGGINGFACE_MODEL_NAME,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  KB_ACTIVE_MODEL: process.env.KB_ACTIVE_MODEL,
  KB_INDEX_VERSION_RETENTION: process.env.KB_INDEX_VERSION_RETENTION,
  KB_AGE_BUDGET_HOURS: process.env.KB_AGE_BUDGET_HOURS,
  KB_AGE_BUDGET_HOURS_ALPHA: process.env.KB_AGE_BUDGET_HOURS_ALPHA,
  KB_AGE_BUDGET_HOURS_BETA: process.env.KB_AGE_BUDGET_HOURS_BETA,
  REINDEX_TRIGGER_PATH: process.env.REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS: process.env.REINDEX_TRIGGER_POLL_MS,
  KB_FS_WATCH: process.env.KB_FS_WATCH,
  KB_LLM_ENDPOINT: process.env.KB_LLM_ENDPOINT,
  KB_LLM_CONFIG_DIR: process.env.KB_LLM_CONFIG_DIR,
  KB_LLM_STATE_DIR: process.env.KB_LLM_STATE_DIR,
  KB_RERANK: process.env.KB_RERANK,
  KB_RERANK_MODEL: process.env.KB_RERANK_MODEL,
  KB_RERANK_TOP_N: process.env.KB_RERANK_TOP_N,
  HF_HOME: process.env.HF_HOME,
  TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE,
  HOME: process.env.HOME,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  MCP_TRANSPORT: process.env.MCP_TRANSPORT,
  MCP_PORT: process.env.MCP_PORT,
  MCP_BIND_ADDR: process.env.MCP_BIND_ADDR,
  MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN,
  KB_DAEMON_URL: process.env.KB_DAEMON_URL,
  KB_DAEMON_HOST: process.env.KB_DAEMON_HOST,
  KB_DAEMON_PORT: process.env.KB_DAEMON_PORT,
};

const MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';
const MODEL_NAME = 'BAAI/bge-small-en-v1.5';
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

function persistedSuccessSummary() {
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
    failure_count: 0,
    failures: [],
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

describe('kb doctor', () => {
  const itOnPosix = process.platform === 'win32' ? it.skip : it;

  it('reports configured endpoint preflight checks in JSON and markdown', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-endpoints-'));
    try {
      const llmConfigDir = path.join(tempDir, 'llm-config');
      const llmStateDir = path.join(tempDir, 'llm-state');
      const { buildDoctorEndpointsReport, formatDoctorEndpointsMarkdown } = await freshDoctor({
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        MCP_TRANSPORT: 'http',
        MCP_PORT: '18765',
        MCP_BIND_ADDR: '127.0.0.1',
        MCP_AUTH_TOKEN: 'x'.repeat(32),
        KB_DAEMON_URL: 'http://127.0.0.1:17799',
        KB_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1/chat/completions',
        KB_LLM_CONFIG_DIR: llmConfigDir,
        KB_LLM_STATE_DIR: llmStateDir,
      });

      const report = await buildDoctorEndpointsReport({
        bindAvailabilityCheck: async (host, port) => ({
          available: true,
          detail: `${host}:${port} available`,
        }),
        daemonHealthCheck: async (url) => ({
          healthy: true,
          detail: `daemon ok at ${url}`,
        }),
        embeddingEndpointProbe: async (endpoint) => ({
          healthy: true,
          detail: `embedding ok at ${endpoint}`,
        }),
        llmEndpointProbe: healthyLlmProbe,
      });

      expect(report.status).toBe('ok');
      expect(report.endpoints).toEqual([
        expect.objectContaining({
          name: 'mcp_bind',
          status: 'ok',
          configured: true,
          target: '127.0.0.1:18765',
        }),
        expect.objectContaining({
          name: 'kb_daemon',
          status: 'ok',
          configured: true,
          target: 'http://127.0.0.1:17799/',
        }),
        expect.objectContaining({
          name: 'embedding_backend',
          status: 'ok',
          configured: true,
          target: 'http://127.0.0.1:11434',
        }),
        expect.objectContaining({
          name: 'llm_endpoint',
          status: 'ok',
          configured: true,
          target: 'http://127.0.0.1:8080/v1/chat/completions',
        }),
      ]);

      const markdown = formatDoctorEndpointsMarkdown(report);
      expect(markdown).toContain('Endpoint preflight:');
      expect(markdown).toContain('OK    mcp_bind: 127.0.0.1:18765');
      expect(markdown).toContain('OK    kb_daemon: http://127.0.0.1:17799/');
      expect(markdown).toContain('OK    embedding_backend: http://127.0.0.1:11434');
      expect(markdown).toContain('OK    llm_endpoint: http://127.0.0.1:8080/v1/chat/completions');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks endpoint preflight errors when configured bind or daemon targets are not ready', async () => {
    const { buildDoctorEndpointsReport } = await freshDoctor({
      EMBEDDING_PROVIDER: 'huggingface',
      OLLAMA_BASE_URL: '',
      MCP_TRANSPORT: 'sse',
      MCP_PORT: '18766',
      MCP_BIND_ADDR: '127.0.0.1',
      MCP_AUTH_TOKEN: 'x'.repeat(32),
      KB_DAEMON_URL: 'http://127.0.0.1:17798',
      KB_LLM_ENDPOINT: '',
    });

    const report = await buildDoctorEndpointsReport({
      bindAvailabilityCheck: async () => ({
        available: false,
        detail: '127.0.0.1:18766 is already in use',
      }),
      daemonHealthCheck: async () => ({
        healthy: false,
        detail: 'kb daemon is not reachable',
      }),
      llmEndpointProbe: healthyLlmProbe,
    });

    expect(report.status).toBe('error');
    expect(report.endpoints).toContainEqual(expect.objectContaining({
      name: 'mcp_bind',
      status: 'error',
      next_action: expect.stringContaining('Free 127.0.0.1:18766'),
    }));
    expect(report.endpoints).toContainEqual(expect.objectContaining({
      name: 'kb_daemon',
      status: 'error',
      next_action: expect.stringContaining('Start kb serve'),
    }));
    expect(report.endpoints).toContainEqual(expect.objectContaining({
      name: 'llm_endpoint',
      status: 'ok',
      configured: false,
    }));
  });

  it('does not probe Ollama when a non-Ollama embedding provider is active', async () => {
    const { buildDoctorEndpointsReport } = await freshDoctor({
      EMBEDDING_PROVIDER: 'huggingface',
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
    });
    const embeddingEndpointProbe = jest.fn(async (endpoint: string) => ({
      healthy: false,
      detail: `unexpected probe at ${endpoint}`,
    }));

    const report = await buildDoctorEndpointsReport({ embeddingEndpointProbe });

    expect(embeddingEndpointProbe).not.toHaveBeenCalled();
    expect(report.endpoints).toContainEqual(expect.objectContaining({
      name: 'embedding_backend',
      status: 'ok',
      configured: false,
      target: null,
    }));
  });

  it('routes runDoctor --endpoints through the focused JSON report branch', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-endpoints-run-'));
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { runDoctor } = await freshDoctor({
        EMBEDDING_PROVIDER: 'huggingface',
        OLLAMA_BASE_URL: '',
        MCP_TRANSPORT: 'stdio',
        KB_DAEMON_URL: '',
        KB_DAEMON_HOST: '',
        KB_DAEMON_PORT: '',
        KB_LLM_ENDPOINT: '',
        KB_LLM_CONFIG_DIR: path.join(tempDir, 'llm-config'),
        KB_LLM_STATE_DIR: path.join(tempDir, 'llm-state'),
      });

      await expect(runDoctor(['--endpoints', '--format=json'])).resolves.toBe(0);

      const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
      const parsed = JSON.parse(output) as { status: string; endpoints: Array<{ name: string }> };
      expect(parsed.status).toBe('ok');
      expect(parsed.endpoints.map((entry) => entry.name)).toEqual([
        'mcp_bind',
        'kb_daemon',
        'embedding_backend',
        'llm_endpoint',
      ]);
    } finally {
      stdoutSpy.mockRestore();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

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
      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('LLM endpoint:');
      expect(markdown).toContain('source: profile');
      expect(markdown).toContain('managed_by: local-research-agent');
      expect(markdown).toContain('chat_ok: yes');
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
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/health',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
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

  it('parses --format=json and rejects unsupported formats', async () => {
    const { parseDoctorArgs } = await freshDoctor({});
    expect(parseDoctorArgs(['--format=json'])).toEqual({ format: 'json', reindexTrigger: false, endpoints: false });
    expect(parseDoctorArgs(['--reindex-trigger'])).toEqual({ format: 'md', reindexTrigger: true, endpoints: false });
    expect(parseDoctorArgs(['--endpoints', '--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: false,
      endpoints: true,
    });
    expect(parseDoctorArgs(['--reindex-trigger', '--format=json'])).toEqual({
      format: 'json',
      reindexTrigger: true,
      endpoints: false,
    });
    expect(parseDoctorArgs([])).toEqual({ format: 'md', reindexTrigger: false, endpoints: false });
    expect(() => parseDoctorArgs(['--format=yaml'])).toThrow(/invalid --format/);
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
