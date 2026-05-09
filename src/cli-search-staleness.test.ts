import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const ORIGINAL_ENV = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

afterEach(async () => {
  if (ORIGINAL_ENV.KNOWLEDGE_BASES_ROOT_DIR === undefined) {
    delete process.env.KNOWLEDGE_BASES_ROOT_DIR;
  } else {
    process.env.KNOWLEDGE_BASES_ROOT_DIR = ORIGINAL_ENV.KNOWLEDGE_BASES_ROOT_DIR;
  }
  if (ORIGINAL_ENV.FAISS_INDEX_PATH === undefined) {
    delete process.env.FAISS_INDEX_PATH;
  } else {
    process.env.FAISS_INDEX_PATH = ORIGINAL_ENV.FAISS_INDEX_PATH;
  }
  jest.resetModules();
});

describe('computeStaleness', () => {
  it('counts scoped stale files separately from other KBs and preserves global counts', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-search-stale-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const modelId = 'ollama__scoped-stale-test';
      process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
      process.env.FAISS_INDEX_PATH = faissDir;

      const indexBinaryPath = path.join(
        faissDir,
        'models',
        modelId,
        'faiss.index',
        'faiss.index',
      );
      await fsp.mkdir(path.dirname(indexBinaryPath), { recursive: true });
      await fsp.writeFile(indexBinaryPath, 'index', 'utf-8');

      const alphaFresh = path.join(kbRoot, 'alpha', 'fresh.md');
      const alphaModified = path.join(kbRoot, 'alpha', 'modified.md');
      const betaModified = path.join(kbRoot, 'beta', 'modified.md');
      await fsp.mkdir(path.dirname(alphaFresh), { recursive: true });
      await fsp.mkdir(path.dirname(betaModified), { recursive: true });
      await fsp.writeFile(alphaFresh, '# Alpha fresh\n', 'utf-8');
      await fsp.writeFile(alphaModified, '# Alpha modified\n', 'utf-8');
      await fsp.writeFile(betaModified, '# Beta modified\n', 'utf-8');

      await fsp.mkdir(path.join(kbRoot, 'alpha', '.index'), { recursive: true });
      await fsp.writeFile(path.join(kbRoot, 'alpha', '.index', 'fresh.hash'), 'hash', 'utf-8');

      const beforeIndex = new Date('2026-05-03T15:00:00.000Z');
      const indexTime = new Date('2026-05-03T15:30:00.000Z');
      const afterIndex = new Date('2026-05-03T16:00:00.000Z');
      await fsp.utimes(indexBinaryPath, indexTime, indexTime);
      await fsp.utimes(alphaFresh, beforeIndex, beforeIndex);
      await fsp.utimes(alphaModified, afterIndex, afterIndex);
      await fsp.utimes(betaModified, afterIndex, afterIndex);

      jest.resetModules();
      const { computeStaleness } = await import('./cli-search.js');

      await expect(computeStaleness(modelId, 'alpha')).resolves.toMatchObject({
        modifiedFiles: 1,
        newFiles: 1,
        scope: { kb: 'alpha', modifiedFiles: 1, newFiles: 1 },
        global: { modifiedFiles: 2, newFiles: 2 },
      });

      await expect(computeStaleness(modelId)).resolves.toMatchObject({
        modifiedFiles: 2,
        newFiles: 2,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
