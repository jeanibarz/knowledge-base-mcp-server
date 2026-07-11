import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { logger } from './logger.js';

export const DECOMPOSITION_CACHE_SCHEMA_VERSION = 'kb.search.query-decomposition.v1';
export const DEFAULT_DECOMPOSITION_CACHE_LRU_MAX = 256;
export const DEFAULT_DECOMPOSITION_CACHE_DISK_MAX_BYTES = 64 * 1024 * 1024;

const MAX_CACHED_SUBQUERIES = 64;
const MAX_CACHED_SUBQUERY_LENGTH = 16_384;

export interface DecompositionCache {
  get(modelId: string, query: string): string[] | null;
  set(modelId: string, query: string, subqueries: readonly string[]): void;
}

export interface DiskTieredDecompositionCacheOptions {
  indexPath?: string;
  enabled?: boolean;
  lruMax?: number;
  diskMaxBytes?: number;
}

export interface DecompositionCacheStats {
  enabled: boolean;
  l1_hits: number;
  disk_hits: number;
  misses: number;
  writes: number;
  corruptions: number;
  l1_size: number;
  disk_size_bytes: number;
}

interface DecompositionCacheRecord {
  schema_version: typeof DECOMPOSITION_CACHE_SCHEMA_VERSION;
  model_id: string;
  normalized_query: string;
  subqueries: string[];
  subqueries_sha256: string;
}

export function isDecompositionCacheEnabled(
  raw: string | undefined = readEnvironment('KB_DECOMPOSE_CACHE_ENABLED'),
): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes' || value === 'enabled';
}

export function resolveDecompositionCacheLruMax(
  raw: string | undefined = readEnvironment('KB_DECOMPOSE_CACHE_LRU_MAX'),
): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DECOMPOSITION_CACHE_LRU_MAX;
  return Math.floor(parsed);
}

export function resolveDecompositionCacheDiskMaxBytes(
  raw: string | undefined = readEnvironment('KB_DECOMPOSE_CACHE_DISK_MAX_BYTES'),
): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DECOMPOSITION_CACHE_DISK_MAX_BYTES;
  return Math.floor(parsed);
}

export function normalizeDecompositionQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function decompositionCacheKey(modelId: string, query: string): string {
  return createHash('sha256')
    .update(DECOMPOSITION_CACHE_SCHEMA_VERSION)
    .update('\x1f')
    .update(modelId)
    .update('\x1f')
    .update(normalizeDecompositionQuery(query))
    .digest('hex');
}

export function decompositionCacheRoot(indexPath: string = FAISS_INDEX_PATH): string {
  return path.join(indexPath, 'cache', 'query-decompositions');
}

export class DiskTieredDecompositionCache implements DecompositionCache {
  private readonly enabled: boolean;
  private readonly cacheRoot: string;
  private readonly diskMaxBytes: number;
  private readonly lruMax: number;
  private readonly l1 = new Map<string, string[]>();
  private l1Hits = 0;
  private diskHits = 0;
  private misses = 0;
  private writes = 0;
  private corruptions = 0;

  constructor(options: DiskTieredDecompositionCacheOptions = {}) {
    this.enabled = options.enabled ?? isDecompositionCacheEnabled();
    this.cacheRoot = decompositionCacheRoot(options.indexPath ?? FAISS_INDEX_PATH);
    this.diskMaxBytes = options.diskMaxBytes ?? resolveDecompositionCacheDiskMaxBytes();
    this.lruMax = options.lruMax ?? resolveDecompositionCacheLruMax();
  }

  get(modelId: string, query: string): string[] | null {
    if (!this.enabled || !isValidIdentity(modelId, query)) return null;
    const key = decompositionCacheKey(modelId, query);
    const memoryHit = this.l1.get(key);
    if (memoryHit !== undefined) {
      this.l1.delete(key);
      this.l1.set(key, memoryHit);
      this.l1Hits += 1;
      return memoryHit.slice();
    }
    const diskHit = this.readDisk(key, modelId, normalizeDecompositionQuery(query));
    if (diskHit !== null) {
      this.diskHits += 1;
      this.l1Set(key, diskHit);
      return diskHit.slice();
    }
    this.misses += 1;
    return null;
  }

  set(modelId: string, query: string, subqueries: readonly string[]): void {
    if (!this.enabled || !isValidIdentity(modelId, query) || !isValidSubqueries(subqueries)) return;
    const stable = Array.from(subqueries);
    const key = decompositionCacheKey(modelId, query);
    this.l1Set(key, stable);
    try {
      this.writeDisk(key, modelId, normalizeDecompositionQuery(query), stable);
      this.writes += 1;
      this.enforceDiskLimit();
    } catch (err) {
      logger.warn(`query decomposition cache write skipped: ${(err as Error).message}`);
    }
  }

  clearMemory(): void {
    this.l1.clear();
  }

  stats(): DecompositionCacheStats {
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
    return listEntryFiles(this.cacheRoot).reduce((sum, file) => sum + file.size, 0);
  }

  private l1Set(key: string, subqueries: readonly string[]): void {
    if (this.lruMax <= 0) return;
    if (this.l1.has(key)) this.l1.delete(key);
    this.l1.set(key, Array.from(subqueries));
    while (this.l1.size > this.lruMax) {
      const oldest = this.l1.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.l1.delete(oldest);
    }
  }

  private entryPath(key: string): string {
    return path.join(this.cacheRoot, key.slice(0, 2), `${key}.json`);
  }

  private readDisk(key: string, modelId: string, normalizedQuery: string): string[] | null {
    const file = this.entryPath(key);
    let record: unknown;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.recordCorrupt(file);
      return null;
    }
    if (!isValidRecord(record, modelId, normalizedQuery)) {
      this.recordCorrupt(file);
      return null;
    }
    return record.subqueries.slice();
  }

  private writeDisk(key: string, modelId: string, normalizedQuery: string, subqueries: string[]): void {
    const file = this.entryPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: DecompositionCacheRecord = {
      schema_version: DECOMPOSITION_CACHE_SCHEMA_VERSION,
      model_id: modelId,
      normalized_query: normalizedQuery,
      subqueries,
      subqueries_sha256: subqueriesChecksum(subqueries),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
      throw err;
    }
  }

  private recordCorrupt(file: string): void {
    this.corruptions += 1;
    try { fs.unlinkSync(file); } catch { /* best-effort corrupt entry cleanup */ }
  }

  private enforceDiskLimit(): void {
    const files = listEntryFiles(this.cacheRoot);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.diskMaxBytes) return;
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (total <= this.diskMaxBytes) break;
      try {
        fs.unlinkSync(file.path);
        total -= file.size;
      } catch { /* another process may already have removed it */ }
    }
  }
}

function isValidIdentity(modelId: string, query: string): boolean {
  return modelId.trim() !== '' && normalizeDecompositionQuery(query) !== '';
}

function isValidSubqueries(value: readonly string[]): value is string[] {
  return value.length > 0 && value.length <= MAX_CACHED_SUBQUERIES && value.every(
    (item) => typeof item === 'string' && item.trim() !== '' && item.length <= MAX_CACHED_SUBQUERY_LENGTH,
  );
}

function isValidRecord(
  value: unknown,
  modelId: string,
  normalizedQuery: string,
): value is DecompositionCacheRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<DecompositionCacheRecord>;
  return record.schema_version === DECOMPOSITION_CACHE_SCHEMA_VERSION &&
    record.model_id === modelId &&
    record.normalized_query === normalizedQuery &&
    Array.isArray(record.subqueries) &&
    isValidSubqueries(record.subqueries) &&
    typeof record.subqueries_sha256 === 'string' &&
    record.subqueries_sha256 === subqueriesChecksum(record.subqueries);
}

function subqueriesChecksum(subqueries: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(subqueries), 'utf-8').digest('hex');
}

// Keep decomposition-cache configuration local to this issue's four-file
// scope. A follow-up can promote these knobs into the shared config schema.
function readEnvironment(name: string): string | undefined {
  return process.env[name];
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
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const stat = fs.statSync(child);
          out.push({ path: child, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
  };
  walk(root);
  return out;
}
