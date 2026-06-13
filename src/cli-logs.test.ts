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
