import { afterEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import {
  formatStatsRunResultAsOpenMetrics,
  parseServeArgs,
  runServeStatus,
  startDaemonServer,
} from './cli-serve.js';
import type { DaemonRunResult } from './daemon-client.js';
import type { KbStatsPayload } from './kb-stats.js';

interface RawResponse {
  statusCode: number;
  body: string;
}

function request(
  url: URL,
  options: { method?: string; path: string; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('kb serve daemon', () => {
  const originalMetricsExport = process.env.KB_METRICS_EXPORT;

  afterEach(() => {
    if (originalMetricsExport === undefined) delete process.env.KB_METRICS_EXPORT;
    else process.env.KB_METRICS_EXPORT = originalMetricsExport;
  });

  it('serves health and dispatches read-only commands through handlers', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const ok = (stdout: string): DaemonRunResult => ({ exitCode: 0, stdout, stderr: '' });
    const daemon = await startDaemonServer({
      port: 0,
      idleTimeoutMs: 0,
      handlers: {
        search: async (args) => {
          calls.push({ command: 'search', args });
          return ok('search output\n');
        },
        list: async (args) => {
          calls.push({ command: 'list', args });
          return ok('list output\n');
        },
        stats: async (args) => {
          calls.push({ command: 'stats', args });
          return ok('stats output\n');
        },
      },
    });
    try {
      const health = await request(daemon.url, { path: '/health' });
      expect(health.statusCode).toBe(200);
      const healthBody = JSON.parse(health.body);
      expect(healthBody).toMatchObject({
        status: 'ok',
        pid: process.pid,
        url: daemon.url.href,
        idle_timeout_ms: 0,
        commands: ['search', 'list', 'stats'],
      });
      expect(typeof healthBody.uptime_ms).toBe('number');
      expect(healthBody.uptime_ms).toBeGreaterThanOrEqual(0);

      const run = await request(daemon.url, {
        method: 'POST',
        path: '/v1/run',
        body: { command: 'search', args: ['hello', '--format=json'] },
      });
      expect(run.statusCode).toBe(200);
      expect(JSON.parse(run.body)).toEqual({ exitCode: 0, stdout: 'search output\n', stderr: '' });
      expect(calls).toEqual([{ command: 'search', args: ['hello', '--format=json'] }]);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects mutating search refresh requests', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    try {
      const res = await request(daemon.url, {
        method: 'POST',
        path: '/v1/run',
        body: { command: 'search', args: ['q', '--refresh'] },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'read_only_daemon' });
    } finally {
      await daemon.stop();
    }
  });

  it('exposes OpenMetrics text only when KB_METRICS_EXPORT is enabled', async () => {
    const daemon = await startDaemonServer({
      port: 0,
      idleTimeoutMs: 0,
      metricsHandler: async () => '# TYPE kb_server_uptime_ms gauge\nkb_server_uptime_ms 1\n# EOF\n',
    });
    try {
      const disabled = await request(daemon.url, { path: '/metrics' });
      expect(disabled.statusCode).toBe(404);

      process.env.KB_METRICS_EXPORT = 'on';
      const enabled = await request(daemon.url, { path: '/metrics' });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.body).toContain('kb_server_uptime_ms 1');
    } finally {
      await daemon.stop();
    }
  });

  it('keeps serve binding loopback-only', () => {
    expect(() => parseServeArgs(['--host=0.0.0.0'])).toThrow(/non-loopback/);
  });
});

describe('kb serve metrics formatting', () => {
  it('formats the default kb stats daemon result as OpenMetrics text', () => {
    const payload: KbStatsPayload = {
      knowledge_bases: {
        alpha: {
          file_count: 1,
          chunk_count: 2,
          total_bytes_indexed: 3,
          last_updated_at: null,
        },
      },
      quarantined: {},
      filesystem: {
        enumeration_failures: { failure_count: 0, failures: [] },
      },
      embedding: {
        provider: 'huggingface',
        model: 'BAAI/bge-small-en-v1.5',
        dim: 384,
      },
      index_path: '/tmp/faiss',
      last_index_update: {
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
        warning_count: 0,
        warnings: [],
        failure_count: 0,
        failures: [],
      },
      server: {
        version: '0.0.0-test',
        uptime_ms: 1,
      },
      provider_calls: {},
      query_cache: {
        hits: 0,
        misses: 0,
        hit_ratio: 0,
        l1_hits: 0,
        disk_hits: 0,
        bypasses: 0,
        writes: 0,
        corruptions: 0,
        l1_size: 0,
        disk_size_bytes: 0,
      },
      relevance_gate: {
        gated_queries: 0,
        verdict_injected: 0,
        verdict_no_relevant_context: 0,
        verdict_empty_index: 0,
        low_confidence_rate: 0,
        drop_rate_A1: 0,
        drop_rate_A2: 0,
        drop_rate_B: 0,
        judge_degrade_rate: 0,
        judge_window: {
          size: 0,
          degraded: 0,
          rate: 0,
          warn_threshold: 0.1,
        },
      },
    };

    const text = formatStatsRunResultAsOpenMetrics({
      exitCode: 0,
      stdout: JSON.stringify(payload),
      stderr: '',
    });

    expect(text).toContain('kb_knowledge_base_chunks{kb="alpha"} 2');
    expect(text).toContain('# TYPE kb_query_cache_hits counter');
    expect(text).toContain('kb_query_cache_hits_total 0');
    expect(text.endsWith('# EOF\n')).toBe(true);
  });

  it('surfaces kb stats failures from the default metrics path', () => {
    expect(() => formatStatsRunResultAsOpenMetrics({
      exitCode: 1,
      stdout: '',
      stderr: 'stats unavailable\n',
    })).toThrow('stats unavailable');
  });
});

describe('kb serve status', () => {
  const originalDaemonUrl = process.env.KB_DAEMON_URL;

  afterEach(() => {
    if (originalDaemonUrl === undefined) delete process.env.KB_DAEMON_URL;
    else process.env.KB_DAEMON_URL = originalDaemonUrl;
  });

  async function captureStatus(args: string[]): Promise<{ code: number; stdout: string }> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      const callback = rest.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
      if (callback) callback();
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runServeStatus(args);
      return { code, stdout: chunks.join('') };
    } finally {
      process.stdout.write = originalWrite;
    }
  }

  it('reports a reachable daemon with its lifecycle details', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    process.env.KB_DAEMON_URL = daemon.url.href;
    try {
      const result = await captureStatus([]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('daemon running');
      expect(result.stdout).toContain(`pid:          ${process.pid}`);
      expect(result.stdout).toContain('commands:     search, list, stats');
    } finally {
      await daemon.stop();
    }
  });

  it('emits a machine-readable envelope with --json', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    process.env.KB_DAEMON_URL = daemon.url.href;
    try {
      const result = await captureStatus(['--json']);
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        reachable: true,
        url: daemon.url.href,
        daemon: { status: 'ok', commands: ['search', 'list', 'stats'] },
      });
    } finally {
      await daemon.stop();
    }
  });

  it('exits 3 and reports when no daemon is reachable', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    const url = daemon.url.href;
    await daemon.stop();
    process.env.KB_DAEMON_URL = url;

    const result = await captureStatus([]);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain(`no daemon reachable at ${url}`);

    const jsonResult = await captureStatus(['--json']);
    expect(jsonResult.code).toBe(3);
    expect(JSON.parse(jsonResult.stdout)).toEqual({ reachable: false, url });
  });

  it('rejects unknown arguments with exit code 2', async () => {
    const result = await captureStatus(['--bogus']);
    expect(result.code).toBe(2);
  });
});
