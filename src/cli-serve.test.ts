import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as http from 'node:http';
import {
  appendDaemonAdmissionMetrics,
  createDaemonCommandHandlers,
  formatStatsRunResultAsOpenMetrics,
  parseServeArgs,
  runServeStatus,
  startDaemonServer,
} from './cli-serve.js';
import {
  DaemonAdmissionGate,
  resolveDaemonAdmissionConfig,
  DEFAULT_DAEMON_MAX_CONCURRENCY,
  DEFAULT_DAEMON_QUEUE_MAX,
} from './daemon-admission.js';
import type { DaemonRunResult } from './daemon-client.js';
import type { KbStatsPayload } from './kb-stats.js';
import type { RunSearchDeps } from './cli-search.js';
import type { LexicalIndex } from './lexical-index.js';

interface RawResponse {
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
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
          headers: res.headers,
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

  it('injects a cached lexical loader into daemon-served search', async () => {
    const lexicalIndex = { numFiles: () => 1 } as unknown as LexicalIndex;
    const lexicalIndexLoader = jest.fn(async () => lexicalIndex);
    const runSearchImpl = jest.fn(async (_args: string[], deps: RunSearchDeps = {} as RunSearchDeps) => {
      await expect(deps.loadLexicalIndex?.('alpha', '/kb/alpha')).resolves.toBe(lexicalIndex);
      return 0;
    });
    const handlers = createDaemonCommandHandlers({ lexicalIndexLoader, runSearchImpl });

    const result = await handlers.search(['query', '--mode=hybrid']);

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(runSearchImpl).toHaveBeenCalledWith(['query', '--mode=hybrid'], expect.objectContaining({
      loadLexicalIndex: lexicalIndexLoader,
    }));
    expect(lexicalIndexLoader).toHaveBeenCalledWith('alpha', '/kb/alpha');
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

describe('daemon admission gate', () => {
  it('resolves bounds from the environment, falling back to defaults', () => {
    expect(resolveDaemonAdmissionConfig({})).toEqual({
      maxConcurrency: DEFAULT_DAEMON_MAX_CONCURRENCY,
      queueMax: DEFAULT_DAEMON_QUEUE_MAX,
    });
    expect(
      resolveDaemonAdmissionConfig({
        KB_DAEMON_MAX_CONCURRENCY: '3',
        KB_DAEMON_QUEUE_MAX: '0',
      }),
    ).toEqual({ maxConcurrency: 3, queueMax: 0 });
    // Invalid values fall back rather than throwing.
    expect(
      resolveDaemonAdmissionConfig({
        KB_DAEMON_MAX_CONCURRENCY: 'nope',
        KB_DAEMON_QUEUE_MAX: '-5',
      }),
    ).toEqual({
      maxConcurrency: DEFAULT_DAEMON_MAX_CONCURRENCY,
      queueMax: DEFAULT_DAEMON_QUEUE_MAX,
    });
  });

  it('never runs more than maxConcurrency jobs at once', async () => {
    const gate = new DaemonAdmissionGate({ maxConcurrency: 2, queueMax: 10 });
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await held;
      active -= 1;
    };

    const accepted = Array.from({ length: 6 }, () => gate.run(job));
    expect(accepted.every((p) => p !== null)).toBe(true);
    // All six admitted (2 running + 4 queued), none rejected.
    expect(gate.inFlight).toBe(6);
    expect(gate.rejectedTotal).toBe(0);

    await Promise.resolve();
    expect(maxActive).toBe(2);

    release();
    await Promise.all(accepted);
    expect(maxActive).toBe(2);
    expect(gate.inFlight).toBe(0);
  });

  it('rejects with null once the cap and queue are both full', async () => {
    const gate = new DaemonAdmissionGate({ maxConcurrency: 1, queueMax: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = (): Promise<void> => held;

    const running = gate.run(job); // takes the single slot
    const queued = gate.run(job); // fills the single queue position
    const rejected = gate.run(job); // no room -> rejected

    expect(running).not.toBeNull();
    expect(queued).not.toBeNull();
    expect(rejected).toBeNull();
    expect(gate.rejectedTotal).toBe(1);
    expect(gate.inFlight).toBe(2);

    release();
    await Promise.all([running, queued]);
    expect(gate.inFlight).toBe(0);
  });
});

describe('kb serve daemon admission control', () => {
  const originalMetricsExport = process.env.KB_METRICS_EXPORT;

  afterEach(() => {
    if (originalMetricsExport === undefined) delete process.env.KB_METRICS_EXPORT;
    else process.env.KB_METRICS_EXPORT = originalMetricsExport;
  });

  function blockingHandlers(onEnter: () => void, held: Promise<void>) {
    const make = () => async (): Promise<DaemonRunResult> => {
      onEnter();
      await held;
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };
    return { search: make(), list: make(), stats: make() };
  }

  it('caps concurrent in-flight requests at maxConcurrency', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolveTwo!: () => void;
    const twoStarted = new Promise<void>((resolve) => {
      resolveTwo = resolve;
    });
    const handler = async (): Promise<DaemonRunResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) resolveTwo();
      await held;
      active -= 1;
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };
    const handlers = { search: handler, list: handler, stats: handler };

    const daemon = await startDaemonServer({
      port: 0,
      idleTimeoutMs: 0,
      admission: { maxConcurrency: 2, queueMax: 10 },
      handlers,
    });
    try {
      const inFlight = Array.from({ length: 5 }, () =>
        request(daemon.url, {
          method: 'POST',
          path: '/v1/run',
          body: { command: 'search', args: ['q'] },
        }),
      );
      await twoStarted;
      expect(maxActive).toBe(2);
      release();
      const results = await Promise.all(inFlight);
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(maxActive).toBe(2);
    } finally {
      release();
      await daemon.stop();
    }
  });

  it('replies 429 + Retry-After once the queue is full', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const handlers = blockingHandlers(() => resolveStarted(), held);

    // queueMax 0 -> any request arriving while the single slot is busy is
    // rejected immediately, making the 429 path deterministic.
    const daemon = await startDaemonServer({
      port: 0,
      idleTimeoutMs: 0,
      admission: { maxConcurrency: 1, queueMax: 0 },
      handlers,
      // Keep /metrics hermetic and fast — the daemon admission gauges are
      // spliced into whatever body the handler returns.
      metricsHandler: async () => '# EOF\n',
    });
    try {
      const first = request(daemon.url, {
        method: 'POST',
        path: '/v1/run',
        body: { command: 'search', args: ['q'] },
      });
      await started; // the slot is now occupied

      const rejected = await request(daemon.url, {
        method: 'POST',
        path: '/v1/run',
        body: { command: 'search', args: ['q'] },
      });
      expect(rejected.statusCode).toBe(429);
      expect(rejected.headers['retry-after']).toBe('1');
      expect(JSON.parse(rejected.body)).toMatchObject({ error: 'too_many_requests' });

      process.env.KB_METRICS_EXPORT = 'on';
      const metrics = await request(daemon.url, { path: '/metrics' });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain('# TYPE kb_daemon_rejected counter');
      expect(metrics.body).toContain('kb_daemon_rejected_total 1');
      expect(metrics.body).toContain('# TYPE kb_daemon_inflight gauge');

      release();
      const accepted = await first;
      expect(accepted.statusCode).toBe(200);
    } finally {
      release();
      await daemon.stop();
    }
  });
});

describe('appendDaemonAdmissionMetrics', () => {
  it('splices admission metrics ahead of the OpenMetrics EOF terminator', () => {
    const body = '# TYPE kb_server_uptime_ms gauge\nkb_server_uptime_ms 1\n# EOF\n';
    const out = appendDaemonAdmissionMetrics(body, { inFlight: 3, rejectedTotal: 7 });
    expect(out).toContain('kb_server_uptime_ms 1');
    expect(out).toContain('kb_daemon_inflight 3');
    expect(out).toContain('kb_daemon_rejected_total 7');
    expect(out.endsWith('# EOF\n')).toBe(true);
    // The EOF terminator stays last.
    expect(out.indexOf('kb_daemon_inflight')).toBeLessThan(out.indexOf('# EOF'));
  });

  it('appends a terminator when the body has none', () => {
    const out = appendDaemonAdmissionMetrics('custom 1\n', { inFlight: 0, rejectedTotal: 0 });
    expect(out).toContain('custom 1');
    expect(out).toContain('kb_daemon_inflight 0');
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
