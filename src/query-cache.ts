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

const DISK_SIZE_RECONCILE_INTERVAL = 64;

export type QueryCacheLookupStatus = 'hit_l1' | 'hit_disk' | 'miss' | 'bypass' | 'disabled';
export type QueryCacheOutcome = 'memory_hit' | 'disk_hit' | 'miss' | 'bypass' | 'disabled';

export interface QueryCacheTelemetry {
  enabled: boolean;
  outcome: QueryCacheOutcome;
  model_id: string;
  elapsed_ms: number;
}

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
  telemetry: QueryCacheTelemetry;
}

export interface QueryCacheOptions {
  indexPath?: string;
  enabled?: boolean;
  lruMax?: number;
  diskMaxBytes?: number;
  singleFlight?: boolean;
}

interface CacheMeta {
  schema_version: typeof QUERY_CACHE_SCHEMA_VERSION;
  model_id: string;
  dim: number;
  created_at: string;
  vector_sha256?: string;
}

interface DiskWriteResult {
  previousSize: number;
  size: number;
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
  private readonly singleFlight: boolean;
  private readonly l1: LruVectorCache;
  private readonly inFlight = new Map<string, Promise<number[]>>();
  private diskWriteQueue: Promise<void> = Promise.resolve();
  private diskBytes: number | undefined;
  private diskSizeInitialization: Promise<void> | undefined;
  private writesSinceReconcile = 0;
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
    this.singleFlight = options.singleFlight ?? false;
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
    const startedAt = Date.now();
    const record = (
      embedding: number[],
      status: QueryCacheLookupStatus,
      outcome: QueryCacheOutcome,
      enabled: boolean = this.enabled,
    ): QueryCacheRecord => ({
      embedding,
      status,
      telemetry: {
        enabled,
        outcome,
        model_id: args.modelId,
        elapsed_ms: Date.now() - startedAt,
      },
    });

    if (!this.enabled) {
      this.bypasses += 1;
      return record(await args.embed(), 'disabled', 'disabled', false);
    }

    if (args.bypass === true) {
      this.bypasses += 1;
      return record(await args.embed(), 'bypass', 'bypass');
    }

    const paths = queryCachePaths({
      indexPath: this.indexPath,
      modelId: args.modelId,
      query: args.query,
    });

    const memoryHit = this.l1.get(paths.cacheKey);
    if (memoryHit !== null) {
      this.hitsL1 += 1;
      return record(memoryHit, 'hit_l1', 'memory_hit');
    }

    const diskHit = await this.readDisk(paths);
    if (diskHit !== null) {
      this.hitsDisk += 1;
      this.l1.set(paths.cacheKey, diskHit);
      return record(diskHit.slice(), 'hit_disk', 'disk_hit');
    }

    this.misses += 1;
    let pending = this.singleFlight ? this.inFlight.get(paths.cacheKey) : undefined;
    const ownsFlight = pending === undefined;
    if (pending === undefined) {
      pending = (async () => {
        const embedding = await args.embed();
        const stableEmbedding = toFloat32Numbers(embedding);
        this.l1.set(paths.cacheKey, stableEmbedding);
        try {
          await this.withDiskWriteQueue(async () => {
            await this.ensureDiskSize();
            const write = await this.writeDisk(paths, stableEmbedding);
            this.writes += 1;
            this.applyDiskWrite(write);
            await this.enforceDiskLimit();
          });
        } catch (err) {
          this.diskBytes = undefined;
          logger.warn(`query embedding cache write skipped for ${args.modelId}: ${(err as Error).message}`);
        }
        return stableEmbedding;
      })();
      if (this.singleFlight) this.inFlight.set(paths.cacheKey, pending);
    }
    try {
      return record(await pending, 'miss', 'miss');
    } finally {
      if (this.singleFlight && ownsFlight) this.inFlight.delete(paths.cacheKey);
    }
  }

  async stats(): Promise<QueryCacheStats> {
    await this.diskWriteQueue;
    await this.ensureDiskSize();
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
      disk_size_bytes: this.diskBytes ?? 0,
    };
  }

  private async readDisk(paths: QueryCachePaths): Promise<number[] | null> {
    let meta: CacheMeta;
    let raw: string;
    try {
      raw = await fsp.readFile(paths.metaPath, 'utf-8');
    } catch {
      // A read failure may be transient; keep the entry for a later attempt.
      return null;
    }
    try {
      meta = JSON.parse(raw) as CacheMeta;
    } catch {
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
    } catch {
      // A read failure may be transient; keep the entry for a later attempt.
      return null;
    }
    if (buffer.byteLength !== meta.dim * 4) {
      await this.recordCorrupt(paths);
      return null;
    }
    if (meta.vector_sha256 !== undefined) {
      if (!isSha256Hex(meta.vector_sha256) || sha256Buffer(buffer) !== meta.vector_sha256) {
        await this.recordCorrupt(paths);
        return null;
      }
    }
    const out: number[] = [];
    for (let offset = 0; offset < buffer.byteLength; offset += 4) {
      const value = buffer.readFloatLE(offset);
      if (!Number.isFinite(value)) {
        await this.recordCorrupt(paths);
        return null;
      }
      out.push(value);
    }
    return out;
  }

  private async writeDisk(paths: QueryCachePaths, embedding: readonly number[]): Promise<DiskWriteResult> {
    await fsp.mkdir(paths.modelCacheDir, { recursive: true });
    const release = await properLockfile.lock(paths.modelCacheDir, {
      lockfilePath: path.join(paths.modelCacheDir, '.kb-query-cache.lock'),
      stale: 30_000,
      retries: { retries: 5, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
    });
    const vectorTmp = `${paths.vectorPath}.${process.pid}.${Date.now()}.tmp`;
    const metaTmp = `${paths.metaPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const previousSize = await fileSizeIfPresent(paths.vectorPath);
      const buffer = Buffer.allocUnsafe(embedding.length * 4);
      embedding.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
      const meta: CacheMeta = {
        schema_version: QUERY_CACHE_SCHEMA_VERSION,
        model_id: paths.modelId,
        dim: embedding.length,
        created_at: new Date().toISOString(),
        vector_sha256: sha256Buffer(buffer),
      };
      await fsp.writeFile(vectorTmp, buffer);
      await fsp.rename(vectorTmp, paths.vectorPath);
      await fsp.writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
      await fsp.rename(metaTmp, paths.metaPath);
      return { previousSize, size: buffer.byteLength };
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
    this.diskBytes = undefined;
    await Promise.all([
      fsp.unlink(paths.vectorPath).catch(() => undefined),
      fsp.unlink(paths.metaPath).catch(() => undefined),
    ]);
  }

  private async enforceDiskLimit(): Promise<void> {
    if (this.diskMaxBytes <= 0) return;
    if (this.diskBytes === undefined || this.writesSinceReconcile >= DISK_SIZE_RECONCILE_INTERVAL) {
      await this.reconcileDiskSize();
    }
    if (this.diskBytes === undefined || this.diskBytes <= this.diskMaxBytes) return;

    const files = await listCacheVectorFiles(queryCacheRoot(this.indexPath));
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= this.diskMaxBytes) break;
      const vectorRemoved = await fsp.unlink(file.path).then(
        () => true,
        (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
      );
      if (!vectorRemoved) continue;
      await fsp.unlink(file.path.replace(/\.f32$/, '.meta.json')).catch(() => undefined);
      total -= file.size;
    }
    this.diskBytes = total;
    this.writesSinceReconcile = 0;
  }

  private async withDiskWriteQueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.diskWriteQueue;
    let release!: () => void;
    this.diskWriteQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private applyDiskWrite(write: DiskWriteResult): void {
    if (this.diskBytes !== undefined) {
      this.diskBytes += write.size - write.previousSize;
    }
    this.writesSinceReconcile += 1;
  }

  private async ensureDiskSize(): Promise<void> {
    if (this.diskBytes !== undefined) return;
    if (this.diskSizeInitialization === undefined) {
      this.diskSizeInitialization = this.reconcileDiskSize().finally(() => {
        this.diskSizeInitialization = undefined;
      });
    }
    await this.diskSizeInitialization;
  }

  private async reconcileDiskSize(): Promise<void> {
    try {
      this.diskBytes = await queryCacheDiskSizeBytes(this.indexPath);
      this.writesSinceReconcile = 0;
    } catch (err) {
      this.diskBytes = undefined;
      logger.warn(`query embedding cache size reconciliation skipped: ${(err as Error).message}`);
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

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

async function fileSizeIfPresent(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
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
