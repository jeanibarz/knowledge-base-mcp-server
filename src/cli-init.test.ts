import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { INIT_HELP, runInit } from './cli-init.js';
import { KBError } from './errors.js';
import {
  KnowledgeBaseExistsError,
  createKnowledgeBase,
  resolveKbPath,
  resolveKnowledgeBaseDir,
} from './kb-fs.js';

// ---------------------------------------------------------------------------
// Unit tests for the createKnowledgeBase filesystem helper (issue #884).
// These exercise the traversal-safe guards and the no-clobber contract
// directly, without going through the built CLI.
// ---------------------------------------------------------------------------

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-init-'));
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe('createKnowledgeBase', () => {
  it('creates a directory that resolveKnowledgeBaseDir can then address', async () => {
    await withTempRoot(async (root) => {
      const kbDir = await createKnowledgeBase(root, 'new-topic');
      expect(kbDir).toBe(path.join(root, 'new-topic'));
      const stat = await fsp.stat(kbDir);
      expect(stat.isDirectory()).toBe(true);
      // The freshly created shelf is immediately resolvable by the read/write
      // surfaces' shared resolver.
      await expect(resolveKnowledgeBaseDir(root, 'new-topic')).resolves.toBe(kbDir);
    });
  });

  it('leaves the new shelf empty (no auto-index, no README)', async () => {
    await withTempRoot(async (root) => {
      const kbDir = await createKnowledgeBase(root, 'empty-shelf');
      expect(await fsp.readdir(kbDir)).toEqual([]);
    });
  });

  it('makes the shelf writable via the may-not-exist path resolver', async () => {
    await withTempRoot(async (root) => {
      await createKnowledgeBase(root, 'writable');
      // add_document / kb remember resolve write targets with mustExist:false;
      // a brand-new file path inside the created shelf must resolve cleanly.
      await expect(
        resolveKbPath(root, 'writable', 'note.md', { mustExist: false }),
      ).resolves.toBe(path.join(root, 'writable', 'note.md'));
    });
  });

  it('creates the KB root on demand when it does not exist yet', async () => {
    await withTempRoot(async (root) => {
      const missingRoot = path.join(root, 'does-not-exist-yet');
      const kbDir = await createKnowledgeBase(missingRoot, 'first');
      expect(kbDir).toBe(path.join(missingRoot, 'first'));
      expect((await fsp.stat(kbDir)).isDirectory()).toBe(true);
    });
  });

  it('rejects an already-existing name with KnowledgeBaseExistsError (no clobber)', async () => {
    await withTempRoot(async (root) => {
      await createKnowledgeBase(root, 'dup');
      await fsp.writeFile(path.join(root, 'dup', 'keep.md'), 'existing content');

      await expect(createKnowledgeBase(root, 'dup')).rejects.toBeInstanceOf(
        KnowledgeBaseExistsError,
      );
      // The pre-existing file must be untouched.
      expect(await fsp.readFile(path.join(root, 'dup', 'keep.md'), 'utf-8')).toBe(
        'existing content',
      );
    });
  });

  it('rejects a name colliding with an existing file', async () => {
    await withTempRoot(async (root) => {
      await fsp.writeFile(path.join(root, 'taken'), '');
      await expect(createKnowledgeBase(root, 'taken')).rejects.toBeInstanceOf(
        KnowledgeBaseExistsError,
      );
    });
  });

  it.each([
    ['empty', ''],
    ['dot-prefixed', '.hidden'],
    ['forward-slash traversal', '../escape'],
    ['nested path', 'a/b'],
    ['backslash separator', 'a\\b'],
    // On POSIX an absolute path always contains '/', so hasPathSeparator
    // rejects it first; the path.isAbsolute guard is belt-and-suspenders.
    ['absolute path', path.resolve(os.tmpdir(), 'abs')],
    ['null byte', 'bad\0name'],
  ])('rejects the unsafe name (%s) with a VALIDATION error', async (_label, name) => {
    await withTempRoot(async (root) => {
      const pending = createKnowledgeBase(root, name);
      await expect(pending).rejects.toBeInstanceOf(KBError);
      await expect(pending).rejects.toMatchObject({ code: 'VALIDATION' });
      // Nothing unsafe should have been created under the root.
      const entries = await fsp.readdir(root);
      expect(entries).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end tests against the built CLI: verify command wiring, exit codes,
// and that a created shelf is immediately writable by `kb remember`.
// ---------------------------------------------------------------------------

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

function runCli(
  args: string[],
  env: Record<string, string>,
  input?: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? '', KB_LOG_FORMAT: 'text', ...env },
    encoding: 'utf-8',
    input,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('kb init (CLI)', () => {
  it('creates a shelf that kb remember can immediately write into', async () => {
    await withTempRoot(async (root) => {
      const env = { KNOWLEDGE_BASES_ROOT_DIR: root };

      const init = runCli(['init', 'topic'], env);
      expect(init.stderr).toBe('');
      expect(init.code).toBe(0);
      expect(init.stdout).toContain(path.join(root, 'topic'));

      // The new shelf shows up in `kb list`.
      const list = runCli(['list'], env);
      expect(list.code).toBe(0);
      expect(list.stdout.split('\n')).toContain('topic');

      // ...and accepts a write straight away.
      const remember = runCli(
        ['remember', '--kb=topic', '--title=Hello', '--stdin', '--yes', '--no-check-similar'],
        env,
        '# Hello\n\nbody\n',
      );
      expect(remember.code).toBe(0);
      expect((await fsp.stat(path.join(root, 'topic', 'hello.md'))).isFile()).toBe(true);
    });
  });

  it('prints a JSON summary with --format=json', async () => {
    await withTempRoot(async (root) => {
      const init = runCli(['init', 'jsonkb', '--format=json'], { KNOWLEDGE_BASES_ROOT_DIR: root });
      expect(init.code).toBe(0);
      const payload = JSON.parse(init.stdout);
      expect(payload).toEqual({
        knowledge_base_name: 'jsonkb',
        path: path.join(root, 'jsonkb'),
        created: true,
      });
    });
  });

  it('errors clearly (exit 1) when the shelf already exists', async () => {
    await withTempRoot(async (root) => {
      const env = { KNOWLEDGE_BASES_ROOT_DIR: root };
      expect(runCli(['init', 'dup'], env).code).toBe(0);
      const again = runCli(['init', 'dup'], env);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain('already exists');
    });
  });

  it('rejects an unsafe (traversal) name with exit 2', async () => {
    await withTempRoot(async (root) => {
      const res = runCli(['init', '../escape'], { KNOWLEDGE_BASES_ROOT_DIR: root });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('Invalid knowledge base name');
      // No directory escaped the root.
      expect(await fsp.readdir(root)).toEqual([]);
    });
  });

  it('exits 2 when no name is given', async () => {
    await withTempRoot(async (root) => {
      const res = runCli(['init'], { KNOWLEDGE_BASES_ROOT_DIR: root });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('missing <name>');
    });
  });

  it('exits 2 for an invalid --format value', async () => {
    await withTempRoot(async (root) => {
      const res = runCli(['init', 'topic', '--format=xml'], { KNOWLEDGE_BASES_ROOT_DIR: root });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('invalid --format');
      // The bad flag must be rejected before anything is created.
      expect(await fsp.readdir(root)).toEqual([]);
    });
  });

  it('exits 2 when a second positional argument is given', async () => {
    await withTempRoot(async (root) => {
      const res = runCli(['init', 'one', 'two'], { KNOWLEDGE_BASES_ROOT_DIR: root });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('unexpected argument');
      expect(await fsp.readdir(root)).toEqual([]);
    });
  });
});

// In-process coverage of runInit's argv-parse branch (returns before any
// filesystem mutation, so it is safe to call against the real root).
describe('runInit (in-process)', () => {
  it('help text advertises the command and usage', () => {
    expect(INIT_HELP).toContain('kb init');
    expect(INIT_HELP).toContain('Usage:');
  });

  it('returns exit 2 for an unknown flag', async () => {
    await expect(runInit(['--nope'])).resolves.toBe(2);
  });

  it('returns exit 2 when no name is given', async () => {
    await expect(runInit([])).resolves.toBe(2);
  });
});
