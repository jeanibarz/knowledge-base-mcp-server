import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
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
      includeSources: false,
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

describe('parseDiagnoseArgs --to-fixture mode (issue #977)', () => {
  it('parses the to-fixture shape', () => {
    expect(parseDiagnoseArgs([
      '--to-fixture=/tmp/bundle',
      '--out=/tmp/fx',
      '--include-sources',
      '--force',
      '--format=json',
    ])).toEqual({
      toFixture: '/tmp/bundle',
      fixtureOut: '/tmp/fx',
      stdin: false,
      includeContent: false,
      includeSources: true,
      force: true,
      format: 'json',
    });
  });

  it('rejects to-fixture combined with request-id bundle flags', () => {
    expect(() => parseDiagnoseArgs(['--to-fixture=/b', '--out=/o', '--request-id=r']))
      .toThrow(/--to-fixture cannot be combined with --request-id/);
    expect(() => parseDiagnoseArgs(['--to-fixture=/b', '--out=/o', '--repro-bundle=/d']))
      .toThrow(/--repro-bundle/);
    expect(() => parseDiagnoseArgs(['--to-fixture=/b', '--out=/o', '--query=x']))
      .toThrow(/--query/);
    expect(() => parseDiagnoseArgs(['--to-fixture=/b', '--out=/o', '--include-content']))
      .toThrow(/--include-content/);
  });

  it('rejects --out and --include-sources without --to-fixture', () => {
    expect(() => parseDiagnoseArgs(['--out=/o'])).toThrow(/--out is only valid with --to-fixture/);
    expect(() => parseDiagnoseArgs(['--include-sources']))
      .toThrow(/--include-sources is only valid with --to-fixture/);
  });
});

describe('runDiagnose --to-fixture mode (issue #977)', () => {
  function bundleFiles(bundleDir: string, candidates: unknown, query = 'rollback procedure'): Record<string, string> {
    return {
      [path.join(bundleDir, 'explain', 'query.txt')]: `${query}\n`,
      [path.join(bundleDir, 'explain', 'top-candidates.json')]: JSON.stringify({ k: 3, candidates }),
      [path.join(bundleDir, 'manifest.json')]: JSON.stringify({ selected_event: { kb_scope: 'ops', k: 3 } }),
    };
  }

  it('scaffolds a runnable fixture directory from a diagnose bundle', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const { deps, stdout } = depsFor(bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: '/abs/ops/deploy.md', relative_path: 'ops/deploy.md', knowledge_base: 'ops', in_topk: true, frontmatter: { status: 'approved' } },
        { rank: 2, score: 0.2, source: '/abs/ops/canary.md', relative_path: 'ops/canary.md', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
        { rank: 3, score: 0.9, source: '/abs/ops/old.md', relative_path: 'ops/archive/old.md', knowledge_base: 'ops', in_topk: false, frontmatter: {} },
      ]));

      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`], deps);
      expect(code).toBe(0);
      expect(stdout.join('')).toContain('Retrieval fixture written');

      const fixtureYaml = await fsp.readFile(path.join(fixtureDir, 'fixture.yml'), 'utf-8');
      expect(fixtureYaml).toContain('query: rollback procedure');
      expect(fixtureYaml).toContain('kb: ops');
      // Only in_topk candidates seed required_sources.
      expect(fixtureYaml).toContain('- ops/deploy.md');
      expect(fixtureYaml).toContain('- ops/canary.md');
      expect(fixtureYaml).not.toContain('ops/archive/old.md');

      // Corpus notes written at their relative paths; README + manifest present.
      expect((await fsp.stat(path.join(fixtureDir, 'corpus', 'ops', 'deploy.md'))).isFile()).toBe(true);
      expect((await fsp.stat(path.join(fixtureDir, 'corpus', 'ops', 'canary.md'))).isFile()).toBe(true);
      const readme = await fsp.readFile(path.join(fixtureDir, 'README.md'), 'utf-8');
      expect(readme).toContain('EMBEDDING_PROVIDER=fake');
      expect(readme).toContain('kb eval fixture.yml');

      const manifest = JSON.parse(await fsp.readFile(path.join(fixtureDir, 'manifest.json'), 'utf-8'));
      expect(manifest.schema_version).toBe('kb.diagnose.fixture.v1');
      expect(manifest.embeddings).toBe('fake');
      expect(manifest.corpus).toHaveLength(2);
      expect(manifest.include_sources).toBe(false);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('redacts secrets from the query and bundled content', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const { deps } = depsFor(bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: 's', relative_path: 'vault/secrets.md', knowledge_base: 'vault', in_topk: true, frontmatter: {}, content: 'api_key=sk-LEAKME0001 rest' },
      ], 'Authorization: Bearer tok-LEAKME0002 note'));

      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`], deps);
      expect(code).toBe(0);

      const body = await fsp.readFile(path.join(fixtureDir, 'corpus', 'vault', 'secrets.md'), 'utf-8');
      expect(body).not.toContain('sk-LEAKME0001');
      expect(body).not.toContain('tok-LEAKME0002');
      expect(body).toContain('[REDACTED]');
      const fixtureYaml = await fsp.readFile(path.join(fixtureDir, 'fixture.yml'), 'utf-8');
      expect(fixtureYaml).not.toContain('tok-LEAKME0002');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rehydrates note bodies from disk only with --include-sources', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const kbRoot = path.join(tempRoot, 'kbroot');
      const notePath = path.join(kbRoot, 'ops/deploy.md');
      const files = bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: 'ignored', relative_path: 'ops/deploy.md', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
      ]);
      files[notePath] = '# Real body\n\nThe ACTUAL note content.\n';
      const { deps } = depsFor(files, { env: { KNOWLEDGE_BASES_ROOT_DIR: kbRoot } });

      const code = await runDiagnose(
        [`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`, '--include-sources'],
        deps,
      );
      expect(code).toBe(0);
      const body = await fsp.readFile(path.join(fixtureDir, 'corpus', 'ops', 'deploy.md'), 'utf-8');
      expect(body).toContain('The ACTUAL note content.');
      const manifest = JSON.parse(await fsp.readFile(path.join(fixtureDir, 'manifest.json'), 'utf-8'));
      expect(manifest.corpus[0].rehydrated_from_disk).toBe(true);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('builds the stand-in corpus and does NOT read disk without --include-sources', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const kbRoot = path.join(tempRoot, 'kbroot');
      const notePath = path.join(kbRoot, 'ops/deploy.md');
      const files = bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: 'ignored', relative_path: 'ops/deploy.md', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
      ]);
      files[notePath] = 'ON_DISK_SENTINEL should never be read without the flag';
      const { deps } = depsFor(files, { env: { KNOWLEDGE_BASES_ROOT_DIR: kbRoot } });

      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`], deps);
      expect(code).toBe(0);
      const body = await fsp.readFile(path.join(fixtureDir, 'corpus', 'ops', 'deploy.md'), 'utf-8');
      expect(body).not.toContain('ON_DISK_SENTINEL');
      expect(body).toContain('Redacted stand-in generated by');
      const manifest = JSON.parse(await fsp.readFile(path.join(fixtureDir, 'manifest.json'), 'utf-8'));
      expect(manifest.corpus[0].rehydrated_from_disk).toBe(false);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('redacts secrets in a rehydrated on-disk note body (--include-sources)', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const kbRoot = path.join(tempRoot, 'kbroot');
      const notePath = path.join(kbRoot, 'ops/deploy.md');
      const files = bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: 'ignored', relative_path: 'ops/deploy.md', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
      ]);
      files[notePath] = '# Deploy\n\napi_key=sk-DISKLEAK9999 and prose.\n';
      const { deps } = depsFor(files, { env: { KNOWLEDGE_BASES_ROOT_DIR: kbRoot } });

      const code = await runDiagnose(
        [`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`, '--include-sources'],
        deps,
      );
      expect(code).toBe(0);
      const body = await fsp.readFile(path.join(fixtureDir, 'corpus', 'ops', 'deploy.md'), 'utf-8');
      expect(body).toContain('prose.');
      expect(body).not.toContain('sk-DISKLEAK9999');
      expect(body).toContain('[REDACTED]');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses to read outside the knowledge-base root on traversal paths', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const kbRoot = path.join(tempRoot, 'kbroot');
      // A file OUTSIDE the kb root that a crafted bundle tries to reach.
      const secretPath = path.join(tempRoot, 'secret.txt');
      const files = bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: secretPath, relative_path: '../secret.txt', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
      ]);
      files[secretPath] = 'TOP_SECRET_OUTSIDE_ROOT';
      const { deps } = depsFor(files, { env: { KNOWLEDGE_BASES_ROOT_DIR: kbRoot } });

      const code = await runDiagnose(
        [`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`, '--include-sources'],
        deps,
      );
      expect(code).toBe(0);
      // Write path is sanitized (no `..`), so the note stays under corpus/.
      const written = await fsp.readdir(path.join(fixtureDir, 'corpus'), { recursive: true });
      const bodies = await Promise.all(
        written
          .filter((f) => typeof f === 'string' && f.endsWith('.md'))
          .map((f) => fsp.readFile(path.join(fixtureDir, 'corpus', f as string), 'utf-8')),
      );
      // The traversal read must be refused — the out-of-root secret never lands.
      expect(bodies.join('\n')).not.toContain('TOP_SECRET_OUTSIDE_ROOT');
      const manifest = JSON.parse(await fsp.readFile(path.join(fixtureDir, 'manifest.json'), 'utf-8'));
      expect(manifest.corpus.every((c: { rehydrated_from_disk: boolean }) => c.rehydrated_from_disk === false)).toBe(true);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to all usable candidates when none are flagged in_topk', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const fixtureDir = path.join(tempRoot, 'fx');
      const { deps } = depsFor(bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: 's1', relative_path: 'ops/a.md', knowledge_base: 'ops', in_topk: false, frontmatter: {} },
        { rank: 2, score: 0.2, source: 's2', relative_path: 'ops/b.md', knowledge_base: 'ops', in_topk: false, frontmatter: {} },
      ]));

      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${fixtureDir}`], deps);
      expect(code).toBe(0);
      const parsed = yaml.load(await fsp.readFile(path.join(fixtureDir, 'fixture.yml'), 'utf-8')) as {
        gate: boolean;
        mode: string;
        cases: Array<{ k: number; stale_policy: string; required_sources: string[] }>;
      };
      expect(parsed.gate).toBe(false);
      expect(parsed.mode).toBe('dense');
      expect(parsed.cases[0].stale_policy).toBe('allow_stale');
      expect(parsed.cases[0].k).toBeGreaterThanOrEqual(2);
      expect(parsed.cases[0].required_sources.sort()).toEqual(['ops/a.md', 'ops/b.md']);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('errors when --out equals the bundle directory', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const { deps, stderr } = depsFor(bundleFiles(bundleDir, [
        { rank: 1, score: 0.1, source: 's', relative_path: 'ops/a.md', knowledge_base: 'ops', in_topk: true, frontmatter: {} },
      ]));
      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${bundleDir}`], deps);
      expect(code).toBe(2);
      expect(stderr.join('')).toContain('must differ');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('errors when --out is missing', async () => {
    const { deps, stderr } = depsFor({});
    const code = await runDiagnose(['--to-fixture=/tmp/bundle'], deps);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('requires --out');
  });

  it('errors when the bundle has no replayed query', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const { deps, stderr } = depsFor({}); // no explain/query.txt
      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${path.join(tempRoot, 'fx')}`], deps);
      expect(code).toBe(1);
      expect(stderr.join('')).toMatch(/query\.txt/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('errors when there are no usable candidate hits', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tofixture-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      const { deps, stderr } = depsFor(bundleFiles(bundleDir, []));
      const code = await runDiagnose([`--to-fixture=${bundleDir}`, `--out=${path.join(tempRoot, 'fx')}`], deps);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('no usable candidate hits');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
