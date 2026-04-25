// RFC 013 §4.6 — short-lived write lock.
//
// Acquired around each `updateIndex()` call (in MCP, in
// ReindexTriggerWatcher, in CLI `--refresh`). Released immediately after
// the write. Default `kb search` (read-only) does NOT acquire this lock —
// concurrent reads are fine.
//
// Lifted from `src/lock.ts` in RFC 013 M0. Signature changes from
// `withWriteLock(fn)` to `withWriteLock(resource, fn)` so the lock primitive
// no longer hardcodes `FAISS_INDEX_PATH`. M0 callers pass `FAISS_INDEX_PATH`
// for now; M1+M2 will pass per-model directories (`models/<id>/`) to enable
// concurrent operations on different models.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { logger } from './logger.js';

const WRITE_LOCK_OPTS_BASE: Omit<properLockfile.LockOptions, 'lockfilePath'> = {
  // Heartbeat keeps the lock alive across long-running updateIndex calls
  // (e.g., a model-switch full re-embed that takes minutes). proper-lockfile
  // uses mtime-based stale detection; without heartbeat, a long write would
  // false-positive as stale at the 10s default and another writer could
  // acquire.
  update: 5000,
  stale: 10_000,
  // Brief retry budget for fast-path contention (MCP and CLI both want
  // the lock for ~280 ms). Slow-path (model-switch re-embed) callers will
  // exhaust this and error with a clear message — that's the documented
  // RFC 012 §4.8.3 slow-path behavior.
  retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
};

/**
 * Acquire the write lock on `resource`, run `fn`, release the lock. The
 * lock is held for exactly the duration of `fn` — not longer.
 *
 * `resource` is an absolute directory path; the function does not interpret
 * it. M0 callers pass `FAISS_INDEX_PATH`. M1+M2 will pass
 * `${FAISS_INDEX_PATH}/models/<id>/` for per-model isolation.
 *
 * Throws if the lock can't be acquired within the retry budget.
 */
export async function withWriteLock<T>(resource: string, fn: () => Promise<T>): Promise<T> {
  // proper-lockfile requires the locked resource path to exist; mkdir-p
  // handles both first-run and subdirectory cases (M1+M2's per-model dirs).
  await fsp.mkdir(resource, { recursive: true });

  const lockfilePath = path.join(resource, '.kb-write.lock');
  const release = await properLockfile.lock(resource, {
    ...WRITE_LOCK_OPTS_BASE,
    lockfilePath,
  });
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch (err) {
      logger.warn(`Error releasing write lock: ${(err as Error).message}`);
    }
  }
}

/**
 * Test-only helper: the lockfile path that `withWriteLock(resource, ...)`
 * would create. Tests assert on its existence/non-existence to verify
 * acquire/release behavior.
 */
export function writeLockPathFor(resource: string): string {
  return path.join(resource, '.kb-write.lock');
}
