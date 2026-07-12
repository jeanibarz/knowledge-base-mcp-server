import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createDoctorBugReportBundle } from './cli-bug-report.js';
import type { DoctorReport } from './cli-doctor.js';

function minimalDoctorReport(): DoctorReport {
  return {
    status: 'ok',
    checks: [],
    active_model: { model_id: 'fake__model', provider: 'fake', model_name: 'model' },
    index: {
      path: '/tmp/faiss',
      binary_path: null,
      version: null,
      mtime: null,
      type: null,
      factory: null,
      storage: {
        active_version_bytes: null,
        inactive_version_count: 0,
        inactive_version_bytes: 0,
        total_version_bytes: 0,
        retention_previous_versions: 0,
      },
    },
    index_security: {
      permission_check: 'checked',
      ownership_check: 'checked',
      entries: [],
    },
    embedding_canary: {
      status: 'skipped',
      canary_id: null,
      recorded_at: null,
      dimensions: null,
      similarity: null,
      threshold: 0.999,
      detail: 'embedding canary skipped because the active model index is not built',
      next_action: null,
    },
    extraction_cache: {
      cache_dir: '/tmp/faiss/extracted-text',
      exists: false,
      entry_count: 0,
      total_bytes: 0,
      oldest_mtime: null,
      newest_mtime: null,
      ignored_entry_count: 0,
      error_count: 0,
      errors: [],
    },
    stale_counts_by_kb: {},
    filesystem: {
      enumeration_failures: { failure_count: 0, failures: [] },
    },
    quarantine_counts_by_kb: {},
    age_budgets: {},
    age_budget_config_errors: [],
    incomplete_models: [],
    backend: { provider: 'fake', healthy: true, detail: 'ok' },
    llm_endpoint: {
      status: 'ok',
      endpoint: null,
      health_url: null,
      endpoint_source: 'unresolved',
      profile_name: null,
      profile_mode: null,
      managed_by: null,
      unit_name: null,
      health_ok: false,
      chat_ok: false,
      detail: 'not configured',
      next_action: null,
    },
    gate_llm_endpoint: {
      name: 'gate_llm_endpoint',
      kind: 'http',
      status: 'skipped',
      configured: false,
      target: null,
      source: 'not_configured',
      detail: 'not configured',
    },
    reranker: {
      enabled: false,
      model: 'reranker',
      top_n: 40,
      status: 'ok',
      cache_path: null,
      detail: 'off',
    },
    cli: {
      version: 'test',
      package_root: '/tmp/repo',
      invoked_path: null,
      symlinked_checkout_path: null,
    },
    git: null,
    last_index_update: {
      status: 'never_run',
      scope: null,
      model_id: null,
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
      warning_count: 0,
      warnings: [],
      failure_count: 0,
      failures: [],
    },
    reindex_trigger: {
      status: 'ok',
      enabled: false,
      poll_ms: 0,
      poll_ms_source: 'default',
      poll_ms_raw: null,
      path: '/tmp/trigger',
      path_source: 'default',
      path_raw: null,
      kb_fs_watch_enabled: false,
      trigger_file: {
        exists: false,
        kind: 'missing',
        mtime: null,
        age_ms: null,
        size_bytes: null,
        stat_error: null,
      },
      parent: {
        path: '/tmp',
        exists: true,
        writable: true,
        access_error: null,
      },
      freshness: {
        index_mtime: null,
        trigger_mtime: null,
        trigger_newer_than_index: null,
      },
      warnings: [],
      limitation: 'test',
    },
    provider_calls: {},
    provider_circuits: [],
    dense_search_latency: null,
    integrity: null,
  };
}

describe('doctor bug-report bundle', () => {
  it('writes a timestamped redacted support bundle without raw secrets', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bug-report-test-'));
    try {
      const result = await createDoctorBugReportBundle({
        outputParentDir: tempDir,
        now: new Date('2026-05-22T01:02:03.000Z'),
        env: {
          OPENAI_API_KEY: 'sk-proj-secretsecretsecretsecret',
          KB_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1/chat/completions',
        },
        buildDoctorReport: async () => minimalDoctorReport(),
        runStats: async () => {
          process.stdout.write('{"stats_secret":"Bearer abcdefghijklmnop"}\n');
          return 0;
        },
        runLogs: async () => {
          process.stdout.write('{"events":[{"authorization":"Bearer abcdefghijklmnop"}]}\n');
          return 0;
        },
      });

      expect(path.basename(result.bundle_dir)).toBe('kb-bug-report-20260522T010203Z');
      expect(result.files).toEqual([
        'README.md',
        'doctor.json',
        'logs-recent.json',
        'manifest.json',
        'runtime.json',
        'stats.json',
      ]);
      const runtime = await fsp.readFile(path.join(result.bundle_dir, 'runtime.json'), 'utf-8');
      expect(runtime).toContain('"name": "OPENAI_API_KEY"');
      expect(runtime).toContain('[REDACTED]');
      const bundleText = await readBundleText(result.bundle_dir, result.files);
      expect(bundleText).not.toContain('sk-proj-secretsecretsecretsecret');
      expect(bundleText).not.toContain('abcdefghijklmnop');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('records optional command exit metadata and redacted stderr tail only', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bug-report-cmd-'));
    try {
      const result = await createDoctorBugReportBundle({
        outputParentDir: tempDir,
        buildDoctorReport: async () => minimalDoctorReport(),
        runStats: async () => 0,
        runLogs: async () => 0,
        command: [
          process.execPath,
          '-e',
          'console.log(Buffer.from("cmF3IHN0ZG91dCBzZWNyZXQ=", "base64").toString("utf8")); console.error("Authorization: Bearer abcdefghijklmnop"); process.exit(7)',
          '--',
          '--token',
          'plainsecret123456789',
          '--api-key=anothersecret123456789',
        ],
      });

      expect(result.files).toContain('command.json');
      const commandText = await fsp.readFile(path.join(result.bundle_dir, 'command.json'), 'utf-8');
      const command = JSON.parse(commandText) as {
        command: string[];
        exit_code: number;
        stderr_tail: string;
        stdout_bytes: number;
      };
      expect(command.exit_code).toBe(7);
      expect(command.stdout_bytes).toBe(0);
      expect(command.command).toContain('[REDACTED]');
      expect(command.command).toContain('--api-key=[REDACTED]');
      expect(commandText).not.toContain('raw stdout secret');
      expect(commandText).not.toContain('plainsecret123456789');
      expect(commandText).not.toContain('anothersecret123456789');
      expect(command.stderr_tail).toContain('Authorization: Bearer [REDACTED]');
      expect(command.stderr_tail).not.toContain('abcdefghijklmnop');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function readBundleText(bundleDir: string, files: string[]): Promise<string> {
  const contents = await Promise.all(
    files.map((file) => fsp.readFile(path.join(bundleDir, file), 'utf-8')),
  );
  return contents.join('\n');
}
