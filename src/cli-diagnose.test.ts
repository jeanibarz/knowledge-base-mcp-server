import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseDiagnoseArgs,
  runDiagnose,
  type DiagnoseDeps,
} from './cli-diagnose.js';
import { hashQuery } from './canonical-log.js';

function canonical(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schema_version: 'kb-canonical.v1',
    ts: '2026-06-20T10:00:00.000Z',
    request_id: 'req-1',
    process: 'cli',
    cmd: 'kb search',
    took_ms: 42,
    ...overrides,
  });
}

function depsFor(files: Record<string, string>, overrides: Partial<DiagnoseDeps> = {}): {
  deps: DiagnoseDeps;
  stdout: string[];
  stderr: string[];
  explainCalls: string[][];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const explainCalls: string[][] = [];
  const deps: DiagnoseDeps = {
    readFile: (filePath) => {
      const text = files[filePath];
      if (text === undefined) throw new Error(`ENOENT: ${filePath}`);
      return text;
    },
    exists: (filePath) => files[filePath] !== undefined,
    env: {},
    cwd: () => '/repo',
    homedir: () => '/home/alice',
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    readStdin: async () => '',
    runExplain: async (args) => {
      explainCalls.push(args);
      return 0;
    },
    now: () => new Date('2026-06-20T11:22:33.000Z'),
    ...overrides,
  };
  return { deps, stdout, stderr, explainCalls };
}

describe('parseDiagnoseArgs', () => {
  it('parses the request-id bundle shape', () => {
    expect(parseDiagnoseArgs([
      '--request-id=req-1',
      '--repro-bundle=./diag',
      '--file=./kb.log',
      '--query=rollback',
      '--include-content',
      '--force',
      '--format=json',
    ])).toEqual({
      requestId: 'req-1',
      reproBundle: './diag',
      file: './kb.log',
      query: 'rollback',
      stdin: false,
      includeContent: true,
      force: true,
      format: 'json',
    });
  });

  it('rejects ambiguous raw-query sources', () => {
    expect(() => parseDiagnoseArgs(['--query=a', '--stdin'])).toThrow(/at most one/);
    expect(() => parseDiagnoseArgs(['--query=a', '--query-file=q.txt'])).toThrow(/at most one/);
  });
});

describe('runDiagnose', () => {
  it('writes a redacted canonical-log bundle without a raw query', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-diagnose-test-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const logFile = path.join(tempRoot, 'kb.log');
      const { deps, stdout, stderr, explainCalls } = depsFor({
        [logFile]: [
          canonical({
            request_id: 'req-match',
            query_sha256: 'abc123',
            error: { code: 'PROVIDER_TIMEOUT', category: 'provider' },
            recovery_hint: 'Authorization: Bearer ghp_123456789012345678901234',
          }),
          canonical({ request_id: 'req-other' }),
        ].join('\n'),
      });

      const code = await runDiagnose([
        '--request-id=req-match',
        `--file=${logFile}`,
        `--repro-bundle=${bundleDir}`,
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(explainCalls).toEqual([]);
      const manifest = JSON.parse(stdout.join('')) as {
        schema_version: string;
        event_count: number;
        raw_query: { supplied: boolean };
        explain: { attempted: boolean };
        redaction_summary: { total: number };
      };
      expect(manifest.schema_version).toBe('kb.diagnose.repro_bundle.v1');
      expect(manifest.event_count).toBe(1);
      expect(manifest.raw_query.supplied).toBe(false);
      expect(manifest.explain.attempted).toBe(false);
      expect(manifest.redaction_summary.total).toBeGreaterThanOrEqual(1);

      const events = await fsp.readFile(path.join(bundleDir, 'canonical-events.json'), 'utf-8');
      expect(events).toContain('req-match');
      expect(events).not.toContain('req-other');
      expect(events).not.toContain('ghp_123456789012345678901234');
      expect(events).toContain('[REDACTED]');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('replays kb explain with query and canonical hints when supplied', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-diagnose-test-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const logFile = path.join(tempRoot, 'kb.log');
      const query = 'rollback procedure';
      const { deps, stdout, explainCalls } = depsFor({
        [logFile]: canonical({
          request_id: 'req-match',
          query_sha256: hashQuery(query),
          query_len_chars: query.length,
          model_id: 'fake__model',
          kb_scope: 'runbooks',
          k: 3,
          threshold: 0.7,
        }),
      }, {
        exists: (filePath) => filePath === logFile || filePath === path.join(bundleDir, 'explain'),
      });

      const code = await runDiagnose([
        '--request-id=req-match',
        `--file=${logFile}`,
        `--repro-bundle=${bundleDir}`,
        `--query=${query}`,
        '--include-content',
        '--force',
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(explainCalls).toHaveLength(1);
      expect(explainCalls[0]).toEqual([
        query,
        `--repro-bundle=${path.join(bundleDir, 'explain')}`,
        '--format=json',
        '--kb=runbooks',
        '--model=fake__model',
        '--k=3',
        '--threshold=0.7',
        '--include-content',
        '--force',
      ]);
      const manifest = JSON.parse(stdout.join('')) as {
        raw_query: {
          supplied: boolean;
          source: string;
          query_sha256_matches: boolean;
          query_len_chars_matches: boolean;
        };
        explain: { attempted: boolean; inferred_args: string[]; bundle_dir: string | null };
      };
      expect(manifest.raw_query).toEqual({
        supplied: true,
        source: '--query',
        query_sha256_matches: true,
        query_len_chars_matches: true,
      });
      expect(manifest.explain.attempted).toBe(true);
      expect(manifest.explain.bundle_dir).toBe('explain');
      expect(manifest.explain.inferred_args[0]).toBe('<raw-query>');
      expect(manifest.explain.inferred_args).not.toContain(query);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('clears stale explain replay data before writing a no-query bundle', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-diagnose-test-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const staleExplainDir = path.join(bundleDir, 'explain');
      await fsp.mkdir(staleExplainDir, { recursive: true });
      if (process.platform !== 'win32') await fsp.chmod(bundleDir, 0o700);
      await fsp.writeFile(path.join(staleExplainDir, 'query.txt'), 'old sensitive query');
      await fsp.writeFile(path.join(bundleDir, 'manifest.json'), '{}');
      const logFile = path.join(tempRoot, 'kb.log');
      const { deps, stdout } = depsFor({
        [logFile]: canonical({ request_id: 'req-match' }),
      });

      const code = await runDiagnose([
        '--request-id=req-match',
        `--file=${logFile}`,
        `--repro-bundle=${bundleDir}`,
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      await expect(fsp.stat(staleExplainDir)).rejects.toThrow(/ENOENT/);
      const manifest = JSON.parse(stdout.join('')) as {
        explain: { attempted: boolean; bundle_dir: string | null };
        files: string[];
      };
      expect(manifest.explain).toMatchObject({ attempted: false, bundle_dir: null });
      expect(manifest.files).not.toContain('explain');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not claim an explain bundle when replay fails before creating one', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-diagnose-test-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const logFile = path.join(tempRoot, 'kb.log');
      const query = 'rollback procedure';
      const { deps, stdout } = depsFor({
        [logFile]: canonical({ request_id: 'req-match' }),
      }, {
        runExplain: async () => 1,
      });

      const code = await runDiagnose([
        '--request-id=req-match',
        `--file=${logFile}`,
        `--repro-bundle=${bundleDir}`,
        `--query=${query}`,
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      const manifest = JSON.parse(stdout.join('')) as {
        explain: { attempted: boolean; exit_code: number | null; bundle_dir: string | null };
        files: string[];
      };
      expect(manifest.explain).toMatchObject({
        attempted: true,
        exit_code: 1,
        bundle_dir: null,
      });
      expect(manifest.files).not.toContain('explain');
      const readme = await fsp.readFile(path.join(bundleDir, 'README.md'), 'utf-8');
      expect(readme).not.toContain('`explain/`');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects include-content when no raw query is supplied', async () => {
    const { deps, stderr } = depsFor({});

    const code = await runDiagnose([
      '--request-id=req-1',
      '--repro-bundle=/tmp/out',
      '--include-content',
    ], deps);

    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--include-content requires');
  });
});
