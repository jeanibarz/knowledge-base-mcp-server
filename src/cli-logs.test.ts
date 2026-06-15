import { describe, expect, it } from '@jest/globals';
import {
  parseCanonicalLogLines,
  parseLogsArgs,
  runLogs,
  type RunLogsDeps,
} from './cli-logs.js';

function canonical(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schema_version: 'kb-canonical.v1',
    ts: '2026-05-18T20:00:00.000Z',
    request_id: 'req-1',
    process: 'cli',
    cmd: 'kb search',
    took_ms: 42,
    ...overrides,
  });
}

function depsFor(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): {
  deps: RunLogsDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: RunLogsDeps = {
    readFile: (filePath) => {
      const text = files[filePath];
      if (text === undefined) throw new Error(`ENOENT: ${filePath}`);
      return text;
    },
    exists: (filePath) => files[filePath] !== undefined,
    env,
    cwd: () => '/repo',
    homedir: () => '/home/alice',
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { deps, stdout, stderr };
}

describe('parseLogsArgs', () => {
  it('parses recent and show commands', () => {
    expect(parseLogsArgs(['recent', '--limit=5', '--file=./kb.log', '--format=json'])).toEqual({
      action: 'recent',
      format: 'json',
      file: './kb.log',
      limit: 5,
      slow: false,
      degraded: false,
    });
    expect(parseLogsArgs(['show', '--request-id=req-1'])).toEqual({
      action: 'show',
      format: 'md',
      limit: 20,
      slow: false,
      degraded: false,
      requestId: 'req-1',
    });
    expect(parseLogsArgs(['show', '--query-sha=abc123'])).toMatchObject({
      action: 'show',
      querySha: 'abc123',
    });
    expect(parseLogsArgs(['--slow', '--min-ms', '250'])).toEqual({
      action: 'recent',
      format: 'md',
      limit: 20,
      slow: true,
      degraded: false,
      minMs: 250,
    });
    expect(parseLogsArgs(['--degraded', '--format=json'])).toEqual({
      action: 'recent',
      format: 'json',
      limit: 20,
      slow: false,
      degraded: true,
    });
  });

  it('rejects ambiguous filters and invalid limits', () => {
    expect(() => parseLogsArgs(['show'])).toThrow(/requires exactly one/);
    expect(() => parseLogsArgs(['show', '--request-id=a', '--query-sha=b'])).toThrow(/exactly one/);
    expect(() => parseLogsArgs(['recent', '--request-id=a'])).toThrow(/recent does not accept/);
    expect(() => parseLogsArgs(['recent', '--limit=0'])).toThrow(/between 1 and 500/);
    expect(() => parseLogsArgs(['recent', '--slow', '--min-ms=0'])).toThrow(/at least 1/);
  });

  it('parses the summary action in both forms and rejects show-only filters', () => {
    expect(parseLogsArgs(['--summary'])).toEqual({
      action: 'summary',
      format: 'md',
      limit: 20,
      slow: false,
      degraded: false,
    });
    expect(parseLogsArgs(['summary', '--limit=5', '--format=json'])).toEqual({
      action: 'summary',
      format: 'json',
      limit: 5,
      slow: false,
      degraded: false,
    });
    expect(() => parseLogsArgs(['--summary', '--request-id=a'])).toThrow(/summary does not accept/);
  });
});

describe('parseCanonicalLogLines', () => {
  it('keeps canonical JSON lines and tolerates mixed text logs', () => {
    const parsed = parseCanonicalLogLines([
      '2026-05-18T20:00:00Z [INFO] text log',
      canonical({ request_id: 'req-1' }),
      '{"schema_version":"kb-canonical.v1",',
      canonical({ request_id: 'req-2', query_sha256: 'abc123' }),
      '',
    ].join('\n'));

    expect(parsed.scannedLineCount).toBe(4);
    expect(parsed.ignoredLineCount).toBe(1);
    expect(parsed.malformedCanonicalLineCount).toBe(1);
    expect(parsed.events.map((event) => event.request_id)).toEqual(['req-1', 'req-2']);
  });
});

describe('runLogs', () => {
  it('prints recent canonical events as stable JSON from LOG_FILE', async () => {
    const { deps, stdout, stderr } = depsFor({
      '/repo/kb.log': [
        canonical({ request_id: 'req-1', query_sha256: 'old' }),
        canonical({
          request_id: 'req-2',
          query_sha256: 'new',
          result_count: 3,
          query_cache: {
            enabled: true,
            outcome: 'disk_hit',
            model_id: 'fake__model',
            elapsed_ms: 2,
          },
        }),
      ].join('\n'),
    }, { LOG_FILE: './kb.log' });

    const code = await runLogs(['recent', '--limit=1', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = JSON.parse(stdout.join('')) as {
      schema_version: string;
      source: string;
      result_count: number;
      events: Array<{
        request_id: string;
        query_sha256: string;
        result_count?: number;
        query_cache?: unknown;
      }>;
    };
    expect(payload.schema_version).toBe('kb.logs.v1');
    expect(payload.source).toBe('/repo/kb.log');
    expect(payload.result_count).toBe(1);
    expect(payload.events).toEqual([
      expect.objectContaining({
        request_id: 'req-2',
        query_sha256: 'new',
        result_count: 3,
        query_cache: {
          enabled: true,
          outcome: 'disk_hit',
          model_id: 'fake__model',
          elapsed_ms: 2,
        },
      }),
    ]);
  });

  it('filters recent events to slow canonical markers with kb logs --slow', async () => {
    const { deps, stdout, stderr } = depsFor({
      '/repo/kb.log': [
        canonical({ request_id: 'req-fast', query_sha256: 'fast', took_ms: 20 }),
        canonical({ request_id: 'req-slow', query_sha256: 'slow', took_ms: 200, slow: true }),
        canonical({ request_id: 'req-unmarked', query_sha256: 'unmarked', took_ms: 400 }),
      ].join('\n'),
    }, { LOG_FILE: './kb.log' });

    const code = await runLogs(['--slow', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = JSON.parse(stdout.join('')) as {
      filters: { slow?: true };
      slow_event_count: number;
      result_count: number;
      events: Array<{ request_id: string; query_sha256?: string; slow?: true }>;
    };
    expect(payload.filters).toEqual({ slow: true });
    expect(payload.slow_event_count).toBe(1);
    expect(payload.result_count).toBe(1);
    expect(payload.events).toEqual([
      expect.objectContaining({ request_id: 'req-slow', query_sha256: 'slow', slow: true }),
    ]);
  });

  it('filters slow view by minimum took_ms when --min-ms is supplied', async () => {
    const { deps, stdout } = depsFor({
      '/repo/kb.log': [
        canonical({ request_id: 'req-100', took_ms: 100, slow: true }),
        canonical({ request_id: 'req-250', took_ms: 250 }),
        canonical({ request_id: 'req-400', took_ms: 400, slow: true }),
      ].join('\n'),
    }, { LOG_FILE: './kb.log' });

    const code = await runLogs(['recent', '--slow', '--min-ms=250', '--format=json'], deps);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      filters: { slow?: true; min_ms?: number };
      events: Array<{ request_id: string }>;
    };
    expect(payload.filters).toEqual({ slow: true, min_ms: 250 });
    expect(payload.events.map((event) => event.request_id)).toEqual(['req-250', 'req-400']);
  });

  it('filters recent events to degraded canonical markers with kb logs --degraded', async () => {
    const { deps, stdout, stderr } = depsFor({
      '/repo/kb.log': [
        canonical({ request_id: 'req-ok', query_sha256: 'ok' }),
        canonical({
          request_id: 'req-degraded',
          query_sha256: 'degraded',
          degraded: true,
          degraded_stages: [
            { stage: 'rerank', reason: 'model unavailable' },
          ],
        }),
      ].join('\n'),
    }, { LOG_FILE: './kb.log' });

    const code = await runLogs(['--degraded', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = JSON.parse(stdout.join('')) as {
      filters: { degraded?: true };
      degraded_event_count: number;
      result_count: number;
      events: Array<{
        request_id: string;
        degraded?: true;
        degraded_stages?: Array<{ stage: string; reason?: string }>;
      }>;
    };
    expect(payload.filters).toEqual({ degraded: true });
    expect(payload.degraded_event_count).toBe(1);
    expect(payload.result_count).toBe(1);
    expect(payload.events).toEqual([
      expect.objectContaining({
        request_id: 'req-degraded',
        degraded: true,
        degraded_stages: [{ stage: 'rerank', reason: 'model unavailable' }],
      }),
    ]);
  });

  it('shows request details with timings, sources, gate, rerank, and recovery hints in markdown', async () => {
    const { deps, stdout } = depsFor({
      '/tmp/canonical.log': [
        canonical({
          request_id: 'req-match',
          query_sha256: 'abc123',
          took_ms: 125,
          embed_ms: 20,
          faiss_ms: 40,
          format_ms: 5,
          top_sources: ['docs/a.md', 'docs/b.md'],
          gate: { verdict: 'injected', kept: 2 },
          degraded: true,
          degraded_stages: [{ stage: 'gate', reason: 'judge failed' }],
          rerank_ms: 11,
          error: { code: 'PROVIDER_TIMEOUT', category: 'provider' },
          recovery_hint: 'Run `kb doctor`.',
        }),
        canonical({ request_id: 'req-other' }),
      ].join('\n'),
    });

    const code = await runLogs(['show', '--request-id=req-match', '--file=/tmp/canonical.log'], deps);

    expect(code).toBe(0);
    const md = stdout.join('');
    expect(md).toContain('# KB Logs');
    expect(md).toContain('`req-match`');
    expect(md).not.toContain('req-other');
    expect(md).toContain('took=125ms, embed=20ms, faiss=40ms, format=5ms');
    expect(md).toContain('`docs/a.md`, `docs/b.md`');
    expect(md).toContain('Gate: `{"verdict":"injected","kept":2}`');
    expect(md).toContain('Degraded: gate:judge failed');
    expect(md).toContain('Rerank: `{"rerank_ms":11}`');
    expect(md).toContain('Recovery hint: Run `kb doctor`.');
  });

  it('does not crash markdown output when optional canonical fields are malformed', async () => {
    const { deps, stdout, stderr } = depsFor({
      '/tmp/malformed.log': JSON.stringify({
        schema_version: 'kb-canonical.v1',
        ts: '2026-05-18T20:00:00.000Z',
        request_id: 'req-bad-fields',
        process: 'cli',
        cmd: 'kb search',
        took_ms: 8,
        top_sources: 'not-array',
        result_count: 'not-number',
      }),
    });

    const code = await runLogs(['recent', '--file=/tmp/malformed.log'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const md = stdout.join('');
    expect(md).toContain('`req-bad-fields`');
    expect(md).not.toContain('Top sources:');
    expect(md).not.toContain('not-array');
  });

  it('uses an existing default path when LOG_FILE is not set', async () => {
    const defaultPath = '/home/alice/.local/state/knowledge-base-mcp-server/kb.log';
    const { deps, stdout } = depsFor({
      [defaultPath]: canonical({ request_id: 'req-default' }),
    });

    const code = await runLogs(['recent', '--format=json'], deps);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join('')).source).toBe(defaultPath);
  });

  it('returns a machine-readable error when no log file is discoverable for JSON output', async () => {
    const { deps, stdout, stderr } = depsFor({});

    const code = await runLogs(['recent', '--format=json'], deps);

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toEqual({
      schema_version: 'kb.logs.v1',
      error: {
        code: 'LOG_FILE_NOT_FOUND',
        message: 'no log file found; pass --file=<path> or set LOG_FILE',
      },
    });
  });
});

describe('runLogs --summary', () => {
  // took_ms 10..100 across 10 requests; 3 carry errors. Used to assert exact
  // percentile math and the outcome/error-code breakdown.
  const summaryLog = [
    canonical({ request_id: 'r1', query_sha256: 'q1', took_ms: 10 }),
    canonical({ request_id: 'r2', query_sha256: 'q2', took_ms: 20 }),
    canonical({ request_id: 'r3', query_sha256: 'q3', took_ms: 30, error: { code: 'VALIDATION', category: 'input' } }),
    canonical({ request_id: 'r4', query_sha256: 'q4', took_ms: 40 }),
    canonical({ request_id: 'r5', query_sha256: 'q5', took_ms: 50 }),
    canonical({ request_id: 'r6', query_sha256: 'q6', took_ms: 60 }),
    canonical({ request_id: 'r7', query_sha256: 'q7', took_ms: 70, error: { code: 'PROVIDER_TIMEOUT', category: 'provider' } }),
    canonical({ request_id: 'r8', query_sha256: 'q8', took_ms: 80 }),
    canonical({ request_id: 'r9', query_sha256: 'q9', took_ms: 90 }),
    canonical({ request_id: 'r10', query_sha256: 'q10', took_ms: 100, error: { code: 'PROVIDER_TIMEOUT', category: 'provider' } }),
  ].join('\n');

  it('aggregates percentiles, outcomes, and error-code breakdown as JSON', async () => {
    const { deps, stdout, stderr } = depsFor(
      { '/repo/kb.log': summaryLog },
      { LOG_FILE: './kb.log' },
    );

    const code = await runLogs(['--summary', '--limit=3', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = JSON.parse(stdout.join('')) as {
      action: string;
      summary: {
        total_requests: number;
        outcomes: { success: number; error: number };
        by_error_code: Record<string, number>;
        by_error_category: Record<string, number>;
        latency_ms: { count: number; min: number; max: number; p50: number; p95: number; p99: number } | null;
        slowest: Array<{ request_id: string; took_ms: number; error_code?: string }>;
      };
    };

    expect(payload.action).toBe('summary');
    expect(payload.summary.total_requests).toBe(10);
    expect(payload.summary.outcomes).toEqual({ success: 7, error: 3 });
    expect(payload.summary.by_error_code).toEqual({ PROVIDER_TIMEOUT: 2, VALIDATION: 1 });
    expect(payload.summary.by_error_category).toEqual({ provider: 2, input: 1 });
    expect(payload.summary.latency_ms).toEqual({
      count: 10,
      min: 10,
      max: 100,
      p50: 50,
      p95: 100,
      p99: 100,
    });
    // top-N slowest, descending, honouring --limit
    expect(payload.summary.slowest.map((entry) => entry.request_id)).toEqual(['r10', 'r9', 'r8']);
    expect(payload.summary.slowest[0]).toMatchObject({ took_ms: 100, error_code: 'PROVIDER_TIMEOUT' });
  });

  it('computes nearest-rank percentiles for an odd-sized sample', async () => {
    // took_ms = [100, 200, 300]; p50 -> rank 2 -> 200, p95/p99 -> rank 3 -> 300.
    const { deps, stdout } = depsFor(
      {
        '/repo/kb.log': [
          canonical({ request_id: 'a', took_ms: 300 }),
          canonical({ request_id: 'b', took_ms: 100 }),
          canonical({ request_id: 'c', took_ms: 200 }),
        ].join('\n'),
      },
      { LOG_FILE: './kb.log' },
    );

    const code = await runLogs(['--summary', '--format=json'], deps);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      summary: { latency_ms: { p50: number; p95: number; p99: number; min: number; max: number } };
    };
    expect(payload.summary.latency_ms).toMatchObject({ min: 100, p50: 200, p95: 300, p99: 300, max: 300 });
  });

  it('renders the summary as markdown', async () => {
    const { deps, stdout } = depsFor(
      { '/repo/kb.log': summaryLog },
      { LOG_FILE: './kb.log' },
    );

    const code = await runLogs(['--summary'], deps);

    expect(code).toBe(0);
    const md = stdout.join('');
    expect(md).toContain('## Summary');
    expect(md).toContain('- Total requests: 10');
    expect(md).toContain('- Success: 7');
    expect(md).toContain('- Error: 3');
    expect(md).toContain('p95: 100 ms');
    expect(md).toContain('`PROVIDER_TIMEOUT`: 2');
    expect(md).toContain('### Slowest queries');
    expect(md).toContain('`r10`');
  });

  it('reports null latency and empty breakdown for a log with no timed requests', async () => {
    // Canonical lines whose took_ms is non-numeric are ignored for latency.
    const { deps, stdout } = depsFor(
      {
        '/repo/kb.log': JSON.stringify({
          schema_version: 'kb-canonical.v1',
          ts: '2026-05-18T20:00:00.000Z',
          request_id: 'no-timing',
          process: 'cli',
          cmd: 'kb search',
          took_ms: 'not-a-number',
        }),
      },
      { LOG_FILE: './kb.log' },
    );

    const code = await runLogs(['--summary', '--format=json'], deps);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      summary: {
        total_requests: number;
        outcomes: { success: number; error: number };
        latency_ms: null | object;
        slowest: unknown[];
      };
    };
    expect(payload.summary.total_requests).toBe(1);
    expect(payload.summary.outcomes).toEqual({ success: 1, error: 0 });
    expect(payload.summary.latency_ms).toBeNull();
    expect(payload.summary.slowest).toEqual([]);
  });
});
