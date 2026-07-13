import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FAISS_INDEX_PATH } from './config/paths.js';
import {
  KB_RERANK_CACHE_DISK_MAX_BYTES,
  KB_RERANK_CACHE_ENABLED,
} from './config/reranker.js';
import { logger } from './logger.js';
import type { RerankScoreCache } from './reranker.js';

// Disk-tiered persistent rerank-score cache (#646). Mirrors the two-tier
// query embedding cache (src/query-cache.ts, ADR 0009): an in-memory LRU L1
// in front of a content-addressed disk tier so cross-encoder scores survive
// process exit and are reused across cold `kb` CLI invocations.
//
// The RerankScoreCache interface (src/reranker.ts) is SYNCHRONOUS — it is
// consulted on the hot path of rerankFusedResults without awaiting — so the
// disk tier uses synchronous fs calls (atomic write-then-rename). Scores are
// tiny scalars, so a per-entry JSON file keeps each write/read cheap and makes
// size-bound eviction a simple oldest-file sweep.

export const RERANK_SCORE_CACHE_SCHEMA_VERSION = 'kb-rerank-score-cache.v1';

export const DEFAULT_RERANK_CACHE_L1_MAX = 4096;

const DISK_SIZE_RECONCILE_INTERVAL = 64;

export interface DiskTieredRerankScoreCacheOptions {
  indexPath?: string;
  enabled?: boolean;
  l1Max?: number;
  diskMaxBytes?: number;
}

export interface RerankScoreCacheStats {
  enabled: boolean;
  l1_hits: number;
  disk_hits: number;
  misses: number;
  writes: number;
  corruptions: number;
  l1_size: number;
  disk_size_bytes: number;
}

interface RerankScoreRecord {
  schema_version: typeof RERANK_SCORE_CACHE_SCHEMA_VERSION;
  score: number;
}

interface DiskWriteResult {
  previousSize: number;
  size: number;
}

/**
 * Normalize a query for cache-key derivation. Matches the in-memory cache's
 * normalization (trim, collapse whitespace, lower-case) plus NFKC so that
 * unicode-equivalent queries share a key, consistent with the query cache.
 */
export function normalizeRerankQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Content-addressed key: sha256(schema | model | normalizedQuery |
 * sha256(candidateText)). The candidate text is pre-hashed so arbitrarily long
 * passages do not bloat the digest input, and the model id is included so a
 * reranker model change never serves stale scores.
 */
export function rerankScoreCacheKey(modelId: string, query: string, candidateText: string): string {
  return createHash('sha256')
    .update(RERANK_SCORE_CACHE_SCHEMA_VERSION)
    .update('\x1f')
    .update(modelId)
    .update('\x1f')
    .update(normalizeRerankQuery(query))
    .update('\x1f')
    .update(createHash('sha256').update(candidateText, 'utf-8').digest('hex'))
    .digest('hex');
}

export function rerankScoreCacheRoot(indexPath: string = FAISS_INDEX_PATH): string {
  return path.join(indexPath, 'cache', 'rerank-scores');
}

export class DiskTieredRerankScoreCache implements RerankScoreCache {
  private readonly enabled: boolean;
  private readonly cacheRoot: string;
  private readonly diskMaxBytes: number;
  private readonly l1Max: number;
  private readonly l1 = new Map<string, number>();
  private diskBytes: number | undefined;
  private writesSinceReconcile = 0;
  private l1Hits = 0;
  private diskHits = 0;
  private misses = 0;
  private writes = 0;
  private corruptions = 0;

  constructor(options: DiskTieredRerankScoreCacheOptions = {}) {
    this.enabled = options.enabled ?? KB_RERANK_CACHE_ENABLED;
    this.cacheRoot = rerankScoreCacheRoot(options.indexPath ?? FAISS_INDEX_PATH);
    this.diskMaxBytes = options.diskMaxBytes ?? KB_RERANK_CACHE_DISK_MAX_BYTES;
    this.l1Max = options.l1Max ?? DEFAULT_RERANK_CACHE_L1_MAX;
    this.diskBytes = this.reconcileDiskSize();
  }

  get(modelId: string, query: string, candidateText: string): number | null {
    if (!this.enabled) return null;
    const key = rerankScoreCacheKey(modelId, query, candidateText);
    const memoryHit = this.l1.get(key);
    if (memoryHit !== undefined) {
      // LRU bump.
      this.l1.delete(key);
      this.l1.set(key, memoryHit);
      this.l1Hits += 1;
      return memoryHit;
    }
    const diskHit = this.readDisk(key);
    if (diskHit !== null) {
      this.diskHits += 1;
      this.l1Set(key, diskHit);
      return diskHit;
    }
    this.misses += 1;
    return null;
  }

  set(modelId: string, query: string, candidateText: string, score: number): void {
    if (!this.enabled) return;
    if (!Number.isFinite(score)) return;
    const key = rerankScoreCacheKey(modelId, query, candidateText);
    this.l1Set(key, score);
    try {
      const write = this.writeDisk(key, score);
      this.writes += 1;
      this.applyDiskWrite(write);
      this.enforceDiskLimit();
    } catch (err) {
      this.diskBytes = undefined;
      logger.warn(`rerank score cache write skipped: ${(err as Error).message}`);
    }
  }

  clearMemory(): void {
    this.l1.clear();
  }

  stats(): RerankScoreCacheStats {
    return {
      enabled: this.enabled,
      l1_hits: this.l1Hits,
      disk_hits: this.diskHits,
      misses: this.misses,
      writes: this.writes,
      corruptions: this.corruptions,
      l1_size: this.l1.size,
      disk_size_bytes: this.diskSizeBytes(),
    };
  }

  diskSizeBytes(): number {
    if (this.diskBytes === undefined) this.diskBytes = this.reconcileDiskSize();
    return this.diskBytes ?? 0;
  }

  private l1Set(key: string, value: number): void {
    if (this.l1Max <= 0) return;
    if (this.l1.has(key)) this.l1.delete(key);
    this.l1.set(key, value);
    while (this.l1.size > this.l1Max) {
      const oldest = this.l1.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.l1.delete(oldest);
    }
  }

  private entryPath(key: string): string {
    // Shard by the first two hex chars (256-way fan-out) so a single directory
    // never accumulates millions of entries — the same content-addressing
    // discipline git uses for loose objects.
    return path.join(this.cacheRoot, key.slice(0, 2), `${key}.json`);
  }

  private readDisk(key: string): number | null {
    const file = this.entryPath(key);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      // A read failure may be transient; keep the entry for a later attempt.
      return null;
    }
    let record: RerankScoreRecord;
    try {
      record = JSON.parse(raw) as RerankScoreRecord;
    } catch {
      this.recordCorrupt(file);
      return null;
    }
    if (
      record === null ||
      typeof record !== 'object' ||
      record.schema_version !== RERANK_SCORE_CACHE_SCHEMA_VERSION ||
      typeof record.score !== 'number' ||
      !Number.isFinite(record.score)
    ) {
      this.recordCorrupt(file);
      return null;
    }
    return record.score;
  }

  private writeDisk(key: string, score: number): DiskWriteResult {
    const file = this.entryPath(key);
    const previousSize = fileSizeIfPresent(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: RerankScoreRecord = { schema_version: RERANK_SCORE_CACHE_SCHEMA_VERSION, score };
    const serialized = `${JSON.stringify(record)}\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, serialized, 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup of the temp file
      }
      throw err;
    }
    return { previousSize, size: Buffer.byteLength(serialized, 'utf-8') };
  }

  private recordCorrupt(file: string): void {
    this.corruptions += 1;
    try {
      fs.unlinkSync(file);
      this.diskBytes = undefined;
    } catch {
      // best-effort: a missing/locked corrupt file is fine to ignore
    }
  }

  private enforceDiskLimit(): void {
    if (this.diskMaxBytes <= 0) return;
    if (this.diskBytes === undefined || this.writesSinceReconcile >= DISK_SIZE_RECONCILE_INTERVAL) {
      this.diskBytes = this.reconcileDiskSize();
    }
    if (this.diskBytes === undefined || this.diskBytes <= this.diskMaxBytes) return;

    const files = listEntryFiles(this.cacheRoot);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    // Evict oldest-first by mtime until back under the bound.
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= this.diskMaxBytes) break;
      try {
        fs.unlinkSync(file.path);
        total -= file.size;
      } catch {
        // already gone or locked by another process — skip it
      }
    }
    this.diskBytes = total;
    this.writesSinceReconcile = 0;
  }

  private applyDiskWrite(write: DiskWriteResult): void {
    if (this.diskBytes !== undefined) {
      this.diskBytes += write.size - write.previousSize;
    }
    this.writesSinceReconcile += 1;
  }

  private reconcileDiskSize(): number | undefined {
    try {
      const total = listEntryFiles(this.cacheRoot).reduce((sum, file) => sum + file.size, 0);
      this.writesSinceReconcile = 0;
      return total;
    } catch (err) {
      logger.warn(`rerank score cache size reconciliation skipped: ${(err as Error).message}`);
      return undefined;
    }
  }
}

function fileSizeIfPresent(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

function listEntryFiles(root: string): Array<{ path: string; size: number; mtimeMs: number }> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const st = fs.statSync(child);
        out.push({ path: child, size: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  };
  walk(root);
  return out;
}
