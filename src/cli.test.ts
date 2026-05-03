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
    env: { PATH: process.env.PATH ?? '', ...env },
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
  it('--help exits 0 with usage text', () => {
    const r = runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kb — knowledge-base CLI');
    expect(r.stdout).toContain('kb list');
    expect(r.stdout).toContain('kb search');
    expect(r.stdout).toContain('kb remember');
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

  it('suggests likely targets without reading stdin or writing files', async () => {
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
      // Directory still on disk.
      await expect(fsp.stat(path.join(faissDir, 'models', id))).resolves.toBeDefined();
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

      // Old layout migrated.
      const migratedId = 'huggingface__BAAI-bge-small-en-v1.5';
      await expect(fsp.stat(path.join(faissDir, 'models', migratedId, 'faiss.index'))).resolves.toBeDefined();
      expect((await fsp.readFile(path.join(faissDir, 'active.txt'), 'utf-8')).trim()).toBe(migratedId);
      // model_name.txt moved into models/<id>/.
      expect(await fsp.readFile(path.join(faissDir, 'models', migratedId, 'model_name.txt'), 'utf-8'))
        .toBe('BAAI/bge-small-en-v1.5');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
