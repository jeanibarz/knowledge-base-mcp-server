import { describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import fspDefault from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  QueryEmbeddingCache,
  normalizeQueryForCache,
  queryCachePaths,
  queryCacheDiskSizeBytes,
} from './query-cache.js';
import { isQueryCacheEnabled } from './config/cache.js';

async function tempIndexPath(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, '.faiss');
}

function vectorBuffer(values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('query embedding cache (#214)', () => {
  const itPosixNonRoot =
    process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
      ? it.skip
      : it;

  it('coalesces concurrent identical misses when single-flight is enabled', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-single-flight-');
    try {
      let calls = 0;
      let release!: (embedding: number[]) => void;
      const pending = new Promise<number[]>((resolve) => {
        release = resolve;
      });
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8, singleFlight: true });
      const embed = async (): Promise<number[]> => {
        calls += 1;
        return pending;
      };

      const first = cache.getOrCompute({ modelId: 'fake__one', query: 'same query', embed });
      const second = cache.getOrCompute({ modelId: 'fake__one', query: 'same query', embed });
      await new Promise((resolve) => setImmediate(resolve));
      release([1.25, 2.5]);

      const results = await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect(results.map((result) => result.embedding)).toEqual([[1.25, 2.5], [1.25, 2.5]]);

      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'same query' });
      cache.clearMemory();
      await Promise.all([fsp.unlink(paths.metaPath), fsp.unlink(paths.vectorPath)]);
      await cache.getOrCompute({ modelId: 'fake__one', query: 'same query', embed });
      expect(calls).toBe(2);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('leaves concurrent identical misses independent by default', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-single-flight-off-');
    try {
      let calls = 0;
      let release!: (embedding: number[]) => void;
      let markBothStarted!: () => void;
      const pending = new Promise<number[]>((resolve) => {
        release = resolve;
      });
      const bothStarted = new Promise<void>((resolve) => {
        markBothStarted = resolve;
      });
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const embed = async (): Promise<number[]> => {
        calls += 1;
        if (calls === 2) markBothStarted();
        return pending;
      };

      const first = cache.getOrCompute({ modelId: 'fake__one', query: 'same query', embed });
      const second = cache.getOrCompute({ modelId: 'fake__one', query: 'same query', embed });
      await bothStarted;
      release([1, 2]);
      await Promise.all([first, second]);
      expect(calls).toBe(2);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('clears a rejected single-flight so the next call can retry', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-single-flight-reject-');
    try {
      let calls = 0;
      let reject!: (error: Error) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const pending = new Promise<number[]>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8, singleFlight: true });
      const embed = async (): Promise<number[]> => {
        calls += 1;
        if (calls === 1) {
          markStarted();
          return pending;
        }
        return [3, 4];
      };

      const first = cache.getOrCompute({ modelId: 'fake__one', query: 'retry me', embed });
      const second = cache.getOrCompute({ modelId: 'fake__one', query: 'retry me', embed });
      await started;
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toBe(1);
      reject(new Error('transient failure'));
      await expect(Promise.all([first, second])).rejects.toThrow('transient failure');
      await expect(cache.getOrCompute({ modelId: 'fake__one', query: 'retry me', embed }))
        .resolves.toMatchObject({ embedding: [3, 4], status: 'miss' });
      expect(calls).toBe(2);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('does not coalesce bypassed or disabled lookups', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-single-flight-exclusions-');
    try {
      for (const options of [
        { singleFlight: true },
        { singleFlight: true, enabled: false },
      ]) {
        let calls = 0;
        const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8, ...options });
        const embed = async (): Promise<number[]> => {
          calls += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return [calls];
        };
        await Promise.all([
          cache.getOrCompute({ modelId: 'fake__one', query: 'excluded', bypass: true, embed }),
          cache.getOrCompute({ modelId: 'fake__one', query: 'excluded', bypass: true, embed }),
        ]);
        expect(calls).toBe(2);
      }
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

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
      expect((await first.stats()).corruptions).toBe(0);
      expect(miss.telemetry).toMatchObject({
        enabled: true,
        outcome: 'miss',
        model_id: 'fake__one',
      });
      expect(typeof miss.telemetry.elapsed_ms).toBe('number');
      expect(calls).toBe(1);

      const memoryHit = await first.getOrCompute({
        modelId: 'fake__one',
        query: 'hello world',
        embed: async () => {
          calls += 1;
          return [8, 8, 8];
        },
      });
      expect(memoryHit.status).toBe('hit_l1');
      expect(memoryHit.telemetry).toMatchObject({
        enabled: true,
        outcome: 'memory_hit',
        model_id: 'fake__one',
      });
      expect(memoryHit.embedding).toEqual([1.25, 2.5, 3.75]);
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
      expect(hit.telemetry.outcome).toBe('disk_hit');
      expect(hit.embedding).toEqual([1.25, 2.5, 3.75]);
      expect(calls).toBe(1);

      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'hello world' });
      const meta = JSON.parse(await fsp.readFile(paths.metaPath, 'utf-8')) as { vector_sha256?: string };
      expect(meta.vector_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.vector_sha256).toBe(sha256(await fsp.readFile(paths.vectorPath)));
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('does not rescan the disk tree for each hot-path miss write', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-amortized-');
    const readdirSpy = jest.spyOn(fspDefault, 'readdir');
    try {
      await fsp.mkdir(path.join(indexPath, 'cache', 'queries', 'fake__one'), { recursive: true });
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 0 });

      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'first',
        embed: async () => [1, 2],
      });
      const scansAfterFirstWrite = readdirSpy.mock.calls.length;

      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'second',
        embed: async () => [3, 4],
      });

      expect(readdirSpy.mock.calls.length).toBe(scansAfterFirstWrite);
    } finally {
      readdirSpy.mockRestore();
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('keeps incremental byte accounting aligned with a ground-truth rescan', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-accounting-');
    try {
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 0 });
      for (const [query, embedding] of [
        ['first', [1, 2]],
        ['second', [3, 4, 5]],
        ['third', [6]],
      ] as const) {
        await cache.getOrCompute({
          modelId: 'fake__one',
          query,
          embed: async () => Array.from(embedding),
        });
        expect((await cache.stats()).disk_size_bytes).toBe(await queryCacheDiskSizeBytes(indexPath));
      }
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('enforces the disk byte cap while maintaining incremental accounting', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-evict-');
    try {
      const probe = new QueryEmbeddingCache({ indexPath, lruMax: 0 });
      await probe.getOrCompute({
        modelId: 'fake__one',
        query: 'probe',
        embed: async () => [0.1, 0.2, 0.3],
      });
      const entryBytes = await queryCacheDiskSizeBytes(indexPath);
      expect(entryBytes).toBeGreaterThan(0);
      await fsp.rm(path.join(indexPath, 'cache', 'queries'), { recursive: true, force: true });

      const cache = new QueryEmbeddingCache({
        indexPath,
        lruMax: 0,
        diskMaxBytes: Math.floor(entryBytes * 2.5),
      });
      for (const [query, embedding] of [
        ['q1', [0.11, 0.12, 0.13]],
        ['q2', [0.21, 0.22, 0.23]],
        ['q3', [0.31, 0.32, 0.33]],
      ] as const) {
        await cache.getOrCompute({
          modelId: 'fake__one',
          query,
          embed: async () => Array.from(embedding),
        });
        expect((await cache.stats()).disk_size_bytes).toBe(await queryCacheDiskSizeBytes(indexPath));
      }

      expect((await cache.stats()).disk_size_bytes).toBeLessThanOrEqual(Math.floor(entryBytes * 2.5));
      await expect(cache.getOrCompute({
        modelId: 'fake__one',
        query: 'q1',
        embed: async () => [9, 9, 9],
      })).resolves.toMatchObject({ status: 'miss' });
      await expect(cache.getOrCompute({
        modelId: 'fake__one',
        query: 'q3',
        embed: async () => {
          throw new Error('q3 should remain cached');
        },
      })).resolves.toMatchObject({ status: 'hit_disk' });
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
      expect(again.telemetry.outcome).toBe('disk_hit');
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

  itPosixNonRoot('TS-CACHE-830: treats transient metadata read errors as misses without evicting the entry', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-transient-read-');
    try {
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'transient',
        embed: async () => [1, 2],
      });
      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'transient' });
      const originalMeta = await fsp.readFile(paths.metaPath);
      const originalVector = await fsp.readFile(paths.vectorPath);
      cache.clearMemory();
      await fsp.chmod(paths.metaPath, 0o000);
      try {
        let embedCalls = 0;
        await expect(cache.getOrCompute({
          modelId: 'fake__one',
          query: 'transient',
          embed: async () => {
            embedCalls += 1;
            throw new Error('embedding unavailable');
          },
        })).rejects.toThrow('embedding unavailable');
        expect(embedCalls).toBe(1);
        expect((await cache.stats()).corruptions).toBe(0);
      } finally {
        if (await fsp.access(paths.metaPath).then(() => true).catch(() => false)) {
          await fsp.chmod(paths.metaPath, 0o600);
        }
      }
      expect(await fsp.readFile(paths.metaPath)).toEqual(originalMeta);
      expect(await fsp.readFile(paths.vectorPath)).toEqual(originalVector);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  itPosixNonRoot('TS-CACHE-830: treats transient vector read errors as misses without evicting the entry', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-transient-vector-read-');
    try {
      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'transient vector',
        embed: async () => [1, 2],
      });
      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'transient vector' });
      const originalMeta = await fsp.readFile(paths.metaPath);
      const originalVector = await fsp.readFile(paths.vectorPath);
      cache.clearMemory();
      await fsp.chmod(paths.vectorPath, 0o000);
      try {
        let embedCalls = 0;
        await expect(cache.getOrCompute({
          modelId: 'fake__one',
          query: 'transient vector',
          embed: async () => {
            embedCalls += 1;
            throw new Error('embedding unavailable');
          },
        })).rejects.toThrow('embedding unavailable');
        expect(embedCalls).toBe(1);
        expect((await cache.stats()).corruptions).toBe(0);
      } finally {
        if (await fsp.access(paths.vectorPath).then(() => true).catch(() => false)) {
          await fsp.chmod(paths.vectorPath, 0o600);
        }
      }
      expect(await fsp.readFile(paths.metaPath)).toEqual(originalMeta);
      expect(await fsp.readFile(paths.vectorPath)).toEqual(originalVector);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('treats checksum mismatches as corrupt disk entries', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-checksum-');
    try {
      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'tampered' });
      const buffer = vectorBuffer([1, 2]);
      await fsp.mkdir(paths.modelCacheDir, { recursive: true });
      await fsp.writeFile(paths.vectorPath, buffer);
      await fsp.writeFile(paths.metaPath, JSON.stringify({
        schema_version: 'kb-query-cache.v1',
        model_id: 'fake__one',
        dim: 2,
        created_at: new Date().toISOString(),
        vector_sha256: sha256(vectorBuffer([9, 9])),
      }));

      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const result = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'tampered',
        embed: async () => [7, 8],
      });

      expect(result.status).toBe('miss');
      expect(result.embedding).toEqual([7, 8]);
      expect((await cache.stats()).corruptions).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('treats non-finite vector bytes as corrupt disk entries', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-non-finite-');
    try {
      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'nan' });
      const buffer = vectorBuffer([1, Number.NaN]);
      await fsp.mkdir(paths.modelCacheDir, { recursive: true });
      await fsp.writeFile(paths.vectorPath, buffer);
      await fsp.writeFile(paths.metaPath, JSON.stringify({
        schema_version: 'kb-query-cache.v1',
        model_id: 'fake__one',
        dim: 2,
        created_at: new Date().toISOString(),
        vector_sha256: sha256(buffer),
      }));

      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const result = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'nan',
        embed: async () => [3, 4],
      });

      expect(result.status).toBe('miss');
      expect(result.embedding).toEqual([3, 4]);
      expect((await cache.stats()).corruptions).toBe(1);
    } finally {
      await fsp.rm(path.dirname(indexPath), { recursive: true, force: true });
    }
  });

  it('keeps reading valid old disk records that do not have checksums', async () => {
    const indexPath = await tempIndexPath('kb-query-cache-old-meta-');
    try {
      const paths = queryCachePaths({ indexPath, modelId: 'fake__one', query: 'legacy' });
      await fsp.mkdir(paths.modelCacheDir, { recursive: true });
      await fsp.writeFile(paths.vectorPath, vectorBuffer([5, 6]));
      await fsp.writeFile(paths.metaPath, JSON.stringify({
        schema_version: 'kb-query-cache.v1',
        model_id: 'fake__one',
        dim: 2,
        created_at: new Date().toISOString(),
      }));

      const cache = new QueryEmbeddingCache({ indexPath, lruMax: 8 });
      const result = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'legacy',
        embed: async () => [9, 9],
      });

      expect(result.status).toBe('hit_disk');
      expect(result.embedding).toEqual([5, 6]);
      const stats = await cache.stats();
      expect(stats.disk_hits).toBe(1);
      expect(stats.corruptions).toBe(0);
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
      expect(bypassed.telemetry).toMatchObject({
        enabled: true,
        outcome: 'bypass',
        model_id: 'fake__one',
      });
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
      const first = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'env off',
        embed: async () => {
          calls += 1;
          return [1];
        },
      });
      const second = await cache.getOrCompute({
        modelId: 'fake__one',
        query: 'env off',
        embed: async () => {
          calls += 1;
          return [2];
        },
      });
      expect(first.status).toBe('disabled');
      expect(second.telemetry).toMatchObject({
        enabled: false,
        outcome: 'disabled',
        model_id: 'fake__one',
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
