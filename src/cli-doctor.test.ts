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
  KB_AGE_BUDGET_HOURS: process.env.KB_AGE_BUDGET_HOURS,
  KB_AGE_BUDGET_HOURS_ALPHA: process.env.KB_AGE_BUDGET_HOURS_ALPHA,
  KB_AGE_BUDGET_HOURS_BETA: process.env.KB_AGE_BUDGET_HOURS_BETA,
};

const MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';
const MODEL_NAME = 'BAAI/bge-small-en-v1.5';

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

describe('kb doctor', () => {
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
      });

      const report = await buildDoctorReport({
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: linkedBin,
        packageVersion: '9.9.9',
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
      expect(report.incomplete_models).toEqual([]);

      const markdown = formatDoctorMarkdown(report);
      expect(markdown).toContain('Status: WARN');
      expect(markdown).toContain(`Active model: ${MODEL_ID}`);
      expect(markdown).toContain('Last index update: success (global, 1000ms, 1 changed, 1 unchanged, 0 skipped)');
      expect(markdown).toContain('alpha: 1 modified, 0 new');
      expect(markdown).toContain('beta: 0 modified, 1 new');
      expect(markdown).toContain('Incomplete model dirs:\n  (none)');

      const json = JSON.parse(JSON.stringify(report)) as typeof report;
      expect(json.stale_counts_by_kb.alpha.modified_files).toBe(1);
      expect(json.last_index_update.saved).toBe(true);
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
    expect(parseDoctorArgs(['--format=json'])).toEqual({ format: 'json' });
    expect(parseDoctorArgs([])).toEqual({ format: 'md' });
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
