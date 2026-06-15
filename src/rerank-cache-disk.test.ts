import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  DiskTieredRerankScoreCache,
  normalizeRerankQuery,
  rerankScoreCacheKey,
  rerankScoreCacheRoot,
} from './rerank-cache-disk.js';
import { isRerankCacheEnabled, resolveRerankCacheDiskMaxBytes } from './config/reranker.js';

async function tempIndexPath(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, '.faiss');
}

const MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

describe('DiskTieredRerankScoreCache (#646)', () => {
  it('persists scores across cache instances via the disk tier', async () => {
    const indexPath = await tempIndexPath('kb-rerank-cache-roundtrip-');
    try {
      const first = new DiskTieredRerankScoreCache({ indexPath, enabled: true });
      expect(first.get(MODEL, 'how do rollbacks work', 'candidate body')).toBeNull();
      first.set(MODEL, 'how do rollbacks work', 'candidate body', 0.875);

      // A fresh instance has a cold L1 but must recover the score from disk.
      const second = new DiskTieredRerankScoreCache({ indexPath, enabled: true });
      const hit = second.get(MODEL, 'how do rollbacks work', 'candidate body');
      expect(hit).toBe(0.875);
      const stats = second.stats();
      expect(stats.disk_hits).toBe(1);
      expect(stats.l1_hits).toBe(0);

      // Promotes into L1 on the disk hit — a second read is a memory hit.
      expect(second.get(MODEL, 'how do rollbacks work', 'candidate body')).toBe(0.875);
      expect(second.stats().l1_hits).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('derives a stable, normalized key and isolates by model and candidate', () => {
    // Query normalization (trim, whitespace-collapse, lower-case, NFKC) makes
    // these the same key; model id and candidate text are part of the key.
    expect(rerankScoreCacheKey(MODEL, '  Query   Text ', 'body')).toBe(
      rerankScoreCacheKey(MODEL, 'query text', 'body'),
    );
    expect(rerankScoreCacheKey(MODEL, 'q', 'body-a')).not.toBe(
      rerankScoreCacheKey(MODEL, 'q', 'body-b'),
    );
    expect(rerankScoreCacheKey('model-a', 'q', 'body')).not.toBe(
      rerankScoreCacheKey('model-b', 'q', 'body'),
    );
    expect(normalizeRerankQuery('  A B\nC  ')).toBe('a b c');
  });

  it('serves a normalized-query variant from cache without re-scoring', async () => {
    const indexPath = await tempIndexPath('kb-rerank-cache-normalize-');
    try {
      const cache = new DiskTieredRerankScoreCache({ indexPath, enabled: true });
      cache.set(MODEL, '  Query   Text ', 'body', 0.5);
      expect(cache.get(MODEL, 'query text', 'body')).toBe(0.5);

      // Different model id is a distinct entry — a miss, not a stale hit.
      expect(cache.get('other-model', 'query text', 'body')).toBeNull();
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('enforces the disk size bound by evicting oldest entries', async () => {
    const indexPath = await tempIndexPath('kb-rerank-cache-evict-');
    try {
      // Probe one entry's on-disk footprint, then bound the disk tier to ~2.5
      // entries so writing a 3rd forces eviction of the oldest.
      const probe = new DiskTieredRerankScoreCache({ indexPath, enabled: true });
      probe.set(MODEL, 'probe', 'probe-body', 0.1);
      const entryBytes = probe.diskSizeBytes();
      expect(entryBytes).toBeGreaterThan(0);
      await fsp.rm(path.join(rerankScoreCacheRoot(indexPath)), { recursive: true, force: true });

      const cache = new DiskTieredRerankScoreCache({
        indexPath,
        enabled: true,
        l1Max: 0, // force every read to go to disk
        diskMaxBytes: Math.floor(entryBytes * 2.5),
      });

      cache.set(MODEL, 'q1', 'first', 0.11);
      cache.set(MODEL, 'q2', 'second', 0.22);
      cache.set(MODEL, 'q3', 'third', 0.33);

      // Three entries exceed the ~2.5-entry bound, so the oldest (q1) is gone.
      expect(cache.diskSizeBytes()).toBeLessThanOrEqual(Math.floor(entryBytes * 2.5));
      expect(cache.get(MODEL, 'q1', 'first')).toBeNull();
      expect(cache.get(MODEL, 'q3', 'third')).toBe(0.33);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('treats a corrupt disk entry as a miss and removes it', async () => {
    const indexPath = await tempIndexPath('kb-rerank-cache-corrupt-');
    try {
      const cache = new DiskTieredRerankScoreCache({ indexPath, enabled: true, l1Max: 0 });
      const key = rerankScoreCacheKey(MODEL, 'broken', 'body');
      const file = path.join(rerankScoreCacheRoot(indexPath), key.slice(0, 2), `${key}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'not json', 'utf-8');

      expect(cache.get(MODEL, 'broken', 'body')).toBeNull();
      expect(cache.stats().corruptions).toBe(1);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('is a no-op (no disk artifacts) when disabled', async () => {
    const indexPath = await tempIndexPath('kb-rerank-cache-disabled-');
    try {
      const cache = new DiskTieredRerankScoreCache({ indexPath, enabled: false });
      cache.set(MODEL, 'q', 'body', 0.9);
      expect(cache.get(MODEL, 'q', 'body')).toBeNull();
      expect(cache.diskSizeBytes()).toBe(0);
      expect(fs.existsSync(rerankScoreCacheRoot(indexPath))).toBe(false);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('parses KB_RERANK_CACHE as opt-in and the byte bound with a safe default', () => {
    expect(isRerankCacheEnabled('')).toBe(false);
    expect(isRerankCacheEnabled(undefined)).toBe(false);
    expect(isRerankCacheEnabled('off')).toBe(false);
    expect(isRerankCacheEnabled('on')).toBe(true);
    expect(isRerankCacheEnabled(' TRUE ')).toBe(true);
    expect(isRerankCacheEnabled('1')).toBe(true);

    expect(resolveRerankCacheDiskMaxBytes('1048576')).toBe(1048576);
    expect(resolveRerankCacheDiskMaxBytes('')).toBe(64 * 1024 * 1024);
    expect(resolveRerankCacheDiskMaxBytes('-5')).toBe(64 * 1024 * 1024);
    expect(resolveRerankCacheDiskMaxBytes('nonsense')).toBe(64 * 1024 * 1024);
  });
});
