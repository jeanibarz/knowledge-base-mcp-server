import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  appendFileAtomically,
  atomicWriteFile,
  createFileAtomically,
  rewriteFileAtomically,
} from './file-mutation.js';
import { KB_WRITE_POLICY_FILENAME } from './kb-write-policy.js';

describe('file mutation helpers', () => {
  it('atomically appends by rewrite and preserves target permissions', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-mode-'));
    try {
      const target = path.join(tempDir, 'note.md');
      await fsp.writeFile(target, 'first\n', 'utf-8');
      await fsp.chmod(target, 0o600);

      await appendFileAtomically(target, 'second\n', { kbDir: tempDir });

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
        Array.from(
          { length: 12 },
          (_, i) => appendFileAtomically(target, `entry-${i}\n`, { kbDir: tempDir }),
        ),
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

  it('serializes appends with other atomic rewrites on the same target', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-mixed-'));
    try {
      const target = path.join(tempDir, 'note.md');
      await fsp.writeFile(target, '# Note\n\nbody\n', 'utf-8');

      await Promise.all([
        appendFileAtomically(target, '\nEOF append\n', { kbDir: tempDir }),
        rewriteFileAtomically(
          target,
          (original) => original.replace('body\n', 'body\nsection insert\n'),
          { kbDir: tempDir },
        ),
      ]);

      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe(
        '# Note\n\nbody\nsection insert\n\nEOF append\n',
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

  it('blocks policy-denied managed appends without changing the target', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-policy-'));
    try {
      const kbDir = path.join(tempDir, 'alpha');
      const target = path.join(kbDir, 'note.md');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(target, 'old\n', 'utf-8');
      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":"deny"}\n',
        'utf-8',
      );

      await expect(appendFileAtomically(target, 'new\n', { kbDir })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('old\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks managed rewrites of the policy file itself', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-policy-file-'));
    try {
      const kbDir = path.join(tempDir, 'alpha');
      const target = path.join(kbDir, KB_WRITE_POLICY_FILENAME);
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(target, '{"mutations":"allow"}\n', 'utf-8');

      await expect(rewriteFileAtomically(target, () => '{}\n', { kbDir })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('{"mutations":"allow"}\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rechecks the policy after generating rewritten content', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-policy-race-'));
    try {
      const kbDir = path.join(tempDir, 'alpha');
      const target = path.join(kbDir, 'note.md');
      const policyPath = path.join(kbDir, KB_WRITE_POLICY_FILENAME);
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(target, 'old\n', 'utf-8');

      await expect(
        rewriteFileAtomically(
          target,
          async () => {
            await fsp.writeFile(policyPath, '{"mutations":"deny"}\n', 'utf-8');
            return 'new\n';
          },
          { kbDir },
        ),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('old\n');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('creates new files atomically and checks the KB policy before creating parents', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-file-mutation-create-'));
    try {
      const kbDir = path.join(tempDir, 'alpha');
      const allowedTarget = path.join(kbDir, 'notes', 'allowed.md');
      await fsp.mkdir(kbDir, { recursive: true });

      await expect(createFileAtomically(allowedTarget, 'allowed\n', { kbDir })).resolves.toBeUndefined();
      await expect(fsp.readFile(allowedTarget, 'utf-8')).resolves.toBe('allowed\n');

      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":"allow"}\n',
        'utf-8',
      );
      const explicitAllowedTarget = path.join(kbDir, 'notes', 'explicit-allow.md');
      await expect(createFileAtomically(explicitAllowedTarget, 'explicit\n', { kbDir }))
        .resolves.toBeUndefined();
      await expect(createFileAtomically(explicitAllowedTarget, 'replacement\n', { kbDir }))
        .rejects.toMatchObject({ code: 'EEXIST' });
      await expect(fsp.readFile(explicitAllowedTarget, 'utf-8')).resolves.toBe('explicit\n');
      const leftovers = (await fsp.readdir(path.dirname(explicitAllowedTarget)))
        .filter((name) => name.includes('.kb-tmp.'));
      expect(leftovers).toEqual([]);

      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":"deny"}\n',
        'utf-8',
      );
      const deniedTarget = path.join(kbDir, 'new', 'denied.md');
      await expect(createFileAtomically(deniedTarget, 'denied\n', { kbDir })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await expect(fsp.stat(path.dirname(deniedTarget))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
