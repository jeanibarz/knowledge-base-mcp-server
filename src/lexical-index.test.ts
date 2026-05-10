// Issue #206 stage 1 — tests for src/lexical-index.ts
//
// We isolate FAISS_INDEX_PATH + KNOWLEDGE_BASES_ROOT_DIR per test by writing
// the env BEFORE re-importing the module (its top-level imports of `config.ts`
// snapshot env at module load). `jest.resetModules()` ensures a fresh closure
// per test.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function freshLexical(rootDir: string, faissDir: string): Promise<typeof import('./lexical-index.js')> {
  process.env.KNOWLEDGE_BASES_ROOT_DIR = rootDir;
  process.env.FAISS_INDEX_PATH = faissDir;
  delete process.env.INGEST_EXTRA_EXTENSIONS;
  delete process.env.INGEST_EXCLUDE_PATHS;
  jest.resetModules();
  return import('./lexical-index.js');
}

async function seedKb(rootDir: string, kbName: string, files: Record<string, string>): Promise<string> {
  const kbPath = path.join(rootDir, kbName);
  await fsp.mkdir(kbPath, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(kbPath, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf-8');
  }
  return kbPath;
}

describe('LexicalIndex', () => {
  it('builds, persists, and reloads a per-KB BM25 index', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-build-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'docs', {
        'a.md': '# Alpha\n\nThis note discusses INDEX_NOT_INITIALIZED and the recovery path.\n',
        'b.md': '# Beta\n\nUnrelated cooking notes about pasta sauce.\n',
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('docs', kbPath);
      const summary = await idx.refresh();
      expect(summary.added).toBe(2);
      expect(summary.updated).toBe(0);
      expect(summary.removed).toBe(0);
      expect(summary.totalFiles).toBe(2);
      expect(summary.totalChunks).toBeGreaterThanOrEqual(2);
      await idx.save();

      const persisted = path.join(faissDir, 'lexical', 'docs', 'index.json');
      const raw = JSON.parse(await fsp.readFile(persisted, 'utf-8'));
      expect(raw.version).toBe(1);
      expect(raw.kbName).toBe('docs');
      expect(Object.keys(raw.files).sort()).toEqual(['a.md', 'b.md']);

      const reloaded = await LexicalIndex.load('docs', kbPath);
      expect(reloaded.numFiles()).toBe(2);
      expect(reloaded.numChunks()).toBe(idx.numChunks());
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns BM25-ranked results: exact-token query surfaces the matching chunk', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-query-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'rfcs', {
        'a.md': 'A note about cookies and bread baking.',
        'b.md': 'A note discussing INDEX_NOT_INITIALIZED handling.',
        'c.md': 'A note about long-distance running and hydration.',
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('rfcs', kbPath);
      await idx.refresh();
      const hits = await idx.query('INDEX_NOT_INITIALIZED', 3);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].metadata.relativePath).toBe('rfcs/b.md');
      expect(hits[0].score).toBeGreaterThan(0);
      // metadata should be free of leaking bm25Score field — we strip it.
      expect(hits[0].metadata).not.toHaveProperty('bm25Score');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refresh updates entries for changed files and removes deleted files', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-invalidate-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'notes', {
        'keep.md': 'Initial content for keep.',
        'edit.md': 'Original content for edit.',
        'gone.md': 'Will be deleted.',
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      let idx = await LexicalIndex.load('notes', kbPath);
      const initial = await idx.refresh();
      expect(initial.added).toBe(3);
      await idx.save();

      // Mutate the KB: edit one file, delete another.
      await fsp.writeFile(path.join(kbPath, 'edit.md'), 'Edited content with NEW_KEYWORD inserted.');
      await fsp.unlink(path.join(kbPath, 'gone.md'));

      idx = await LexicalIndex.load('notes', kbPath);
      const second = await idx.refresh();
      expect(second.updated).toBe(1);
      expect(second.removed).toBe(1);
      expect(second.added).toBe(0);
      expect(second.totalFiles).toBe(2);

      const hits = await idx.query('NEW_KEYWORD', 5);
      expect(hits[0]?.metadata.relativePath).toBe('notes/edit.md');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty results when the index is empty or k=0', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-empty-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = path.join(rootDir, 'empty');
      await fsp.mkdir(kbPath, { recursive: true });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('empty', kbPath);
      await idx.refresh();
      expect(await idx.query('anything', 10)).toEqual([]);

      // Even with content, k=0 returns nothing.
      await fsp.writeFile(path.join(kbPath, 'a.md'), 'word word word');
      await idx.refresh();
      expect(await idx.query('word', 0)).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt index file with CORRUPT_INDEX', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-corrupt-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      const kbPath = await seedKb(rootDir, 'docs', { 'a.md': 'x' });
      const persisted = path.join(faissDir, 'lexical', 'docs');
      await fsp.mkdir(persisted, { recursive: true });
      await fsp.writeFile(path.join(persisted, 'index.json'), '{not-json');

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      await expect(LexicalIndex.load('docs', kbPath)).rejects.toMatchObject({
        code: 'CORRUPT_INDEX',
      });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
