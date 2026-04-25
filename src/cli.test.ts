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

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync('node', [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf-8',
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

describe('kb search — model-mismatch check (RFC §4.7)', () => {
  it('exits 2 with clear stderr when index was built with a different model', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-mismatch-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      // Seed model_name.txt with a different model than what the CLI
      // would configure for huggingface defaults (BAAI/bge-small-en-v1.5).
      await fsp.writeFile(
        path.join(faissDir, 'model_name.txt'),
        'sentence-transformers/all-MiniLM-L6-v2',
      );
      // Also need a KB so the rest of the path works.
      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(kbDir);

      const r = runCli(['search', 'hello'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Embedding model mismatch');
      expect(r.stderr).toContain('sentence-transformers/all-MiniLM-L6-v2');
      expect(r.stderr).toContain('BAAI/bge-small-en-v1.5');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('emits warning but proceeds with --refresh on model mismatch', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-mismatch-refresh-'));
    try {
      const faissDir = path.join(tempDir, '.faiss');
      await fsp.mkdir(faissDir, { recursive: true });
      await fsp.writeFile(
        path.join(faissDir, 'model_name.txt'),
        'sentence-transformers/all-MiniLM-L6-v2',
      );
      const kbDir = path.join(tempDir, 'kb');
      await fsp.mkdir(kbDir);

      const r = runCli(['search', 'hello', '--refresh'], {
        KNOWLEDGE_BASES_ROOT_DIR: kbDir,
        FAISS_INDEX_PATH: faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_API_KEY: 'test-key',
      });
      // --refresh proceeds; the warning should be printed.
      expect(r.stderr).toContain('Embedding model mismatch');
      // It will fail later because there's no actual KB content + embeddings;
      // just verify the warning path was hit. Either 0 (empty results) or
      // 1 (network failure to embedding API) is acceptable here.
      expect([0, 1]).toContain(r.code);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
