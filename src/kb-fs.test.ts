import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listKnowledgeBases } from './kb-fs.js';

describe('listKnowledgeBases', () => {
  it('returns names of subdirectories, filtering dot-prefixed entries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-list-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'engineering'));
      await fsp.mkdir(path.join(tempDir, 'personal'));
      await fsp.mkdir(path.join(tempDir, '.faiss'));            // dot-prefixed: skipped
      await fsp.writeFile(path.join(tempDir, '.reindex-trigger'), '');  // dot-file: skipped

      const out = await listKnowledgeBases(tempDir);
      expect(out.sort()).toEqual(['engineering', 'personal']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when only dot entries exist', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-empty-'));
    try {
      await fsp.mkdir(path.join(tempDir, '.faiss'));
      const out = await listKnowledgeBases(tempDir);
      expect(out).toEqual([]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws on missing root directory (caller decides surfacing)', async () => {
    await expect(
      listKnowledgeBases('/nonexistent/path/that/should/not/exist'),
    ).rejects.toThrow();
  });
});
