// Issue #206 stage 1 — tests for src/lexical-index.ts
//
// We isolate FAISS_INDEX_PATH + KNOWLEDGE_BASES_ROOT_DIR per test by writing
// the env BEFORE re-importing the module (its top-level imports of `config.ts`
// snapshot env at module load). `jest.resetModules()` ensures a fresh closure
// per test.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'crypto';
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

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
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
      // RFC 017 §3 — schema bumped to 2; v1 indexes remain readable but
      // fresh writes use the new version.
      expect(raw.version).toBe(2);
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

  it('does not rewrite the persisted index when refresh finds no file changes', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-noop-save-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'docs', {
        'a.md': '# Alpha\n\nStable content for a no-op refresh.\n',
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      let idx = await LexicalIndex.load('docs', kbPath);
      const initial = await idx.refresh();
      expect(initial.added).toBe(1);
      await idx.save();

      const persisted = path.join(faissDir, 'lexical', 'docs', 'index.json');
      const oldDate = new Date('2001-02-03T04:05:06.000Z');
      await fsp.utimes(persisted, oldDate, oldDate);
      const before = await fsp.stat(persisted);
      const rawBefore = await fsp.readFile(persisted, 'utf-8');

      idx = await LexicalIndex.load('docs', kbPath);
      const second = await idx.refresh();
      expect(second).toMatchObject({
        added: 0,
        updated: 0,
        removed: 0,
        failed: 0,
        totalFiles: 1,
      });
      await idx.save();

      const after = await fsp.stat(persisted);
      const rawAfter = await fsp.readFile(persisted, 'utf-8');
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(rawAfter).toBe(rawBefore);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rewrites readable old-schema indexes even when refresh finds no file changes', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-schema-upgrade-save-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'docs', {
        'a.md': '# Alpha\n\nStable content in a v1 lexical index.\n',
      });

      const persistedDir = path.join(faissDir, 'lexical', 'docs');
      await fsp.mkdir(persistedDir, { recursive: true });
      const persisted = path.join(persistedDir, 'index.json');
      await fsp.writeFile(
        persisted,
        JSON.stringify({
          version: 1,
          kbName: 'docs',
          writtenAt: '2001-02-03T04:05:06.000Z',
          files: {
            'a.md': {
              sha256: await sha256(path.join(kbPath, 'a.md')),
              chunks: [{
                pageContent: '# Alpha\n\nStable content in a v1 lexical index.\n',
                metadata: { source: path.join(kbPath, 'a.md'), relativePath: 'docs/a.md' },
              }],
            },
          },
        }, null, 2),
        'utf-8',
      );
      const oldDate = new Date('2001-02-03T04:05:06.000Z');
      await fsp.utimes(persisted, oldDate, oldDate);
      const before = await fsp.stat(persisted);

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('docs', kbPath);
      const summary = await idx.refresh();
      expect(summary).toMatchObject({
        added: 0,
        updated: 0,
        removed: 0,
        failed: 0,
        totalFiles: 1,
      });
      await idx.save();

      const after = await fsp.stat(persisted);
      const raw = JSON.parse(await fsp.readFile(persisted, 'utf-8'));
      expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
      expect(raw.version).toBe(2);
      expect(raw.files['a.md'].chunks[0]).not.toHaveProperty('searchText');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('persists changed and removed files after a refresh mutation', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-dirty-save-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'docs', {
        'edit.md': 'Original content.',
        'gone.md': 'This file will be removed.',
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      let idx = await LexicalIndex.load('docs', kbPath);
      await idx.refresh();
      await idx.save();

      const persisted = path.join(faissDir, 'lexical', 'docs', 'index.json');
      const oldDate = new Date('2001-02-03T04:05:06.000Z');
      await fsp.utimes(persisted, oldDate, oldDate);
      const before = await fsp.stat(persisted);

      await fsp.writeFile(path.join(kbPath, 'edit.md'), 'Edited content with DIRTY_SAVE_MARKER.', 'utf-8');
      await fsp.unlink(path.join(kbPath, 'gone.md'));

      idx = await LexicalIndex.load('docs', kbPath);
      const second = await idx.refresh();
      expect(second.updated).toBe(1);
      expect(second.removed).toBe(1);
      await idx.save();

      const after = await fsp.stat(persisted);
      expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);

      const raw = JSON.parse(await fsp.readFile(persisted, 'utf-8'));
      expect(Object.keys(raw.files)).toEqual(['edit.md']);
      expect(raw.files['edit.md'].chunks[0].pageContent).toContain('DIRTY_SAVE_MARKER');
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

  // RFC 017 §3 — when `KB_CONTEXTUAL_RETRIEVAL=on` and chunks carry
  // `metadata.contextual_preface`, BM25 should score against the
  // preface-prepended `searchText` while still returning the verbatim
  // `pageContent` to callers. This test exercises both halves of the
  // contract by injecting prefaces directly into the on-disk index file
  // and verifying the query path.
  it('scores BM25 against searchText while returning original pageContent', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-rfc017-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      const kbPath = await seedKb(rootDir, 'docs', { 'a.md': '# A\n\nplaceholder.\n' });
      const { LexicalIndex } = await freshLexical(rootDir, faissDir);

      // Build a normal v2 index and then hand-edit the on-disk file to
      // inject a `searchText` that contains a marker absent from
      // `pageContent`. The query against the marker must surface the
      // chunk; the returned `pageContent` must be the original verbatim.
      const idx = await LexicalIndex.load('docs', kbPath);
      await idx.refresh();
      await idx.save();
      const persisted = path.join(faissDir, 'lexical', 'docs', 'index.json');
      const raw = JSON.parse(await fsp.readFile(persisted, 'utf-8'));
      const fileKey = Object.keys(raw.files)[0];
      const firstChunk = raw.files[fileKey].chunks[0];
      const originalContent = firstChunk.pageContent;
      firstChunk.searchText = `KEYWORDX preface marker. ${originalContent}`;
      await fsp.writeFile(persisted, JSON.stringify(raw), 'utf-8');

      // Re-load so the entries Map reflects the edit.
      const idx2 = await LexicalIndex.load('docs', kbPath);
      const results = await idx2.query('KEYWORDX', 5);

      expect(results.length).toBeGreaterThan(0);
      // Caller-visible content must be the ORIGINAL, not the
      // preface-prepended form.
      expect(results[0].pageContent).toBe(originalContent);
      expect(results[0].pageContent.includes('KEYWORDX')).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // RFC 017 §3 — `LexicalIndex.refresh` should populate `searchText` when
  // chunks carry `contextual_preface` metadata. With the feature flag
  // off, the field is absent (no waste).
  it('omits searchText when no preface metadata is on the chunks', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-rfc017-omit-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      const kbPath = await seedKb(rootDir, 'docs', { 'a.md': '# A\n\nplain content.\n' });
      const { LexicalIndex } = await freshLexical(rootDir, faissDir);

      const idx = await LexicalIndex.load('docs', kbPath);
      await idx.refresh();
      await idx.save();

      const persisted = path.join(faissDir, 'lexical', 'docs', 'index.json');
      const raw = JSON.parse(await fsp.readFile(persisted, 'utf-8'));
      const fileKey = Object.keys(raw.files)[0];
      const firstChunk = raw.files[fileKey].chunks[0];

      expect(firstChunk).not.toHaveProperty('searchText');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
