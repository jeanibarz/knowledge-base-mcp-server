// ---------------------------------------------------------------------------
// Query embedding cache configuration (#214).
// ---------------------------------------------------------------------------

export function isQueryCacheEnabled(raw: string | undefined = process.env.KB_QUERY_CACHE): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value !== 'off' && value !== 'false' && value !== '0' && value !== 'disabled';
}

export function resolveQueryCacheLruMax(raw: string | undefined = process.env.KB_QUERY_CACHE_LRU_MAX): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 256;
  return Math.floor(parsed);
}

export function resolveQueryCacheDiskMaxBytes(
  raw: string | undefined = process.env.KB_QUERY_CACHE_DISK_MAX_MB,
): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 64 * 1024 * 1024;
  return Math.floor(parsed * 1024 * 1024);
}

export const KB_QUERY_CACHE_ENABLED = isQueryCacheEnabled();
export const KB_QUERY_CACHE_LRU_MAX = resolveQueryCacheLruMax();
export const KB_QUERY_CACHE_DISK_MAX_BYTES = resolveQueryCacheDiskMaxBytes();
