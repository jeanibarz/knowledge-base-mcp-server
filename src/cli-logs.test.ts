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
    });
    expect(parseLogsArgs(['show', '--request-id=req-1'])).toEqual({
      action: 'show',
      format: 'md',
      limit: 20,
      requestId: 'req-1',
    });
    expect(parseLogsArgs(['show', '--query-sha=abc123'])).toMatchObject({
      action: 'show',
      querySha: 'abc123',
    });
  });

  it('rejects ambiguous filters and invalid limits', () => {
    expect(() => parseLogsArgs(['show'])).toThrow(/requires exactly one/);
    expect(() => parseLogsArgs(['show', '--request-id=a', '--query-sha=b'])).toThrow(/exactly one/);
    expect(() => parseLogsArgs(['recent', '--request-id=a'])).toThrow(/recent does not accept/);
    expect(() => parseLogsArgs(['recent', '--limit=0'])).toThrow(/between 1 and 500/);
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
        canonical({ request_id: 'req-2', query_sha256: 'new', result_count: 3 }),
      ].join('\n'),
    }, { LOG_FILE: './kb.log' });

    const code = await runLogs(['recent', '--limit=1', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = JSON.parse(stdout.join('')) as {
      schema_version: string;
      source: string;
      result_count: number;
      events: Array<{ request_id: string; query_sha256: string; result_count?: number }>;
    };
    expect(payload.schema_version).toBe('kb.logs.v1');
    expect(payload.source).toBe('/repo/kb.log');
    expect(payload.result_count).toBe(1);
    expect(payload.events).toEqual([
      expect.objectContaining({ request_id: 'req-2', query_sha256: 'new', result_count: 3 }),
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
