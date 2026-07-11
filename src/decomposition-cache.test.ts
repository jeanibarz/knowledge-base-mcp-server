import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  DECOMPOSITION_CACHE_SCHEMA_VERSION,
  DiskTieredDecompositionCache,
  decompositionCacheKey,
  decompositionCacheRoot,
  isDecompositionCacheEnabled,
  normalizeDecompositionQuery,
  resolveDecompositionCacheDiskMaxBytes,
  resolveDecompositionCacheLruMax,
} from './decomposition-cache.js';

async function tempIndexPath(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, '.faiss');
}

describe('DiskTieredDecompositionCache (#736)', () => {
  it('persists successful subqueries and promotes disk hits into the bounded LRU', async () => {
    const indexPath = await tempIndexPath('kb-decomposition-cache-roundtrip-');
    try {
      const first = new DiskTieredDecompositionCache({ indexPath, enabled: true, lruMax: 1 });
      first.set('model-a', ' First   Query ', ['hop one', 'hop two']);

      const second = new DiskTieredDecompositionCache({ indexPath, enabled: true, lruMax: 1 });
      expect(second.get('model-a', 'first query')).toEqual(['hop one', 'hop two']);
      expect(second.stats()).toMatchObject({ disk_hits: 1, l1_hits: 0, l1_size: 1 });
      expect(second.get('model-a', ' first\nquery ')).toEqual(['hop one', 'hop two']);
      expect(second.stats().l1_hits).toBe(1);

      second.set('model-a', 'second query', ['other']);
      expect(second.stats().l1_size).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('normalizes query identity while isolating models and schema versions', async () => {
    const indexPath = await tempIndexPath('kb-decomposition-cache-key-');
    try {
      expect(normalizeDecompositionQuery('  A\u00a0B\nC  ')).toBe('a b c');
      expect(decompositionCacheKey('model-a', '  Query   Text ')).toBe(
        decompositionCacheKey('model-a', 'query text'),
      );
      expect(decompositionCacheKey('model-a', 'query')).not.toBe(
        decompositionCacheKey('model-b', 'query'),
      );
      const cache = new DiskTieredDecompositionCache({ indexPath, enabled: true });
      cache.set('model-a', 'query', ['hop']);
      expect(cache.get('model-b', 'query')).toBeNull();
      expect(DECOMPOSITION_CACHE_SCHEMA_VERSION).toBe('kb.search.query-decomposition.v1');
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('enforces the disk byte budget by evicting oldest entries', async () => {
    const indexPath = await tempIndexPath('kb-decomposition-cache-budget-');
    try {
      const probe = new DiskTieredDecompositionCache({ indexPath, enabled: true });
      probe.set('model', 'probe', ['probe result']);
      const entryBytes = probe.diskSizeBytes();
      await fsp.rm(decompositionCacheRoot(indexPath), { recursive: true, force: true });

      const cache = new DiskTieredDecompositionCache({
        indexPath,
        enabled: true,
        lruMax: 0,
        diskMaxBytes: Math.floor(entryBytes * 2.5),
      });
      cache.set('model', 'q1', ['one']);
      const q1Key = decompositionCacheKey('model', 'q1');
      const q1File = path.join(decompositionCacheRoot(indexPath), q1Key.slice(0, 2), `${q1Key}.json`);
      fs.utimesSync(q1File, new Date(1_000), new Date(1_000));
      cache.set('model', 'q2', ['two']);
      const q2Key = decompositionCacheKey('model', 'q2');
      const q2File = path.join(decompositionCacheRoot(indexPath), q2Key.slice(0, 2), `${q2Key}.json`);
      fs.utimesSync(q2File, new Date(2_000), new Date(2_000));
      cache.set('model', 'q3', ['three']);

      expect(cache.diskSizeBytes()).toBeLessThanOrEqual(Math.floor(entryBytes * 2.5));
      expect(cache.get('model', 'q1')).toBeNull();
      expect(cache.get('model', 'q3')).toEqual(['three']);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('rejects invalid or tampered records and removes them', async () => {
    const indexPath = await tempIndexPath('kb-decomposition-cache-corrupt-');
    try {
      const cache = new DiskTieredDecompositionCache({ indexPath, enabled: true, lruMax: 0 });
      const key = decompositionCacheKey('model', 'broken');
      const file = path.join(decompositionCacheRoot(indexPath), key.slice(0, 2), `${key}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schema_version: DECOMPOSITION_CACHE_SCHEMA_VERSION,
        model_id: 'model',
        normalized_query: 'broken',
        subqueries: ['poisoned'],
        subqueries_sha256: '0'.repeat(64),
      }));

      expect(cache.get('model', 'broken')).toBeNull();
      expect(cache.stats().corruptions).toBe(1);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('rejects disk records whose schema or identity does not match the key', async () => {
    const indexPath = await tempIndexPath('kb-decomposition-cache-identity-');
    try {
      for (const field of ['schema_version', 'model_id', 'normalized_query'] as const) {
        const cache = new DiskTieredDecompositionCache({ indexPath, enabled: true, lruMax: 0 });
        cache.set('model', field, ['hop']);
        const key = decompositionCacheKey('model', field);
        const file = path.join(decompositionCacheRoot(indexPath), key.slice(0, 2), `${key}.json`);
        const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
        record[field] = 'wrong';
        fs.writeFileSync(file, JSON.stringify(record), 'utf-8');

        expect(cache.get('model', field)).toBeNull();
        expect(fs.existsSync(file)).toBe(false);
      }
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('does not write disabled, empty, or invalid entries', async () => {
    const indexPath = await tempIndexPath('kb-decomposition-cache-disabled-');
    try {
      const disabled = new DiskTieredDecompositionCache({ indexPath, enabled: false });
      disabled.set('model', 'query', ['hop']);
      expect(disabled.get('model', 'query')).toBeNull();

      const enabled = new DiskTieredDecompositionCache({ indexPath, enabled: true });
      enabled.set('model', 'query', []);
      enabled.set('', 'query', ['hop']);
      expect(enabled.diskSizeBytes()).toBe(0);
      expect(fs.existsSync(decompositionCacheRoot(indexPath))).toBe(false);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('uses safe bounded defaults for malformed budgets', () => {
    expect(isDecompositionCacheEnabled(undefined)).toBe(false);
    expect(isDecompositionCacheEnabled('off')).toBe(false);
    expect(isDecompositionCacheEnabled(' TRUE ')).toBe(true);
    expect(isDecompositionCacheEnabled('1')).toBe(true);
    expect(resolveDecompositionCacheLruMax('12')).toBe(12);
    expect(resolveDecompositionCacheLruMax('0')).toBe(0);
    expect(resolveDecompositionCacheLruMax('-1')).toBe(256);
    expect(resolveDecompositionCacheLruMax('nope')).toBe(256);
    expect(resolveDecompositionCacheDiskMaxBytes('1024')).toBe(1024);
    expect(resolveDecompositionCacheDiskMaxBytes('0')).toBe(64 * 1024 * 1024);
    expect(resolveDecompositionCacheDiskMaxBytes('nope')).toBe(64 * 1024 * 1024);
  });
});
