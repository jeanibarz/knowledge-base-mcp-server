// Issue #279 — extraction cache tests.
//
// Covers:
//   - Cache key derivation is deterministic and changes when any of
//     {loaderName, loaderVersion, ext, contentSha256} changes.
//   - readCachedExtraction returns null on miss without throwing.
//   - writeCachedExtraction is atomic (tmp + rename) and creates the dir.
//   - writeCachedExtraction swallows I/O errors so callers stay on the cold path.
//   - loadWithExtractionCache: miss → invokes parser, stores result.
//   - loadWithExtractionCache: hit → returns cached text, does NOT invoke parser.
//   - loadWithExtractionCache: content change ⇒ new key ⇒ parser invoked again.
//   - loadWithExtractionCache: loaderVersion bump ⇒ miss against the previous entry.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  computeContentSha256,
  computeExtractionCacheKey,
  defaultExtractionCacheDir,
  EXTRACTION_CACHE_SCHEMA_VERSION,
  applyExtractionCachePrune,
  inventoryExtractionCache,
  loadWithExtractionCache,
  planExtractionCachePrune,
  readCachedExtraction,
  writeCachedExtraction,
} from './extraction-cache.js';

describe('computeContentSha256', () => {
  it('produces a stable 64-char hex digest for identical bytes', () => {
    const a = computeContentSha256(Buffer.from('hello world'));
    const b = computeContentSha256(Buffer.from('hello world'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different digests for different bytes', () => {
    expect(computeContentSha256(Buffer.from('a'))).not.toBe(
      computeContentSha256(Buffer.from('b')),
    );
  });
});

describe('computeExtractionCacheKey', () => {
  const base = {
    loaderName: 'pdf-parse',
    loaderVersion: 1,
    ext: '.pdf',
    contentSha256: 'a'.repeat(64),
  };

  it('is deterministic — same inputs always produce the same key', () => {
    expect(computeExtractionCacheKey(base)).toBe(computeExtractionCacheKey(base));
  });

  it('returns a 64-char hex digest (sha256-shaped, filesystem-safe)', () => {
    expect(computeExtractionCacheKey(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when contentSha256 changes (different file bytes)', () => {
    const other = { ...base, contentSha256: 'b'.repeat(64) };
    expect(computeExtractionCacheKey(base)).not.toBe(computeExtractionCacheKey(other));
  });

  it('changes when loaderVersion is bumped (forces invalidation)', () => {
    const bumped = { ...base, loaderVersion: 2 };
    expect(computeExtractionCacheKey(base)).not.toBe(computeExtractionCacheKey(bumped));
  });

  it('changes when loaderName differs (PDF cache cannot collide with HTML cache)', () => {
    const html = { ...base, loaderName: 'html-to-text' };
    expect(computeExtractionCacheKey(base)).not.toBe(computeExtractionCacheKey(html));
  });

  it('changes when ext differs (same bytes routed through a different loader must not collide)', () => {
    const htm = { ...base, ext: '.htm' };
    expect(computeExtractionCacheKey(base)).not.toBe(computeExtractionCacheKey(htm));
  });

  it('is case-insensitive on extension (`.PDF` and `.pdf` share an entry)', () => {
    const upper = { ...base, ext: '.PDF' };
    expect(computeExtractionCacheKey(base)).toBe(computeExtractionCacheKey(upper));
  });

  it('declares a schema version so storage-layout changes can force a global invalidate', () => {
    // Locking in the symbol so a future bump is intentional, not accidental.
    expect(EXTRACTION_CACHE_SCHEMA_VERSION).toBe(1);
  });
});

describe('defaultExtractionCacheDir', () => {
  const originalOverride = process.env.EXTRACTION_TEXT_CACHE_DIR;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    } else {
      process.env.EXTRACTION_TEXT_CACHE_DIR = originalOverride;
    }
  });

  it('honors EXTRACTION_TEXT_CACHE_DIR when set (test/dev redirect)', () => {
    process.env.EXTRACTION_TEXT_CACHE_DIR = '/tmp/kb-fake-extraction-cache';
    expect(defaultExtractionCacheDir()).toBe('/tmp/kb-fake-extraction-cache');
  });

  it('falls back to a path under FAISS_INDEX_PATH when no override is set', () => {
    delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    expect(defaultExtractionCacheDir()).toMatch(/extracted-text$/);
  });
});

describe('readCachedExtraction', () => {
  let cacheDir = '';

  beforeEach(async () => {
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-extract-cache-read-'));
  });

  afterEach(async () => {
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  it('returns null when the entry does not exist (miss)', async () => {
    expect(await readCachedExtraction(cacheDir, 'nonexistent-key')).toBeNull();
  });

  it('returns the stored UTF-8 text on a hit', async () => {
    await fsp.writeFile(path.join(cacheDir, 'mykey.txt'), 'cached extraction body');
    expect(await readCachedExtraction(cacheDir, 'mykey')).toBe('cached extraction body');
  });

  it('returns null (does not throw) when the cache dir itself is missing', async () => {
    // Hardened against operator misconfiguration: a broken cacheDir must not
    // crash ingest; the loader will simply re-parse and try to write later.
    expect(await readCachedExtraction(path.join(cacheDir, 'never-created'), 'k')).toBeNull();
  });
});

describe('writeCachedExtraction', () => {
  let cacheDir = '';

  beforeEach(async () => {
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-extract-cache-write-'));
  });

  afterEach(async () => {
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  it('writes the text under the keyed filename and a round-trip read returns it verbatim', async () => {
    await writeCachedExtraction(cacheDir, 'abc', 'parsed body');
    expect(await fsp.readFile(path.join(cacheDir, 'abc.txt'), 'utf-8')).toBe('parsed body');
    expect(await readCachedExtraction(cacheDir, 'abc')).toBe('parsed body');
  });

  it('creates the cache directory if it does not already exist', async () => {
    const nested = path.join(cacheDir, 'deep', 'nested', 'dir');
    await writeCachedExtraction(nested, 'k', 'v');
    expect(await fsp.readFile(path.join(nested, 'k.txt'), 'utf-8')).toBe('v');
  });

  it('does not leave a `.tmp.*` sibling after a successful write (atomic rename completed)', async () => {
    await writeCachedExtraction(cacheDir, 'tidy', 'body');
    const entries = await fsp.readdir(cacheDir);
    expect(entries).toEqual(['tidy.txt']);
    // No stray atomic-write tmpfiles surviving the rename — important so the
    // cache directory listing stays meaningful for operators eyeballing it.
    expect(entries.every((e) => !e.includes('.tmp.'))).toBe(true);
  });

  it('overwrites a stale entry under the same key (re-parse case)', async () => {
    await writeCachedExtraction(cacheDir, 'k', 'old body');
    await writeCachedExtraction(cacheDir, 'k', 'new body');
    expect(await readCachedExtraction(cacheDir, 'k')).toBe('new body');
  });

  it('swallows I/O errors so the caller stays on the cold path (cache write is best-effort)', async () => {
    // Force a write failure by pointing cacheDir at an existing FILE rather
    // than a directory — `mkdir { recursive }` on Linux fails with ENOTDIR
    // partway through, which is the realistic operator-misconfiguration
    // failure mode. The helper must not throw; the fresh parse output is
    // already in the caller's hand and ingest must continue.
    const bogusFile = path.join(cacheDir, 'not-a-dir.txt');
    await fsp.writeFile(bogusFile, 'sentinel');
    const collision = path.join(bogusFile, 'sub');
    await expect(writeCachedExtraction(collision, 'k', 'v')).resolves.toBeUndefined();
  });
});

describe('loadWithExtractionCache', () => {
  let tempDir = '';
  let cacheDir = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-extract-cache-load-'));
    cacheDir = path.join(tempDir, 'cache');
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('on a miss, invokes parse with the file bytes and stores the result for next time', async () => {
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 fake'));
    const parse = jest.fn().mockResolvedValue('parsed text');

    const text = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });

    expect(text).toBe('parsed text');
    expect(parse).toHaveBeenCalledTimes(1);
    const buf = parse.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.from('%PDF-1.4 fake'))).toBe(true);
  });

  it('on a hit (second call, same bytes), returns the cached text and does NOT invoke parse', async () => {
    // This is the load-bearing behavior of the whole issue: a forced rebuild
    // or a second model registration must skip the expensive parser.
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 fake'));
    const parse = jest.fn().mockResolvedValue('parsed text');

    await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });
    const second = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });

    expect(second).toBe('parsed text');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache when the file bytes change (different sha → different key)', async () => {
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('first revision'));
    const parse = jest.fn().mockResolvedValueOnce('FIRST').mockResolvedValueOnce('SECOND');

    const t1 = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });
    expect(t1).toBe('FIRST');

    // Same path, new bytes — the cache must miss and the parser must be
    // invoked a second time so the embedding pipeline sees up-to-date text.
    await fsp.writeFile(filePath, Buffer.from('second revision'));
    const t2 = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });

    expect(t2).toBe('SECOND');
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when loaderVersion is bumped (behavior change)', async () => {
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('unchanged bytes'));
    const parse = jest.fn().mockResolvedValueOnce('v1-output').mockResolvedValueOnce('v2-output');

    await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });
    const afterBump = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 2,
      parse,
      cacheDir,
    });

    expect(afterBump).toBe('v2-output');
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('uses defaultExtractionCacheDir when no cacheDir override is supplied', async () => {
    // Smoke-check the fallback wire: with `EXTRACTION_TEXT_CACHE_DIR` pointed
    // at the test dir, the helper must honor it (so production paths land at
    // FAISS_INDEX_PATH/extracted-text without us needing to mock fs).
    const original = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = cacheDir;
    try {
      const filePath = path.join(tempDir, 'doc.pdf');
      await fsp.writeFile(filePath, Buffer.from('%PDF-default-dir'));
      const parse = jest.fn().mockResolvedValue('via default dir');

      await loadWithExtractionCache({
        filePath,
        loaderName: 'pdf-parse',
        loaderVersion: 1,
        parse,
      });

      const entries = await fsp.readdir(cacheDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^[a-f0-9]{64}\.txt$/);
    } finally {
      if (original === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
      else process.env.EXTRACTION_TEXT_CACHE_DIR = original;
    }
  });

  it('propagates parse errors to the caller (cache only stores successes)', async () => {
    // A failed parse must not poison the cache. The next call with the same
    // bytes should re-run the parser, not return a stale "error" placeholder.
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('corrupt'));
    const parse = jest
      .fn()
      .mockRejectedValueOnce(new Error('parse boom'))
      .mockResolvedValueOnce('recovered text');

    await expect(
      loadWithExtractionCache({
        filePath,
        loaderName: 'pdf-parse',
        loaderVersion: 1,
        parse,
        cacheDir,
      }),
    ).rejects.toThrow('parse boom');

    // No entry was stored after the failure.
    await expect(fsp.readdir(cacheDir)).rejects.toMatchObject({ code: 'ENOENT' });

    // Retrying the same file re-runs the parser and now stores the result.
    const recovered = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir,
    });
    expect(recovered).toBe('recovered text');
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('continues to return the freshly parsed text even when the cache write fails', async () => {
    // Operator-misconfiguration safety net: a write failure must not surface
    // to the caller. The cold-path output is already in hand; ingest must
    // proceed. We force the write to fail by aiming the cache at a path
    // whose parent is a regular file (mkdir -p ENOTDIR).
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('bytes'));
    const fileMaskedAsDir = path.join(tempDir, 'masked-file');
    await fsp.writeFile(fileMaskedAsDir, 'sentinel');
    const brokenCacheDir = path.join(fileMaskedAsDir, 'cache');

    const parse = jest.fn().mockResolvedValue('cold-path text');

    const text = await loadWithExtractionCache({
      filePath,
      loaderName: 'pdf-parse',
      loaderVersion: 1,
      parse,
      cacheDir: brokenCacheDir,
    });

    expect(text).toBe('cold-path text');
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('extracted-text cache inventory and pruning', () => {
  let cacheDir = '';
  const now = new Date('2026-06-03T12:00:00.000Z');

  beforeEach(async () => {
    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-extract-cache-prune-'));
  });

  afterEach(async () => {
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  async function writeEntry(hex: string, body: string, mtime: Date): Promise<string> {
    const filename = `${hex.repeat(64).slice(0, 64)}.txt`;
    const filePath = path.join(cacheDir, filename);
    await fsp.writeFile(filePath, body);
    await fsp.utimes(filePath, mtime, mtime);
    return filename;
  }

  it('inventories only expected cache files and reports ignored siblings', async () => {
    const filename = await writeEntry('a', 'cached text', new Date('2026-06-01T00:00:00.000Z'));
    await fsp.writeFile(path.join(cacheDir, 'readme.txt'), 'not a cache key');

    const inventory = await inventoryExtractionCache(cacheDir, now);

    expect(inventory.exists).toBe(true);
    expect(inventory.entries).toEqual([
      expect.objectContaining({
        filename,
        size_bytes: Buffer.byteLength('cached text'),
        mtime: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    expect(inventory.summary).toMatchObject({
      entry_count: 1,
      total_bytes: Buffer.byteLength('cached text'),
      ignored_entry_count: 1,
      error_count: 0,
    });
    expect(inventory.ignored_entries).toEqual([
      { filename: 'readme.txt', reason: 'not_cache_file' },
    ]);
  });

  it('plans age pruning without touching files', async () => {
    const oldName = await writeEntry('a', 'old', new Date('2026-05-01T00:00:00.000Z'));
    const freshName = await writeEntry('b', 'fresh', new Date('2026-06-02T00:00:00.000Z'));

    const plan = await planExtractionCachePrune({
      cacheDir,
      maxAgeDays: 14,
      now,
    });

    expect(plan.summary).toMatchObject({
      prunable_count: 1,
      prunable_bytes: Buffer.byteLength('old'),
      kept_count: 1,
      kept_bytes: Buffer.byteLength('fresh'),
      age_prunable_count: 1,
      size_prunable_count: 0,
    });
    expect(plan.prunable_entries).toEqual([
      expect.objectContaining({ filename: oldName, reasons: ['age'] }),
    ]);
    expect(plan.kept_entries).toEqual([
      expect.objectContaining({ filename: freshName }),
    ]);
    expect(await fsp.readdir(cacheDir)).toHaveLength(2);
  });

  it('plans size pruning from oldest entries until the budget is met', async () => {
    const oldest = await writeEntry('a', 'aaaa', new Date('2026-05-01T00:00:00.000Z'));
    const middle = await writeEntry('b', 'bbbb', new Date('2026-05-02T00:00:00.000Z'));
    const newest = await writeEntry('c', 'cccc', new Date('2026-05-03T00:00:00.000Z'));

    const plan = await planExtractionCachePrune({
      cacheDir,
      maxSizeBytes: 8,
      now,
    });

    expect(plan.prunable_entries).toEqual([
      expect.objectContaining({ filename: oldest, reasons: ['size'] }),
    ]);
    expect(plan.kept_entries.map((entry) => entry.filename)).toEqual([middle, newest]);
    expect(plan.summary).toMatchObject({
      prunable_count: 1,
      prunable_bytes: 4,
      kept_bytes: 8,
      size_prunable_count: 1,
    });
  });

  it('applies a plan only to planned cache files', async () => {
    const oldName = await writeEntry('a', 'old', new Date('2026-05-01T00:00:00.000Z'));
    const freshName = await writeEntry('b', 'fresh', new Date('2026-06-02T00:00:00.000Z'));
    await fsp.writeFile(path.join(cacheDir, 'notes.txt'), 'ignored');
    const plan = await planExtractionCachePrune({
      cacheDir,
      maxAgeDays: 14,
      now,
    });

    const result = await applyExtractionCachePrune(plan);

    expect(result.summary).toEqual({
      deleted_count: 1,
      deleted_bytes: Buffer.byteLength('old'),
      failed_count: 0,
    });
    expect(result.deleted_entries).toEqual([
      expect.objectContaining({ filename: oldName }),
    ]);
    await expect(fsp.stat(path.join(cacheDir, oldName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(cacheDir, freshName))).resolves.toBeDefined();
    await expect(fsp.stat(path.join(cacheDir, 'notes.txt'))).resolves.toBeDefined();
  });
});
