import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  QueryEmbeddingCache,
  normalizeQueryForCache,
  queryCachePaths,
} from './query-cache.js';
import { isQueryCacheEnabled } from './config/cache.js';

async function tempIndexPath(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, '.faiss');
}

describe('query embedding cache (#214)', () => {
  it('round-trips a query embedding through the disk tier across cache instances', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-roundtrip-');
    try {
      let calls = 0;
      const first = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const miss = await first.getOrCompute({
        modelId: 'fake__one',
        query: '  hello   world  ',
        embed: async () => {
          calls += 1;
          return [1.25, 2.5, 3.75];
        },
      });
      expect(miss.status).toBe('miss');
      expect(calls).toBe(1);

      const second = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const hit = await second.getOrCompute({
        modelId: 'fake__one',
        query: 'hello world',
        embed: async () => {
          calls += 1;
          return [9, 9, 9];
        },
      });
      expect(hit.status).toBe('hit_disk');
      expect(hit.embedding).toEqual([1.25, 2.5, 3.75]);
      expect(calls).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('isolates entries by model id', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-model-');
    try {
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'same query',
        embed: async () => [1, 1],
      });
      const second = await cache.getOrCompute({
        modelId: 'fake__two',
        query: 'same query',
        embed: async () => [2, 2],
      });
      expect(second.status).toBe('miss');
      expect(second.embedding).toEqual([2, 2]);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('evicts the least-recently-used in-memory entry and falls back to disk', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-lru-');
    try {
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 1 });
      await cache.getOrCompute({ modelId: 'fake__one', query: 'a', embed: async () => [1] });
      await cache.getOrCompute({ modelId: 'fake__one', query: 'b', embed: async () => [2] });
      const again = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'a',
        embed: async () => [9],
      });
      expect(again.status).toBe('hit_disk');
      expect(again.embedding).toEqual([1]);
      const stats = await cache.stats();
      expect(stats.l1_size).toBe(1);
      expect(stats.disk_hits).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('treats corrupt disk entries as misses and overwrites them', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-corrupt-');
    try {
      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'broken' });
      await fsp.mkdir(paths.modelCacheDir, { recursive: true });
      await fsp.writeFile(paths.vectorPath, Buffer.from([1, 2, 3]));
      await fsp.writeFile(paths.metaPath, JSON.stringify({
        schema_version: 'kb-query-cache.v1',
        model_id: 'fake__one',
        dim: 1,
        created_at: new Date().toISOString(),
      }));

      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const result = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'broken',
        embed: async () => [4],
      });

      expect(result.status).toBe('miss');
      expect(result.embedding).toEqual([4]);
      const stats = await cache.stats();
      expect(stats.corruptions).toBe(1);
      expect(await fsp.readFile(paths.vectorPath)).toHaveLength(4);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('bypasses both tiers when disabled for a lookup', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-bypass-');
    try {
      let calls = 0;
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'bypass me',
        embed: async () => [1],
      });
      const bypassed = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'bypass me',
        bypass: true,
        embed: async () => {
          calls += 1;
          return [7];
        },
      });
      expect(bypassed.status).toBe('bypass');
      expect(bypassed.embedding).toEqual([7]);
      expect(calls).toBe(1);
      expect((await cache.stats()).bypasses).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('parses KB_QUERY_CACHE=off aliases as disabled', () => {
    expect(isQueryCacheEnabled('')).toBe(true);
    expect(isQueryCacheEnabled('off')).toBe(false);
    expect(isQueryCacheEnabled(' FALSE ')).toBe(false);
    expect(isQueryCacheEnabled('0')).toBe(false);
    expect(isQueryCacheEnabled('on')).toBe(true);
  });

  it('treats a disabled cache instance like KB_QUERY_CACHE=off', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-env-off-');
    try {
      let calls = 0;
      const cache = new QueryEmbeddingCache({ indexPath, enabled: false, lruMax: 8 });
      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'env off',
        embed: async () => {
          calls += 1;
          return [1];
        },
      });
      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'env off',
        embed: async () => {
          calls += 1;
          return [2];
        },
      });
      expect(calls).toBe(2);
      const stats = await cache.stats();
      expect(stats.bypasses).toBe(2);
      expect(stats.hits).toBe(0);
      expect(stats.disk_size_bytes).toBe(0);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('normalizes queries with NFKC trim and whitespace collapse but preserves case', () => {
    expect(normalizeQueryForCache('  A\u00a0B\nC  ')).toBe('A B C');
    expect(normalizeQueryForCache('Case')).not.toBe(normalizeQueryForCache('case'));
  });
});
