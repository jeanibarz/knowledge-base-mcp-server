// Issue #645 — disk-space preflight guard for write-heavy reindex/ingest.
//
// A `kb reindex --with-context` triggers a full rebuild that writes a new
// FAISS index version, docstore JSON, contextual-preface sidecars, and
// lexical indexes under `$FAISS_INDEX_PATH` — all *before* the atomic swap
// (RFC 014). If the volume runs out of space mid-write the operation
// surfaces as a raw `ENOSPC` after an expensive partial run, leaving an
// abandoned half-written version on disk.
//
// This module is the *preventive* complement to the `disk-full` chaos test
// (#473): it estimates how many bytes the rebuild will need, compares that
// (plus a safety margin) against the `statfs`-reported available bytes, and
// throws a typed `KBError('INSUFFICIENT_DISK_SPACE', …)` with an actionable
// "need ~X, have Y" message before any write starts.
//
// Design notes (see PR for alternatives):
//  - Estimate = current on-disk footprint under `$FAISS_INDEX_PATH` × an
//    empirical factor. A full reindex writes a fresh version roughly the
//    size of the committed one; the factor covers the temporary overlap of
//    old + new version during the atomic swap and sidecar growth. A
//    first-ever reindex (empty dir) estimates 0, so only the margin gates it.
//  - Margin is `KB_MIN_FREE_DISK_BYTES` (default 512 MiB), kept conservative
//    and tunable so this is not a hard surprise.
//  - `fs.promises.statfs` is on all supported Node versions; if it is
//    unavailable or fails, the guard degrades gracefully (skips, logs a
//    warning) rather than blocking a reindex on a portability gap.

import * as fsp from 'fs/promises';
import * as path from 'path';

import { KBError } from './errors.js';
import { logger } from './logger.js';

/** Default safety margin: free bytes that must remain after the estimate. */
export const DEFAULT_MIN_FREE_DISK_BYTES = 512 * 1024 * 1024; // 512 MiB

/**
 * Multiplier applied to the current on-disk index footprint to approximate
 * the bytes a full rebuild will write. >1 because the atomic swap keeps the
 * old version on disk while the new one is built (RFC 014) and sidecars can
 * grow between runs. Conservative by design; tune via the PR if observed
 * rebuilds need more headroom.
 */
export const DEFAULT_REINDEX_ESTIMATE_FACTOR = 1.5;

/**
 * Resolve the operator-tunable safety margin from `KB_MIN_FREE_DISK_BYTES`.
 * Falls back to {@link DEFAULT_MIN_FREE_DISK_BYTES} when unset, empty, or
 * not a finite non-negative number.
 */
export function resolveMinFreeDiskBytes(
  raw: string | undefined = process.env.KB_MIN_FREE_DISK_BYTES,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_FREE_DISK_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_FREE_DISK_BYTES;
  return Math.floor(n);
}

/** Test seam: returns available bytes for the filesystem backing `dir`. */
export type StatfsFn = (dir: string) => Promise<{ bavail: number; bsize: number }>;

const defaultStatfs: StatfsFn = async (dir) => {
  const s = await fsp.statfs(dir);
  return { bavail: Number(s.bavail), bsize: Number(s.bsize) };
};

/**
 * Recursively sum the byte size of every regular file under `dir`.
 * Best-effort: a missing directory (never indexed) yields 0, and unreadable
 * entries are skipped rather than aborting the estimate.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
    } else if (entry.isFile()) {
      try {
        const st = await fsp.stat(full);
        total += st.size;
      } catch {
        // best-effort
      }
    }
  }
  return total;
}

/** Available bytes on the filesystem backing `dir` (bavail × bsize). */
export async function availableDiskBytes(dir: string, statfs: StatfsFn = defaultStatfs): Promise<number> {
  const { bavail, bsize } = await statfs(dir);
  return bavail * bsize;
}

export interface DiskSpaceEstimate {
  /** Approximate bytes the write will produce. */
  estimated_bytes: number;
  /** Bytes currently free on the target filesystem. */
  available_bytes: number;
  /** Safety-margin bytes that must remain free after the write. */
  margin_bytes: number;
  /** estimated_bytes + margin_bytes — the minimum free space to proceed. */
  required_bytes: number;
  /** Whether available_bytes >= required_bytes. */
  sufficient: boolean;
}

/**
 * Pure compare logic — kept separate from any IO so it is trivially
 * unit-testable. Negative or non-finite inputs are clamped to 0.
 */
export function evaluateDiskSpace(params: {
  estimatedBytes: number;
  availableBytes: number;
  marginBytes: number;
}): DiskSpaceEstimate {
  const estimated = Math.max(0, Number.isFinite(params.estimatedBytes) ? params.estimatedBytes : 0);
  const available = Math.max(0, Number.isFinite(params.availableBytes) ? params.availableBytes : 0);
  const margin = Math.max(0, Number.isFinite(params.marginBytes) ? params.marginBytes : 0);
  const required = estimated + margin;
  return {
    estimated_bytes: estimated,
    available_bytes: available,
    margin_bytes: margin,
    required_bytes: required,
    sufficient: available >= required,
  };
}

/** Human-readable byte size for error messages (1024-based). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export interface DiskPreflightOptions {
  /** Override the safety margin; defaults to {@link resolveMinFreeDiskBytes}. */
  minFreeBytes?: number;
  /** Override the estimate multiplier; defaults to {@link DEFAULT_REINDEX_ESTIMATE_FACTOR}. */
  estimateFactor?: number;
  /** Test seam: statfs implementation. */
  statfs?: StatfsFn;
  /** Test seam: precomputed current on-disk footprint of `dir`. */
  currentBytes?: number;
}

/**
 * Preflight guard: estimate the bytes a write-heavy reindex/ingest against
 * `dir` will need and refuse up front when the filesystem cannot hold it.
 *
 * Throws `KBError('INSUFFICIENT_DISK_SPACE', …)` with a "need ~X, have Y"
 * message when available space is below estimate + margin. Returns the
 * computed {@link DiskSpaceEstimate} on success.
 *
 * If `statfs` is unavailable or fails (older runtimes, exotic filesystems),
 * the guard degrades gracefully: it logs a warning and returns a permissive
 * estimate rather than blocking the operation on a portability gap.
 */
export async function assertSufficientDiskSpace(
  dir: string,
  options: DiskPreflightOptions = {},
): Promise<DiskSpaceEstimate> {
  const margin = options.minFreeBytes ?? resolveMinFreeDiskBytes();
  const factor = options.estimateFactor ?? DEFAULT_REINDEX_ESTIMATE_FACTOR;

  const currentBytes = options.currentBytes ?? (await directorySizeBytes(dir));
  const estimatedBytes = Math.ceil(currentBytes * factor);

  let availableBytes: number;
  try {
    availableBytes = await availableDiskBytes(dir, options.statfs ?? defaultStatfs);
  } catch (err) {
    logger.warn(
      `#645: disk-space preflight skipped — statfs("${dir}") failed: ${(err as Error).message}`,
    );
    return {
      estimated_bytes: estimatedBytes,
      available_bytes: Number.POSITIVE_INFINITY,
      margin_bytes: margin,
      required_bytes: estimatedBytes + margin,
      sufficient: true,
    };
  }

  const estimate = evaluateDiskSpace({ estimatedBytes, availableBytes, marginBytes: margin });
  if (!estimate.sufficient) {
    throw new KBError(
      'INSUFFICIENT_DISK_SPACE',
      `Insufficient disk space for reindex at "${dir}": need ~${formatBytes(estimate.required_bytes)} ` +
        `(estimate ${formatBytes(estimate.estimated_bytes)} + ${formatBytes(estimate.margin_bytes)} margin), ` +
        `have ${formatBytes(estimate.available_bytes)} free. ` +
        `Free up space or lower KB_MIN_FREE_DISK_BYTES (current margin ${estimate.margin_bytes} bytes).`,
    );
  }
  return estimate;
}
