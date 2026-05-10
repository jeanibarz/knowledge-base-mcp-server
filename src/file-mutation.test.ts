import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendFileAtomically, atomicWriteFile } from './file-mutation.js';

describe('file mutation helpers', () => {
  it('atomically appends by rewrite and preserves target permissions', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-mode-'));
    try {
      const target = path.join(tempDir, 'note.md');
      await fsp.writeFile(target, 'first\n', 'utf-8');
      await fsp.chmod(target, 0o600);

      await appendFileAtomically(target, 'second\n');

      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('first\nsecond\n');
      expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
      await expect(fsp.stat(`${target}.kb-file.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.chmod(path.join(tempDir, 'note.md'), 0o600).catch(() => {});
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent read-modify-write appends without losing entries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-concurrent-'));
    try {
      const target = path.join(tempDir, 'note.md');
      await fsp.writeFile(target, 'base\n', 'utf-8');

      await Promise.all(
        Array.from({ length: 12 }, (_, i) => appendFileAtomically(target, `entry-${i}\n`)),
      );

      const lines = (await fsp.readFile(target, 'utf-8')).trimEnd().split('\n');
      expect(lines[0]).toBe('base');
      expect(lines.slice(1).sort()).toEqual(
        Array.from({ length: 12 }, (_, i) => `entry-${i}`).sort(),
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('removes the temporary file when the atomic rename fails', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-rename-fail-'));
    try {
      const target = path.join(tempDir, 'note.md');
      await fsp.writeFile(target, 'old\n', 'utf-8');

      await expect(
        atomicWriteFile(target, 'new\n', undefined, {
          rename: async () => {
            throw Object.assign(new Error('simulated rename failure'), { code: 'EXDEV' });
          },
        }),
      ).rejects.toThrow('simulated rename failure');

      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('old\n');
      const leftovers = (await fsp.readdir(tempDir)).filter((name) => name.includes('.kb-tmp.'));
      expect(leftovers).toEqual([]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
