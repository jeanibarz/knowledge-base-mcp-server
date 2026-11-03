import { initializeProjectConfig } from './project-config.js';

initializeProjectConfig();

// ---------------------------------------------------------------------------
// Query embedding cache configuration (#214).
// ---------------------------------------------------------------------------

export function isQueryCacheEnabled(raw: string | undefined = process.env.KB_QUERY_CACHE): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value !== 'off' && value !== 'false' && value !== '0' && value !== 'disabled';
}

export function resolveQueryCacheLruMax(raw: string | undefined = process.env.KB_QUERY_CACHE_LRU_MAX): number {
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 256;
  return Math.floor(parsed);
}

export function resolveQueryCacheDiskMaxBytes(
  raw: string | undefined = process.env.KB_QUERY_CACHE_DISK_MAX_MB,
): number {
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 64 * 1024 * 1024;
  return Math.floor(parsed * 1024 * 1024);
}

export const KB_QUERY_CACHE_ENABLED = isQueryCacheEnabled();
export const KB_QUERY_CACHE_LRU_MAX = resolveQueryCacheLruMax();
export const KB_QUERY_CACHE_DISK_MAX_BYTES = resolveQueryCacheDiskMaxBytes();

// ---------------------------------------------------------------------------
// Answer cache configuration (#656). Opt-in (default OFF) — caching LLM answers
// trades freshness for speed, so it must be requested explicitly.
// ---------------------------------------------------------------------------

export function isAskCacheEnabled(raw: string | undefined = process.env.KB_ASK_CACHE): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes' || value === 'enabled';
}

export function resolveAskCacheDiskMaxBytes(
  raw: string | undefined = process.env.KB_ASK_CACHE_DISK_MAX_MB,
): number {
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 64 * 1024 * 1024;
  return Math.floor(parsed * 1024 * 1024);
}

export const KB_ASK_CACHE_ENABLED = isAskCacheEnabled();
export const KB_ASK_CACHE_DISK_MAX_BYTES = resolveAskCacheDiskMaxBytes();

// ---------------------------------------------------------------------------
// Extraction-text cache disk byte cap (#1022). The content-addressed
// extracted-text cache ($FAISS_INDEX_PATH/extracted-text) historically grew
// unbounded across reindexes and shrank only when an operator ran
// `kb cache prune`. KB_EXTRACTION_CACHE_DISK_MAX_BYTES opts that cache into the
// same write-time eviction the rerank/query/ask disk caches use: once the cap
// is exceeded on a write, oldest entries are evicted until the total is back
// under it.
//
// Default OFF (0): unlike the other disk caps, the extraction cache stays
// unbounded unless an operator sets a positive cap, so this change preserves
// the pre-#1022 behavior for every existing install. A blank, non-numeric, or
// negative value also resolves to 0 (enforcement disabled).
// ---------------------------------------------------------------------------

export function resolveExtractionCacheDiskMaxBytes(
  raw: string | undefined = process.env.KB_EXTRACTION_CACHE_DISK_MAX_BYTES,
): number {
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export const KB_EXTRACTION_CACHE_DISK_MAX_BYTES = resolveExtractionCacheDiskMaxBytes();
