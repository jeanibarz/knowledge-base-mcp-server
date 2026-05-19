// Integration test for `bin/kb` — spawned as a child process so we exercise
// the actual chmod, shebang, ESM resolution, and env-var inheritance.
//
// Slow tests (each spawn is ~150-400 ms cold-start), so we keep the matrix
// minimal: argv parsing, list, model-mismatch error path. The full search
// path against a real FAISS index is out of scope (would require a real
// embedding provider or extensive mocking that doesn't survive child-process
// boundaries).

import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Jest runs from the project root; the built CLI lives at build/cli.js.
// Avoiding import.meta.url here because ts-jest's emit doesn't support it
// under the project's tsconfig module setting.
const cliPath = path.join(process.cwd(), 'build', 'cli.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}, input?: string): RunResult {
  const result = spawnSync('node', [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? '', KB_LOG_FORMAT: 'text', ...env },
    encoding: 'utf-8',
    input,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('kb CLI — argv parsing and dispatch', () => {
  it('--help exits 0 with usage text and a clean Available commands list', () => {
    const r = runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kb — knowledge-base CLI');
    expect(r.stdout).toContain('Available commands:');
    // Each subcommand appears as a top-level entry in the new clean list.
    for (const sub of [
      'list',
      'search',
      'serve',
      'ask',
      'remember',
      'capture',
      'import-url',
      'compare',
      'doctor',
      'stats',
      'eval',
      'explain',
      'stale-check',
      'superseded',
      'promote',
      'quarantine',
      'where',
      'models',
      'llm',
    ]) {
      expect(r.stdout).toMatch(new RegExp(`\\n  ${sub.replace('-', '\\-')}\\s`));
    }
    // The hint pointing users at per-command help.
    expect(r.stdout).toContain('kb <command> --help');
  });

  // Per-subcommand `--help` interception (regression: every subcommand used
  // to fail with "unknown flag: --help" or write a one-line usage to stderr
  // and exit 2). The central interceptor in cli.ts now answers --help / -h
  // for every registered subcommand on stdout with exit 0.
  describe.each([
    ['list', 'kb list'],
    ['search', 'kb search'],
    ['serve', 'kb serve'],
    ['ask', 'kb ask'],
    ['remember', 'kb remember'],
    ['capture', 'kb capture'],
    ['import-url', 'kb import-url'],
    ['compare', 'kb compare'],
    ['doctor', 'kb doctor'],
    ['stats', 'kb stats'],
    ['eval', 'kb eval'],
    ['explain', 'kb explain'],
    ['stale-check', 'kb stale-check'],
    ['superseded', 'kb superseded'],
    ['promote', 'kb promote'],
    ['quarantine', 'kb quarantine'],
    ['where', 'kb where'],
    ['models', 'kb models'],
    ['llm', 'kb llm'],
  ])('kb %s --help', (sub, marker) => {
    it('exits 0 with detailed help on stdout', () => {
      const long = runCli([sub, '--help']);
      expect(long.code).toBe(0);
      expect(long.stderr).toBe('');
      expect(long.stdout).toContain(marker);
      expect(long.stdout).toContain('Usage:');

      const short = runCli([sub, '-h']);
      expect(short.code).toBe(0);
      expect(short.stdout).toBe(long.stdout);
    });
  });

  it('kb help (no args) prints the top-level help', () => {
    const r = runCli(['help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kb — knowledge-base CLI');
    expect(r.stdout).toContain('Available commands:');
  });

  it('kb help <command> mirrors `kb <command> --help`', () => {
    const a = runCli(['help', 'search']);
    const b = runCli(['search', '--help']);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('kb help unknown-cmd exits 2 with a stderr error', () => {
    const r = runCli(['help', 'not-a-real-command']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command 'not-a-real-command'");
    expect(r.stdout).toBe('');
  });

  it('--help anywhere in argv intercepts before the subcommand runs', () => {
    // Even when the user fat-fingers extra args, --help wins: no spawn,
    // no index load, no stderr noise.
    const r = runCli(['search', 'some-query', '--help']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('kb search');
    expect(r.stdout).toContain('Usage:');
  });

  it('no args exits 0 with usage text', () => {
    const r = runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kb — knowledge-base CLI');
  });

  it('--version exits 0 with package version', () => {
    const r = runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Regression: 0.2.0 had a driver guard `argv[1].endsWith('/cli.js')` that
  // failed under the npm-install-g symlink (argv[1] is `.../bin/kb`, not
  // `.../cli.js`), causing `kb` to silently exit 0 without running anything.
  // Reproduce by invoking through a symlink.
  it('runs main() when invoked through a symlink (regression for 0.2.0 npm-i-g bug)', async () => {
    const linkPath = path.join(os.tmpdir(), `kb-symlink-${process.pid}-${Date.now()}`);
    await fsp.symlink(cliPath, linkPath);
    try {
      const r = spawnSync('node', [linkPath, '--version'], {
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? '').trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await fsp.unlink(linkPath).catch(() => {});
    }
  });

  it('unknown subcommand exits 2 with help', () => {
    const r = runCli(['notacommand']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown subcommand 'notacommand'");
  });

  it('search without query (and no --stdin) exits 2', () => {
    const r = runCli(['search']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing <query>');
  });

  it('emits a canonical event for a kb subcommand invocation (#216)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-canonical-'));
    const logFile = path.join(tempDir, 'canonical.log');

    try {
      const r = runCli(['search'], {
        KB_LOG_FORMAT: 'canonical',
        LOG_FILE: logFile,
      });

      expect(r.code).toBe(2);
      expect(r.stderr).toContain('missing <query>');
      const lines = (await fsp.readFile(logFile, 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event).toMatchObject({
        schema_version: 'kb-canonical.v1',
        process: 'cli',
        cmd: 'kb search',
        error: {
          code: 'EXIT_2',
          category: 'input',
        },
      });
      expect(typeof event.request_id).toBe('string');
      expect(typeof event.took_ms).toBe('number');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('search with bogus flag exits 2', () => {
    const r = runCli(['search', 'q', '--zzz=1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown flag');
  });

  it('search with invalid --threshold exits 2', () => {
    const r = runCli(['search', 'q', '--threshold=notanumber']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid --threshold');
  });

  it('search with --daemon is accepted and falls back to direct mode when no daemon is listening', () => {
    const r = runCli(['search', 'q', '--daemon']);
    expect(r.stderr).not.toContain('unknown flag');
  });

  it('search with --threshold=auto is accepted by the parser', () => {
    // Parser must accept the literal "auto"; the call still fails downstream
    // (no model registered in this test env) but never with an "invalid
    // --threshold" parse error.
    const r = runCli(['search', 'q', '--threshold=auto']);
    expect(r.stderr).not.toContain('invalid --threshold');
  });

  it('search with --group-by-source is accepted by the parser', () => {
    const r = runCli(['search', 'q', '--group-by-source']);
    expect(r.stderr).not.toContain('unknown flag');
  });

  it('explain without query exits 2', () => {
    const r = runCli(['explain']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing <query>');
  });

  it('explain with bogus flag exits 2', () => {
    const r = runCli(['explain', 'q', '--zzz=1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown flag');
  });

  it('explain with --include-content but no --repro-bundle exits 2', () => {
    const r = runCli(['explain', 'q', '--include-content']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--include-content requires --repro-bundle');
  });
});

describe('kb remember', () => {
  it('creates a new markdown note from stdin with a slugified title', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-create-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'project'), { recursive: true });

      const r = runCli(
        ['remember', '--kb=project', '--title=Daily Meeting Notes', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '# Daily Meeting Notes\n\nDecision log.\n',
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"action": "create"');
      expect(r.stdout).toContain('"path": "daily-meeting-notes.md"');
      await expect(fsp.readFile(path.join(rootDir, 'project', 'daily-meeting-notes.md'), 'utf-8'))
        .resolves.toBe('# Daily Meeting Notes\n\nDecision log.\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing slug on create', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-overwrite-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'project'), { recursive: true });
      const notePath = path.join(rootDir, 'project', 'daily-meeting-notes.md');
      await fsp.writeFile(notePath, 'original', 'utf-8');

      const r = runCli(
        ['remember', '--kb=project', '--title=Daily Meeting Notes', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'replacement',
      );

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('refusing to overwrite');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe('original');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('appends stdin to an existing KB-relative note', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-append-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'notes', 'status.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(notePath, '# Status\n\nExisting.\n', 'utf-8');

      const r = runCli(
        ['remember', '--kb=project', '--append=notes/status.md', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '\nAppended.\n',
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"action": "append"');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe('# Status\n\nExisting.\n\nAppended.\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('suggests likely targets without reading stdin or writing note files', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-suggest-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(path.join(kbDir, 'research-plan.md'), '# Research Plan\n\nExisting note.\n', 'utf-8');

      const r = runCli(
        ['remember', '--suggest', '--kb=project', '--title=Research Plan'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Likely existing targets');
      expect(r.stdout).toContain('research-plan.md');
      await expect(fsp.access(path.join(kbDir, 'research-plan.md.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('caches suggest headings under the KB index directory', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-suggest-cache-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      const notePath = path.join(kbDir, 'planning.md');
      const cachePath = path.join(kbDir, '.index', 'remember-suggest-heading-cache.json');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(notePath, '# Research Plan\n\nExisting note.\n', 'utf-8');

      const r = runCli(
        ['remember', '--suggest', '--kb=project', '--title=Research Plan'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('planning.md');
      const cache = JSON.parse(await fsp.readFile(cachePath, 'utf-8'));
      expect(cache.schema_version).toBe('remember-suggest-heading-cache.v1');
      expect(cache.entries['planning.md'].firstHeading).toBe('Research Plan');
      expect(cache.entries['planning.md'].pathTokens).toEqual(['planning']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses a valid warm suggest heading cache without rereading note headings', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-suggest-warm-cache-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      const notePath = path.join(kbDir, 'planning.md');
      const cachePath = path.join(kbDir, '.index', 'remember-suggest-heading-cache.json');
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(notePath, '# Unrelated\n\nExisting note.\n', 'utf-8');
      const stat = await fsp.stat(notePath);
      await fsp.writeFile(cachePath, JSON.stringify({
        schema_version: 'remember-suggest-heading-cache.v1',
        entries: {
          'planning.md': {
            relativePath: 'planning.md',
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            firstHeading: 'Research Plan',
            pathTokens: ['planning'],
          },
        },
      }, null, 2), 'utf-8');

      const r = runCli(
        ['remember', '--suggest', '--kb=project', '--title=Research Plan'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('planning.md (heading: Research Plan)');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns and rebuilds when the suggest heading cache is corrupt', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-suggest-corrupt-cache-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(rootDir, 'project');
      const cachePath = path.join(kbDir, '.index', 'remember-suggest-heading-cache.json');
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(path.join(kbDir, 'research-plan.md'), '# Research Plan\n\nExisting note.\n', 'utf-8');
      await fsp.writeFile(cachePath, '{not json', 'utf-8');

      const r = runCli(
        ['remember', '--suggest', '--kb=project', '--title=Research Plan'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect(r.stderr).toContain('ignoring invalid suggest heading cache');
      expect(r.stdout).toContain('research-plan.md');
      const cache = JSON.parse(await fsp.readFile(cachePath, 'utf-8'));
      expect(cache.entries['research-plan.md'].firstHeading).toBe('Research Plan');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects traversal and absolute append paths before writing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-path-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'safe.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(notePath, 'safe', 'utf-8');

      const traversal = runCli(
        ['remember', '--kb=project', '--append=../outside.md', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'bad',
      );
      expect(traversal.code).toBe(1);
      expect(traversal.stderr).toContain('escapes KB root');

      const absolute = runCli(
        ['remember', '--kb=project', `--append=${path.join(tempDir, 'outside.md')}`, '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'bad',
      );
      expect(absolute.code).toBe(1);
      expect(absolute.stderr).toContain('escapes KB root');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe('safe');
      await expect(fsp.access(path.join(tempDir, 'outside.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('plain --append preserves file permissions while appending', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-append-mode-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'private.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(notePath, '# Private\n', 'utf-8');
      await fsp.chmod(notePath, 0o600);

      const r = runCli(
        ['remember', '--kb=project', '--append=private.md', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '\nAppended.\n',
      );

      expect(r.code).toBe(0);
      expect((await fsp.stat(notePath)).mode & 0o777).toBe(0o600);
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe('# Private\n\nAppended.\n');
    } finally {
      await fsp.chmod(path.join(tempDir, 'kbs', 'project', 'private.md'), 0o600).catch(() => {});
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('appends at the end of a named section, not at EOF', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'notes', 'flows.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(
        notePath,
        '# Top\n\n## OSS gate flow\n\nFirst note.\n\n### Sub\n\nSub note.\n\n## Cross-references\n\nLinks.\n',
        'utf-8',
      );

      const r = runCli(
        [
          'remember',
          '--kb=project',
          '--append=notes/flows.md',
          '--append-section=## OSS gate flow',
          '--stdin',
          '--yes',
        ],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'Newer note.\n',
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"action": "append-section"');
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toBe(
        '# Top\n\n## OSS gate flow\n\nFirst note.\n\n### Sub\n\nSub note.\n\nNewer note.\n\n## Cross-references\n\nLinks.\n',
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('errors when the named heading is missing without falling back to EOF', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-missing-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'notes.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      const original = '# Top\n\nbody\n';
      await fsp.writeFile(notePath, original, 'utf-8');

      const r = runCli(
        [
          'remember',
          '--kb=project',
          '--append=notes.md',
          '--append-section=## Nope',
          '--stdin',
          '--yes',
        ],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'should not land\n',
      );

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('heading not found');
      expect(r.stderr).toContain('Available headings');
      // The file must be byte-identical when the heading is missing.
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe(original);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not match a heading hidden inside a fenced code block', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-fence-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'fenced.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      const original = '# Real\n\n```\n## Trick\n```\n';
      await fsp.writeFile(notePath, original, 'utf-8');

      const r = runCli(
        ['remember', '--kb=project', '--append=fenced.md', '--append-section=## Trick', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'X',
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('heading not found');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe(original);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not accumulate blank lines on repeated --append-section writes', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-rep-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'rep.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(notePath, '## Foo\n\nbody\n\n## Bar\n\nbar\n', 'utf-8');

      for (const text of ['first', 'second', 'third']) {
        const r = runCli(
          ['remember', '--kb=project', '--append=rep.md', '--append-section=## Foo', '--stdin', '--yes'],
          { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
          text,
        );
        expect(r.code).toBe(0);
      }
      const after = await fsp.readFile(notePath, 'utf-8');
      // Single blank line separates each appended block — never two.
      expect(after).toBe(
        '## Foo\n\nbody\n\nfirst\n\nsecond\n\nthird\n\n## Bar\n\nbar\n',
      );
      expect(/\n\n\n/.test(after)).toBe(false);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects --append-section without --append', async () => {
    const r = runCli(
      ['remember', '--kb=project', '--append-section=## Foo', '--stdin', '--yes'],
      {},
      'x',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--append-section requires --append');
  });

  it('errors on duplicate headings without --occurrence and disambiguates with it', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-dup-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'dup.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(
        notePath,
        '## Foo\n\nfirst\n\n## Foo\n\nsecond\n',
        'utf-8',
      );

      const ambiguous = runCli(
        ['remember', '--kb=project', '--append=dup.md', '--append-section=## Foo', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'X',
      );
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toContain('appears 2 times');

      const second = runCli(
        [
          'remember',
          '--kb=project',
          '--append=dup.md',
          '--append-section=## Foo',
          '--occurrence=2',
          '--stdin',
          '--yes',
        ],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'Picked.\n',
      );
      expect(second.code).toBe(0);
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toBe('## Foo\n\nfirst\n\n## Foo\n\nsecond\n\nPicked.\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses empty stdin under --append-section', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-empty-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'a.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      const original = '## Foo\n\nbody\n';
      await fsp.writeFile(notePath, original, 'utf-8');

      const r = runCli(
        ['remember', '--kb=project', '--append=a.md', '--append-section=## Foo', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '   \n',
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('empty content');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe(original);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves frontmatter byte-identical when appending into a section', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-fm-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'fm.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(
        notePath,
        '---\ntitle: Notes\ntags: [a, b]\n---\n## Foo\n\nbody\n',
        'utf-8',
      );

      const r = runCli(
        ['remember', '--kb=project', '--append=fm.md', '--append-section=## Foo', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'Added.',
      );
      expect(r.code).toBe(0);
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toBe('---\ntitle: Notes\ntags: [a, b]\n---\n## Foo\n\nbody\n\nAdded.\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves target file permissions when appending into a section', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-section-mode-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const notePath = path.join(rootDir, 'project', 'private.md');
      await fsp.mkdir(path.dirname(notePath), { recursive: true });
      await fsp.writeFile(notePath, '## Private\n\nbody\n', 'utf-8');
      await fsp.chmod(notePath, 0o600);

      const r = runCli(
        ['remember', '--kb=project', '--append=private.md', '--append-section=## Private', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'Added.',
      );

      expect(r.code).toBe(0);
      expect((await fsp.stat(notePath)).mode & 0o777).toBe(0o600);
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe('## Private\n\nbody\n\nAdded.\n');
    } finally {
      await fsp.chmod(path.join(tempDir, 'kbs', 'project', 'private.md'), 0o600).catch(() => {});
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects write argv errors without touching stdin content', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-argv-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'project'), { recursive: true });

      const noYes = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'draft',
      );
      expect(noYes.code).toBe(2);
      expect(noYes.stderr).toContain('writes require --yes');

      const unknown = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes', '--bogus'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'draft',
      );
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain('unknown flag');
      await expect(fsp.access(path.join(rootDir, 'project', 'draft.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed similarity flags before reading stdin (exit 2)', () => {
    const cases: Array<{ flag: string; pattern: RegExp }> = [
      { flag: '--similar-threshold=0', pattern: /--similar-threshold must be a positive number/ },
      { flag: '--similar-threshold=abc', pattern: /--similar-threshold must be a positive number/ },
      { flag: '--similar-k=0', pattern: /--similar-k must be a positive integer/ },
      { flag: '--similar-k=2.5', pattern: /--similar-k must be a positive integer/ },
      { flag: '--format=yaml', pattern: /--format must be md or json/ },
    ];
    for (const { flag, pattern } of cases) {
      const r = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes', flag],
        {},
        'draft',
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(pattern);
    }
  });

  it('--force together with --no-check-similar is rejected (force has no guard to override)', () => {
    // The guard is on by default, so a bare --force is meaningful. Only the
    // explicit "guard off + force on" combo is incoherent — it would mask
    // an agent typo where the user thought --force enabled the guard.
    const r = runCli(
      ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes', '--no-check-similar', '--force'],
      {},
      'draft',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--force has no effect without --check-similar');
  });

  it('--check-similar (explicit) with no model registered exits 2 with an actionable hint', async () => {
    // Strict mode: the user asked for the guard by name, so an unconfigured
    // index must surface as a hard error (NFR-004). The write must NOT
    // happen — the preflight runs before the create branch.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-checksim-nomodel-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'project'), { recursive: true });

      const r = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes', '--check-similar'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'this content should never reach the filesystem',
      );

      expect(r.code).toBe(2);
      await expect(fsp.access(path.join(rootDir, 'project', 'draft.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('default-on guard with no model registered degrades to a warning and writes anyway', async () => {
    // Implicit guard fires by default but a fresh install has no model
    // registered. We must NOT block writes for a config issue the user
    // didn't gate on the guard — emit a one-line stderr warning and
    // proceed. NFR-004 strict path is preserved under explicit --check-similar.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-default-degrade-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'project'), { recursive: true });

      const r = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'fresh install body',
      );

      expect(r.code).toBe(0);
      expect(r.stderr).toContain('similarity guard skipped');
      expect(r.stderr).toContain('--no-check-similar');
      expect(r.stdout).toContain('"action": "create"');
      await expect(fsp.readFile(path.join(rootDir, 'project', 'draft.md'), 'utf-8'))
        .resolves.toBe('fresh install body');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--no-check-similar bypasses the guard silently with no warning', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-no-check-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'project'), { recursive: true });

      const r = runCli(
        ['remember', '--kb=project', '--title=Draft', '--stdin', '--yes', '--no-check-similar'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        'silent path',
      );

      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('"action": "create"');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson writes to agent-task-lessons by default and tags the JSON summary', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-default-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      // Note: agent-task-lessons KB does NOT exist yet — --lesson must
      // auto-create it so agents don't need a separate mkdir step.
      await fsp.mkdir(rootDir, { recursive: true });

      const body =
        '## Mistake\n\nForgot to recheck PR state.\n\n' +
        '## Why it happened\n\nAssumed CI was green.\n\n' +
        '## Better next time\n\nAlways re-fetch PR state.\n';

      const r = runCli(
        ['remember', '--lesson', '--title=Recheck PR state before follow-up pushes', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        body,
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"knowledge_base_name": "agent-task-lessons"');
      expect(r.stdout).toContain('"action": "create"');
      expect(r.stdout).toContain('"lesson": true');
      expect(r.stdout).toContain('"write_performed": true');
      const written = await fsp.readFile(
        path.join(rootDir, 'agent-task-lessons', 'recheck-pr-state-before-follow-up-pushes.md'),
        'utf-8',
      );
      expect(written).toBe(body);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson respects an explicit --kb override', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-kb-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(path.join(rootDir, 'team-lessons'), { recursive: true });

      const body =
        '## Mistake\n\nA.\n\n## Why it happened\n\nB.\n\n## Better next time\n\nC.\n';

      const r = runCli(
        ['remember', '--lesson', '--kb=team-lessons', '--title=Pick canary regions', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        body,
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"knowledge_base_name": "team-lessons"');
      await expect(fsp.access(path.join(rootDir, 'team-lessons', 'pick-canary-regions.md'))).resolves.toBeUndefined();
      // Default lesson KB must NOT be created when the caller named another.
      await expect(fsp.access(path.join(rootDir, 'agent-task-lessons')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson with empty stdin emits a JSON skeleton and exits 2 without writing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-empty-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });

      const r = runCli(
        ['remember', '--lesson', '--title=Anything', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '   \n  \n',
      );

      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed.action).toBe('lesson-validation');
      expect(parsed.write_performed).toBe(false);
      expect(parsed.empty_input).toBe(true);
      expect(parsed.missing_sections).toEqual(['Mistake', 'Why it happened', 'Better next time']);
      expect(parsed.skeleton).toContain('## Mistake');
      expect(parsed.skeleton).toContain('## Why it happened');
      expect(parsed.skeleton).toContain('## Better next time');
      // No note must land on disk.
      await expect(fsp.access(path.join(rootDir, 'agent-task-lessons', 'anything.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson lists missing sections when only some are present', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-partial-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });

      // Only "Mistake" is present; the other two are missing.
      const body = '## Mistake\n\nForgot the thing.\n\n## Notes\n\nMisc.\n';

      const r = runCli(
        ['remember', '--lesson', '--title=Partial', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        body,
      );

      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed.action).toBe('lesson-validation');
      expect(parsed.empty_input).toBe(false);
      expect(parsed.missing_sections).toEqual(['Why it happened', 'Better next time']);
      expect(parsed.found_sections).toEqual(['Mistake']);
      await expect(fsp.access(path.join(rootDir, 'agent-task-lessons', 'partial.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson validation tolerates trailing punctuation and the "Mistakes" plural', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-aliases-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });

      const body =
        '## Mistakes:\n\nA.\n\n' +
        '## why it happened\n\nB.\n\n' +
        '## Better next time.\n\nC.\n';

      const r = runCli(
        ['remember', '--lesson', '--title=Tolerant', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        body,
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"action": "create"');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson rejects required-section headings at the wrong level (H1 / H3)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-level-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });

      // All three required headings exist textually but at the wrong level.
      // The skeleton, docs, and downstream tooling all agree on H2 — anything
      // else must NOT count toward the validator's required-sections set.
      const body =
        '# Mistake\n\nA.\n\n' +
        '### Why it happened\n\nB.\n\n' +
        '#### Better next time\n\nC.\n';

      const r = runCli(
        ['remember', '--lesson', '--title=Wrong-level', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        body,
      );

      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed.action).toBe('lesson-validation');
      expect(parsed.missing_sections).toEqual(['Mistake', 'Why it happened', 'Better next time']);
      expect(parsed.found_sections).toEqual([]);
      await expect(fsp.access(path.join(rootDir, 'agent-task-lessons', 'wrong-level.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson does not match a heading hidden inside a fenced code block', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-fence-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });

      // The "Mistake" heading lives inside a code fence — must NOT count
      // toward the required-sections check.
      const body =
        '## Why it happened\n\nB.\n\n' +
        '## Better next time\n\nC.\n\n' +
        '```\n## Mistake\n```\n';

      const r = runCli(
        ['remember', '--lesson', '--title=Fenced', '--stdin', '--yes'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        body,
      );

      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed.missing_sections).toEqual(['Mistake']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson with --format=md prints a human-readable skeleton on validation failure', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remember-lesson-md-'));
    try {
      const rootDir = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(rootDir, { recursive: true });

      const r = runCli(
        ['remember', '--lesson', '--title=Anything', '--stdin', '--yes', '--format=md'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
        '',
      );

      expect(r.code).toBe(2);
      expect(r.stdout).toContain('kb remember --lesson');
      expect(r.stdout).toContain('## Mistake');
      expect(r.stdout).toContain('## Why it happened');
      expect(r.stdout).toContain('## Better next time');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--lesson rejects --append (lessons are create-only)', async () => {
    const r = runCli(
      ['remember', '--lesson', '--append=foo.md', '--stdin', '--yes'],
      {},
      'body',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--lesson is for new lesson notes');
  });
});

describe('kb capture', () => {
  async function makeKb(prefix: string): Promise<{ tempDir: string; rootDir: string; faissDir: string; notePath: string }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const rootDir = path.join(tempDir, 'kbs');
    const faissDir = path.join(tempDir, '.faiss');
    const notePath = path.join(rootDir, 'project', 'snapshots.md');
    await fsp.mkdir(path.dirname(notePath), { recursive: true });
    await fsp.writeFile(notePath, '# Snapshots\n', 'utf-8');
    return { tempDir, rootDir, faissDir, notePath };
  }

  it('appends a fenced block with $ command line and note header', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-basic-');
    try {
      const r = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--note=Snapshot 1', '--', 'echo', 'hello'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"action": "capture"');
      expect(r.stdout).toContain('"truncated": false');
      expect(r.stdout).toContain('"path": "snapshots.md"');
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toBe(
        '# Snapshots\n' +
        '\n' +
        '### Snapshot 1\n' +
        '\n' +
        '$ echo hello\n' +
        '```\n' +
        'hello\n' +
        '```\n',
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves target file permissions when appending captured output', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-mode-');
    try {
      await fsp.chmod(notePath, 0o600);

      const r = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--', 'echo', 'private'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect((await fsp.stat(notePath)).mode & 0o777).toBe(0o600);
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toContain('private\n');
    } finally {
      await fsp.chmod(notePath, 0o600).catch(() => {});
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('auto-detects json language hint from a .json positional arg', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-lang-');
    try {
      const dataPath = path.join(tempDir, 'data.json');
      await fsp.writeFile(dataPath, '{"k":1}\n', 'utf-8');

      const r = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--', 'cat', dataPath],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toContain('```json\n');
      expect(after).toContain('{"k":1}');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('escapes backticks in stdout by widening the fence', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-fence-');
    try {
      const r = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--', 'printf', '```inner```\n'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toContain('\n````\n```inner```\n````\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('truncates at --max-bytes and records the elision count', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-trunc-');
    try {
      const r = runCli(
        [
          'capture', '--kb=project', '--append=snapshots.md', '--max-bytes=4',
          '--', 'printf', 'abcdefghij',
        ],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"truncated": true');
      expect(r.stdout).toContain('"bytes_elided": 6');
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toContain('abcd\n... (truncated, 6 bytes elided)\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses non-zero exit unless --allow-fail is passed', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-fail-');
    try {
      const before = await fsp.readFile(notePath, 'utf-8');
      const fail = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--', 'sh', '-c', 'echo hi; exit 3'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );
      expect(fail.code).toBe(1);
      expect(fail.stderr).toContain('command exited 3');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe(before);

      const allow = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--allow-fail', '--', 'sh', '-c', 'echo hi; exit 3'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );
      expect(allow.code).toBe(0);
      expect(allow.stdout).toContain('"exit_code": 3');
      const after = await fsp.readFile(notePath, 'utf-8');
      expect(after).toContain('hi');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to write an empty fence when stdout is empty', async () => {
    const { tempDir, rootDir, faissDir, notePath } = await makeKb('kb-cli-capture-empty-');
    try {
      const before = await fsp.readFile(notePath, 'utf-8');
      const r = runCli(
        ['capture', '--kb=project', '--append=snapshots.md', '--', 'true'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('produced no stdout');
      await expect(fsp.readFile(notePath, 'utf-8')).resolves.toBe(before);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects traversal in --append before spawning the command', async () => {
    const { tempDir, rootDir, faissDir } = await makeKb('kb-cli-capture-path-');
    try {
      const r = runCli(
        ['capture', '--kb=project', '--append=../outside.md', '--', 'printf', 'x'],
        { KNOWLEDGE_BASES_ROOT_DIR: rootDir, FAISS_INDEX_PATH: faissDir },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('escapes KB root');
      await expect(fsp.access(path.join(tempDir, 'outside.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects argv errors (missing --kb / missing command after --)', async () => {
    const noKb = runCli(['capture', '--append=snapshots.md', '--', 'printf', 'x']);
    expect(noKb.code).toBe(2);
    expect(noKb.stderr).toContain('missing --kb');

    const noCmd = runCli(['capture', '--kb=project', '--append=snapshots.md']);
    expect(noCmd.code).toBe(2);
    expect(noCmd.stderr).toContain('missing command after "--"');

    const badMax = runCli(['capture', '--kb=project', '--append=snapshots.md', '--max-bytes=abc', '--', 'printf', 'x']);
    expect(badMax.code).toBe(2);
    expect(badMax.stderr).toContain('invalid --max-bytes');
  });
});

describe('kb list', () => {
  it('returns KB names one per line, dot-prefixed entries filtered', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-list-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'engineering'));
      await fsp.mkdir(path.join(tempDir, 'personal'));
      await fsp.mkdir(path.join(tempDir, '.faiss'));

      const r = runCli(['list'], {
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });
      expect(r.code).toBe(0);
      const names = r.stdout.trim().split('\n').sort();
      expect(names).toEqual(['engineering', 'personal']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns 1 when KNOWLEDGE_BASES_ROOT_DIR does not exist', () => {
    const r = runCli(['list'], {
      KNOWLEDGE_BASES_ROOT_DIR: '/nonexistent/kb/dir/never/exists',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kb list:');
  });
});

describe('kb list --describe (#140)', () => {
  it('prints two-column name + heading description from README.md', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-list-describe-'));
    try {
      const eng = path.join(tempDir, 'engineering');
      const personal = path.join(tempDir, 'personal');
      await fsp.mkdir(eng);
      await fsp.mkdir(personal);
      await fsp.writeFile(
        path.join(eng, 'README.md'),
        '# Engineering notes\n\nlonger details below\n',
      );
      // personal: no README — should print the bare name with no trailing space.

      const r = runCli(['list', '--describe'], {
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });

      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split('\n').sort();
      expect(lines).toHaveLength(2);
      const engLine = lines.find((l) => l.startsWith('engineering'));
      const personalLine = lines.find((l) => l.startsWith('personal'));
      expect(engLine).toMatch(/^engineering\s{3,}Engineering notes$/);
      expect(personalLine).toBe('personal');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('-v is an alias for --describe', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-list-v-'));
    try {
      const kb = path.join(tempDir, 'k');
      await fsp.mkdir(kb);
      await fsp.writeFile(path.join(kb, 'README.md'), '# only-kb\n');

      const r = runCli(['list', '-v'], {
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('only-kb');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--format=json --describe emits an array of {name, description}', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-list-json-'));
    try {
      const eng = path.join(tempDir, 'engineering');
      const personal = path.join(tempDir, 'personal');
      await fsp.mkdir(eng);
      await fsp.mkdir(personal);
      await fsp.writeFile(path.join(eng, 'README.md'), '# Engineering notes\n');

      const r = runCli(['list', '--describe', '--format=json'], {
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });

      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as Array<{ name: string; description: string }>;
      const byName = new Map(parsed.map((item) => [item.name, item.description]));
      expect(byName.get('engineering')).toBe('Engineering notes');
      expect(byName.get('personal')).toBe('');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('--format=json without --describe emits {name}-only objects', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-list-json-namesonly-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'a'));

      const r = runCli(['list', '--format=json'], {
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });

      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({ name: 'a' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown options with exit code 2', () => {
    const r = runCli(['list', '--bogus'], {
      KNOWLEDGE_BASES_ROOT_DIR: '/tmp',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option '--bogus'");
  });

  it('rejects invalid --format values with exit code 2', () => {
    const r = runCli(['list', '--format=xml'], {
      KNOWLEDGE_BASES_ROOT_DIR: '/tmp',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid --format');
  });

  it('plain `kb list` is unchanged (one bare name per line, no description)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-list-plain-'));
    try {
      const eng = path.join(tempDir, 'engineering');
      await fsp.mkdir(eng);
      await fsp.writeFile(path.join(eng, 'README.md'), '# would-be-description\n');

      const r = runCli(['list'], {
        KNOWLEDGE_BASES_ROOT_DIR: tempDir,
        FAISS_INDEX_PATH: path.join(tempDir, '.faiss'),
      });

      expect(r.code).toBe(0);
      expect(r.stdout.trimEnd().split('\n')).toEqual(['engineering']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('kb search — active-model resolution (RFC 013 §4.7)', () => {
  // RFC 013 supersedes the RFC-012 §4.7 model-mismatch check: each model lives
  // in its own ${PATH}/models/<id>/ subdir, so env-vs-active divergence no
  // longer collapses two models into one vector space. The new failure mode
  // is "no model registered" — CLI exits 2 with an explicit hint.

  it('exits 2 with "No model registered" when FAISS_INDEX_PATH has no models/', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-noreg-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(kbDir);

      const r = runCli(['search', 'hello'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('No model registered');
      expect(r.stderr).toContain('kb models add');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --model=<id> names a non-registered model', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-badmodel-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      // Seed a registered model so the env-derived path works,
      // but pass --model=<other> that isn't on disk.
      const realId = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(faissDir, 'models', realId), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', realId, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
      await fsp.writeFile(path.join(faissDir, 'active.txt'), realId);
      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(kbDir);

      const r = runCli(['search', 'hello', '--model=ollama__not-registered'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('not registered');
      expect(r.stderr).toContain('ollama__not-registered');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models list shows "(no models registered)" when models/ is empty', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-models-empty-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      const r = runCli(['models', 'list'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('(no models registered');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models list shows registered models with active marker', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-models-list-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const id = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
      await fsp.writeFile(path.join(faissDir, 'active.txt'), id);

      const r = runCli(['models', 'list'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(id);
      expect(r.stdout).toContain('huggingface');
      expect(r.stdout).toContain('BAAI/bge-small-en-v1.5');
      // Active marker (leading *).
      expect(r.stdout).toMatch(/\*\s+huggingface__/);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models add exits 2 in non-TTY context without --yes (round-1 failure F9)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-add-noyes-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(path.join(kbDir, 'sample'), { recursive: true });
      await fsp.writeFile(path.join(kbDir, 'sample', 'doc.md'), '# t\n\nbody');

      // spawnSync inherits a non-TTY stdin by default — perfect.
      const r = runCli(['models', 'add', 'ollama', 'nomic-embed-text'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('not a TTY');
      expect(r.stderr).toContain('--yes');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models add --dry-run prints estimate without writing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-add-dryrun-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(path.join(kbDir, 'sample'), { recursive: true });
      await fsp.writeFile(path.join(kbDir, 'sample', 'doc.md'), '# t\n\nbody');

      const r = runCli(['models', 'add', 'ollama', 'nomic-embed-text', '--dry-run'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('Adding model: ollama__nomic-embed-text');
      expect(r.stderr).toContain('Will embed:');
      expect(r.stderr).toContain('--dry-run');
      // No directory created.
      await expect(fsp.access(path.join(faissDir, 'models'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models add blocks while a live .adding writer PID still exists', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-add-live-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(tempDir, 'kb');
      const id = 'ollama__nomic-embed-text';
      await fsp.mkdir(path.join(kbDir, 'sample'), { recursive: true });
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, '.adding'), `${process.pid}\n`);

      const r = runCli(['models', 'add', 'ollama', 'nomic-embed-text', '--dry-run'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('already being added');
      expect(r.stderr).toContain(`pid ${process.pid}`);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models add reports stale .adding sentinels but requires --recover and --yes before cleanup', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-add-stale-gate-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(tempDir, 'kb');
      const id = 'ollama__nomic-embed-text';
      await fsp.mkdir(path.join(kbDir, 'sample'), { recursive: true });
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, '.adding'), '999999999\n');

      const withoutRecover = runCli(['models', 'add', 'ollama', 'nomic-embed-text', '--yes'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(withoutRecover.code).toBe(2);
      expect(withoutRecover.stderr).toContain('stale/interrupted');
      expect(withoutRecover.stderr).toContain('--recover --yes');

      const withoutYes = runCli(['models', 'add', 'ollama', 'nomic-embed-text', '--recover'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(withoutYes.code).toBe(2);
      expect(withoutYes.stderr).toContain('Pass both --recover and --yes');
      await expect(fsp.access(path.join(faissDir, 'models', id, '.adding'))).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models add refuses --recover for malformed .adding sentinels', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-add-malformed-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(tempDir, 'kb');
      const id = 'ollama__nomic-embed-text';
      await fsp.mkdir(path.join(kbDir, 'sample'), { recursive: true });
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, '.adding'), '{not-json');

      const r = runCli(['models', 'add', 'ollama', 'nomic-embed-text', '--recover', '--yes'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('cannot be recovered automatically');
      await expect(fsp.readFile(path.join(faissDir, 'models', id, '.adding'), 'utf-8'))
        .resolves.toBe('{not-json');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models add --recover --yes deletes a stale incomplete dir before retrying', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-add-recover-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const kbDir = path.join(tempDir, 'kb');
      const id = 'ollama__nomic-embed-text';
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, '.adding'), JSON.stringify({
        schema_version: 'kb.model-adding.v1',
        model_id: id,
        provider: 'ollama',
        model_name: 'nomic-embed-text',
        pid: 999999999,
        started_at: '2026-05-11T10:00:00.000Z',
      }));
      await fsp.writeFile(path.join(faissDir, 'models', id, 'old-partial-file'), 'old');

      const r = runCli(['models', 'add', 'ollama', 'nomic-embed-text', '--recover', '--yes'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_MODEL: 'nomic-embed-text',
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('Recovered stale incomplete model');
      expect(r.stderr).toContain(`Successfully added ${id}`);
      await expect(fsp.access(path.join(faissDir, 'models', id, 'old-partial-file')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.access(path.join(faissDir, 'models', id, '.adding')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.readFile(path.join(faissDir, 'models', id, 'model_name.txt'), 'utf-8'))
        .resolves.toBe('nomic-embed-text');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models set-active exits 2 for non-registered model_id', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-setactive-bad-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      const r = runCli(['models', 'set-active', 'ollama__not-registered'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('not registered');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models set-active updates active.txt for a registered model', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-setactive-ok-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const idA = 'huggingface__BAAI-bge-small-en-v1.5';
      const idB = 'ollama__nomic-embed-text-latest';
      for (const [id, name] of [[idA, 'BAAI/bge-small-en-v1.5'], [idB, 'nomic-embed-text:latest']] as const) {
        await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
        await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), name);
      }
      await fsp.writeFile(path.join(faissDir, 'active.txt'), idA);

      const r = runCli(['models', 'set-active', idB], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(0);
      expect((await fsp.readFile(path.join(faissDir, 'active.txt'), 'utf-8')).trim()).toBe(idB);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models remove refuses to remove the active model', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remove-active-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const id = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
      await fsp.writeFile(path.join(faissDir, 'active.txt'), id);

      const r = runCli(['models', 'remove', id, '--yes'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('refusing to remove the active model');
      // Directory still on disk AND its model_name.txt is byte-identical —
      // a regression that "refused" but partially wiped state would pass
      // the bare existence check; insist on full preservation.
      expect((await fsp.stat(path.join(faissDir, 'models', id))).isDirectory()).toBe(true);
      expect(
        await fsp.readFile(path.join(faissDir, 'models', id, 'model_name.txt'), 'utf-8'),
      ).toBe('BAAI/bge-small-en-v1.5');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb models remove --yes deletes a non-active registered model', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-remove-ok-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const idA = 'huggingface__BAAI-bge-small-en-v1.5';
      const idB = 'ollama__nomic-embed-text-latest';
      for (const [id, name] of [[idA, 'BAAI/bge-small-en-v1.5'], [idB, 'nomic-embed-text:latest']] as const) {
        await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
        await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), name);
      }
      await fsp.writeFile(path.join(faissDir, 'active.txt'), idA);

      const r = runCli(['models', 'remove', idB, '--yes'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(0);
      await expect(fsp.access(path.join(faissDir, 'models', idB))).rejects.toMatchObject({ code: 'ENOENT' });
      // Active model untouched.
      await expect(fsp.access(path.join(faissDir, 'models', idA))).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb compare exits 2 when model_a == model_b after resolution', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-compare-same-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const id = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(faissDir, 'models', id), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', id, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
      await fsp.writeFile(path.join(faissDir, 'active.txt'), id);

      const r = runCli(['compare', 'hello', id, id], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('resolve to the same id');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb compare exits 2 when one of the models is not registered', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-compare-bad-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      const idA = 'huggingface__BAAI-bge-small-en-v1.5';
      await fsp.mkdir(path.join(faissDir, 'models', idA), { recursive: true });
      await fsp.writeFile(path.join(faissDir, 'models', idA, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');
      await fsp.writeFile(path.join(faissDir, 'active.txt'), idA);

      const r = runCli(['compare', 'hello', idA, 'ollama__not-registered'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('not registered');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('kb compare argv parse: missing positionals exits 2', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-compare-argv-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      const r = runCli(['compare', 'only-one'], {
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tempDir, 'kb'),
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('expected <query> <model_a> <model_b>');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('migrates a 0.2.x layout (model_name.txt + faiss.index dir) on first kb invocation', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-migrate-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      // Seed a 0.2.x layout: ${faissDir}/faiss.index/{...} + ${faissDir}/model_name.txt.
      const oldIndexDir = path.join(faissDir, 'faiss.index');
      await fsp.mkdir(oldIndexDir, { recursive: true });
      await fsp.writeFile(path.join(oldIndexDir, 'faiss.index'), 'old-bytes');
      await fsp.writeFile(path.join(oldIndexDir, 'docstore.json'), '{"doc":"old"}');
      await fsp.writeFile(path.join(faissDir, 'model_name.txt'), 'BAAI/bge-small-en-v1.5');

      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(kbDir);

      // `kb models list` triggers bootstrapLayout but does NOT load FaissStore
      // (which would fail on the test's fake "old-bytes" content and run the
      // corrupt-recovery wipe). This isolates migration assertions.
      const r = runCli(['models', 'list'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(0);

      // Old layout migrated. The migrated `faiss.index` must be a directory
      // (the modern langchain layout — turning it into a regular file would
      // break load on the next start, but pass a bare existence check).
      const migratedId = 'huggingface__BAAI-bge-small-en-v1.5';
      const migratedIndexDir = path.join(faissDir, 'models', migratedId, 'faiss.index');
      expect((await fsp.stat(migratedIndexDir)).isDirectory()).toBe(true);
      expect(await fsp.readFile(path.join(migratedIndexDir, 'faiss.index'), 'utf-8')).toBe('old-bytes');
      expect(await fsp.readFile(path.join(migratedIndexDir, 'docstore.json'), 'utf-8')).toBe('{"doc":"old"}');
      expect((await fsp.readFile(path.join(faissDir, 'active.txt'), 'utf-8')).trim()).toBe(migratedId);
      // model_name.txt moved into models/<id>/.
      expect(await fsp.readFile(path.join(faissDir, 'models', migratedId, 'model_name.txt'), 'utf-8'))
        .toBe('BAAI/bge-small-en-v1.5');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
