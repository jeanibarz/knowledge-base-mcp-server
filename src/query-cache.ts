import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import {
  FAISS_INDEX_PATH,
} from './config/paths.js';
import {
  KB_QUERY_CACHE_DISK_MAX_BYTES,
  KB_QUERY_CACHE_ENABLED,
  KB_QUERY_CACHE_LRU_MAX,
} from './config/cache.js';
import { pathExists } from './file-utils.js';
import { logger } from './logger.js';
import { isValidModelId } from './model-id.js';

export const QUERY_CACHE_SCHEMA_VERSION = 'kb-query-cache.v1';

export type QueryCacheLookupStatus = 'hit_l1' | 'hit_disk' | 'miss' | 'bypass';

export interface QueryCacheStats {
  hits: number;
  misses: number;
  hit_ratio: number;
  l1_hits: number;
  disk_hits: number;
  bypasses: number;
  writes: number;
  corruptions: number;
  l1_size: number;
  disk_size_bytes: number;
}

interface QueryCacheRecord {
  embedding: number[];
  status: QueryCacheLookupStatus;
}

export interface QueryCacheOptions {
  indexPath?: string;
  enabled?: boolean;
  lruMax?: number;
  diskMaxBytes?: number;
}

interface CacheMeta {
  schema_version: typeof QUERY_CACHE_SCHEMA_VERSION;
  model_id: string;
  dim: number;
  created_at: string;
}

class LruVectorCache {
  private readonly values = new Map<string, number[]>();
  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  get(key: string): number[] | null {
    const value = this.values.get(key);
    if (value === undefined) return null;
    this.values.delete(key);
    this.values.set(key, value);
    return value.slice();
  }

  set(key: string, value: readonly number[]): void {
    if (this.maxEntries <= 0) return;
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, Array.from(value));
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

export class QueryEmbeddingCache {
  private readonly indexPath: string;
  private readonly enabled: boolean;
  private readonly diskMaxBytes: number;
  private readonly l1: LruVectorCache;
  private hitsL1 = 0;
  private hitsDisk = 0;
  private misses = 0;
  private bypasses = 0;
  private writes = 0;
  private corruptions = 0;

  constructor(options: QueryCacheOptions = {}) {
    this.indexPath = options.indexPath ?? FAISS_INDEX_PATH;
    this.enabled = options.enabled ?? KB_QUERY_CACHE_ENABLED;
    this.diskMaxBytes = options.diskMaxBytes ?? KB_QUERY_CACHE_DISK_MAX_BYTES;
    this.l1 = new LruVectorCache(options.lruMax ?? KB_QUERY_CACHE_LRU_MAX);
  }

  clearMemory(): void {
    this.l1.clear();
  }

  async getOrCompute(args: {
    modelId: string;
    query: string;
    bypass?: boolean;
    embed: () => Promise<number[]>;
  }): Promise<QueryCacheRecord> {
    if (args.bypass === true || !this.enabled) {
      this.bypasses += 1;
      return { embedding: await args.embed(), status: 'bypass' };
    }

    const paths = queryCachePaths({
      indexPath: this.indexPath,
      modelId: args.modelId,
      query: args.query,
    });

    const memoryHit = this.l1.get(paths.cacheKey);
    if (memoryHit !== null) {
      this.hitsL1 += 1;
      return { embedding: memoryHit, status: 'hit_l1' };
    }

    const diskHit = await this.readDisk(paths);
    if (diskHit !== null) {
      this.hitsDisk += 1;
      this.l1.set(paths.cacheKey, diskHit);
      return { embedding: diskHit.slice(), status: 'hit_disk' };
    }

    this.misses += 1;
    const embedding = await args.embed();
    const stableEmbedding = toFloat32Numbers(embedding);
    this.l1.set(paths.cacheKey, stableEmbedding);
    try {
      await this.writeDisk(paths, stableEmbedding);
      this.writes += 1;
      await this.enforceDiskLimit();
    } catch (err) {
      logger.warn(`query embedding cache write skipped for ${args.modelId}: ${(err as Error).message}`);
    }
    return { embedding: stableEmbedding, status: 'miss' };
  }

  async stats(): Promise<QueryCacheStats> {
    const hits = this.hitsL1 + this.hitsDisk;
    const misses = this.misses;
    const total = hits + misses;
    return {
      hits,
      misses,
      hit_ratio: total === 0 ? 0 : hits / total,
      l1_hits: this.hitsL1,
      disk_hits: this.hitsDisk,
      bypasses: this.bypasses,
      writes: this.writes,
      corruptions: this.corruptions,
      l1_size: this.l1.size,
      disk_size_bytes: await queryCacheDiskSizeBytes(this.indexPath),
    };
  }

  private async readDisk(paths: QueryCachePaths): Promise<number[] | null> {
    let meta: CacheMeta;
    try {
      const raw = await fsp.readFile(paths.metaPath, 'utf-8');
      meta = JSON.parse(raw) as CacheMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      await this.recordCorrupt(paths);
      return null;
    }
    if (
      meta.schema_version !== QUERY_CACHE_SCHEMA_VERSION ||
      meta.model_id !== paths.modelId ||
      !Number.isInteger(meta.dim) ||
      meta.dim <= 0
    ) {
      await this.recordCorrupt(paths);
      return null;
    }

    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(paths.vectorPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      await this.recordCorrupt(paths);
      return null;
    }
    if (buffer.byteLength !== meta.dim * 4) {
      await this.recordCorrupt(paths);
      return null;
    }
    const out: number[] = [];
    for (let offset = 0; offset < buffer.byteLength; offset += 4) {
      out.push(buffer.readFloatLE(offset));
    }
    return out;
  }

  private async writeDisk(paths: QueryCachePaths, embedding: readonly number[]): Promise<void> {
    await fsp.mkdir(paths.modelCacheDir, { recursive: true });
    const release = await properLockfile.lock(paths.modelCacheDir, {
      lockfilePath: path.join(paths.modelCacheDir, '.kb-query-cache.lock'),
      stale: 30_000,
      retries: { retries: 5, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
    });
    const vectorTmp = `${paths.vectorPath}.${process.pid}.${Date.now()}.tmp`;
    const metaTmp = `${paths.metaPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const buffer = Buffer.allocUnsafe(embedding.length * 4);
      embedding.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
      const meta: CacheMeta = {
        schema_version: QUERY_CACHE_SCHEMA_VERSION,
        model_id: paths.modelId,
        dim: embedding.length,
        created_at: new Date().toISOString(),
      };
      await fsp.writeFile(vectorTmp, buffer);
      await fsp.rename(vectorTmp, paths.vectorPath);
      await fsp.writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
      await fsp.rename(metaTmp, paths.metaPath);
    } finally {
      await Promise.all([
        fsp.unlink(vectorTmp).catch(() => undefined),
        fsp.unlink(metaTmp).catch(() => undefined),
      ]);
      await release().catch((err) => {
        logger.warn(`query embedding cache lock release failed: ${(err as Error).message}`);
      });
    }
  }

  private async recordCorrupt(paths: QueryCachePaths): Promise<void> {
    this.corruptions += 1;
    await Promise.all([
      fsp.unlink(paths.vectorPath).catch(() => undefined),
      fsp.unlink(paths.metaPath).catch(() => undefined),
    ]);
  }

  private async enforceDiskLimit(): Promise<void> {
    if (this.diskMaxBytes <= 0) return;
    const root = queryCacheRoot(this.indexPath);
    const files = await listCacheVectorFiles(root);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.diskMaxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= this.diskMaxBytes) break;
      await fsp.unlink(file.path).catch(() => undefined);
      await fsp.unlink(file.path.replace(/\.f32$/, '.meta.json')).catch(() => undefined);
      total -= file.size;
    }
  }
}

interface QueryCachePaths {
  indexPath: string;
  modelId: string;
  normalizedQuery: string;
  cacheKey: string;
  modelCacheDir: string;
  vectorPath: string;
  metaPath: string;
}

export function normalizeQueryForCache(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function queryCachePaths(args: {
  indexPath?: string;
  modelId: string;
  query: string;
}): QueryCachePaths {
  if (!isValidModelId(args.modelId)) {
    throw new Error(`invalid query-cache model_id: ${args.modelId}`);
  }
  const indexPath = args.indexPath ?? FAISS_INDEX_PATH;
  const normalizedQuery = normalizeQueryForCache(args.query);
  const cacheKey = crypto
    .createHash('sha256')
    .update(QUERY_CACHE_SCHEMA_VERSION)
    .update('\x1f')
    .update(args.modelId)
    .update('\x1f')
    .update(normalizedQuery)
    .digest('hex');
  const modelCacheDir = path.join(queryCacheRoot(indexPath), args.modelId);
  return {
    indexPath,
    modelId: args.modelId,
    normalizedQuery,
    cacheKey,
    modelCacheDir,
    vectorPath: path.join(modelCacheDir, `${cacheKey}.f32`),
    metaPath: path.join(modelCacheDir, `${cacheKey}.meta.json`),
  };
}

export async function queryCacheDiskSizeBytes(indexPath: string = FAISS_INDEX_PATH): Promise<number> {
  const files = await listCacheVectorFiles(queryCacheRoot(indexPath));
  return files.reduce((sum, file) => sum + file.size, 0);
}

export function __resetQueryEmbeddingCacheForTests(): void {
  queryEmbeddingCache.clearMemory();
}

export const queryEmbeddingCache = new QueryEmbeddingCache();

function queryCacheRoot(indexPath: string): string {
  return path.join(indexPath, 'cache', 'queries');
}

function toFloat32Numbers(values: readonly number[]): number[] {
  return Array.from(Float32Array.from(values));
}

async function listCacheVectorFiles(root: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  if (!(await pathExists(root))) return [];
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await Promise.all(entries.map(async (entry) => {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.f32')) return;
      try {
        const st = await fsp.stat(child);
        out.push({ path: child, size: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }));
  }
  await walk(root);
  return out;
}
