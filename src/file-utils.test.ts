import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicDurable } from './file-utils.js';

describe('writeFileAtomicDurable', () => {
  it('writes through a durable temp file and syncs the parent directory', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-atomic-durable-'));
    try {
      const target = path.join(tempDir, 'state.json');
      const syncedDirs: string[] = [];

      await writeFileAtomicDurable(target, '{"ok":true}\n', {
        hooks: {
          syncDirectory: async (dir) => {
            syncedDirs.push(dir);
          },
        },
      });

      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('{"ok":true}\n');
      expect(syncedDirs).toEqual([tempDir]);
      const leftovers = (await fsp.readdir(tempDir)).filter((name) => name.includes('.kb-tmp.'));
      expect(leftovers).toEqual([]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the original file and removes the temp file when rename fails', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-atomic-durable-fail-'));
    try {
      const target = path.join(tempDir, 'state.json');
      await fsp.writeFile(target, '{"version":1}\n', 'utf-8');

      await expect(
        writeFileAtomicDurable(target, '{"version":2}\n', {
          hooks: {
            rename: async () => {
              throw Object.assign(new Error('simulated cross-device rename'), { code: 'EXDEV' });
            },
          },
        }),
      ).rejects.toThrow('simulated cross-device rename');

      await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('{"version":1}\n');
      const leftovers = (await fsp.readdir(tempDir)).filter((name) => name.includes('.kb-tmp.'));
      expect(leftovers).toEqual([]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
