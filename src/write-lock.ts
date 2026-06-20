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
import * as os from 'os';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { classifyCanonicalError, emitCanonicalLog, type CanonicalError } from './canonical-log.js';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { logger } from './logger.js';
import { writeLockMetrics, type WriteLockResourceKind } from './metrics.js';

export const WRITE_LOCK_STALE_MS = 10_000;

const WRITE_LOCK_OPTS_BASE: Omit<properLockfile.LockOptions, 'lockfilePath'> = {
  // Heartbeat keeps the lock alive across long-running updateIndex calls
  // (e.g., a model-switch full re-embed that takes minutes). proper-lockfile
  // uses mtime-based stale detection; without heartbeat, a long write would
  // false-positive as stale at the 10s default and another writer could
  // acquire.
  update: 5000,
  stale: WRITE_LOCK_STALE_MS,
  // Brief retry budget for fast-path contention (MCP and CLI both want
  // the lock for ~280 ms). Slow-path (model-switch re-embed) callers will
  // exhaust this and error with a clear message — that's the documented
  // RFC 012 §4.8.3 slow-path behavior.
  retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
};

export const WRITE_LOCK_OWNER_SCHEMA_VERSION = 'kb.write-lock-owner.v1';

export interface WriteLockOwnerMetadata {
  schema_version: typeof WRITE_LOCK_OWNER_SCHEMA_VERSION;
  pid: number;
  command: string;
  cwd: string | null;
  hostname: string;
  started_at: string;
}

const SIDECAR_LOCK_OPTS_BASE: Omit<properLockfile.LockOptions, 'lockfilePath'> = {
  stale: 30_000,
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
};

export class WriteLockContentionError extends Error {
  readonly code = 'REFRESH_LOCK_BUSY';
  readonly resource: string;
  readonly lockPath: string;
  readonly causeMessage: string;

  constructor(opts: { resource: string; lockPath: string; causeMessage: string }) {
    super('Refresh lock is already held for this model. Retry after the current refresh finishes.');
    this.name = 'WriteLockContentionError';
    this.resource = opts.resource;
    this.lockPath = opts.lockPath;
    this.causeMessage = opts.causeMessage;
  }
}

function isLockContentionError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = (err as Error)?.message ?? '';
  return (
    code === 'ELOCKED' ||
    /Lock file is already being held/i.test(message) ||
    /exceeded.*lock/i.test(message)
  );
}

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
  const ownerPath = writeLockOwnerPathFor(resource);
  const resourceKind = writeLockResourceKindFor(resource);
  const waitStart = performanceNow();
  let release: () => Promise<void>;
  try {
    release = await properLockfile.lock(resource, {
      ...WRITE_LOCK_OPTS_BASE,
      lockfilePath,
    });
  } catch (err) {
    if (isLockContentionError(err)) {
      throw new WriteLockContentionError({
        resource,
        lockPath: lockfilePath,
        causeMessage: (err as Error).message,
      });
    }
    throw err;
  }
  const waitMs = performanceNow() - waitStart;
  await writeLockOwnerMetadata(ownerPath);
  const holdStart = performanceNow();
  let holdMs = 0;
  let canonicalError: CanonicalError | undefined;
  try {
    return await fn();
  } catch (err) {
    canonicalError = classifyCanonicalError(err);
    throw err;
  } finally {
    holdMs = performanceNow() - holdStart;
    writeLockMetrics.record({ resourceKind, waitMs, holdMs });
    emitWriteLockTiming({
      resourceKind,
      waitMs,
      holdMs,
      error: canonicalError,
    });
    try {
      await fsp.rm(ownerPath, { force: true });
    } catch (err) {
      logger.warn(`Error removing write lock owner metadata: ${(err as Error).message}`);
    }
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

export function writeLockOwnerPathFor(resource: string): string {
  return path.join(resource, '.kb-write.lock.owner.json');
}

export function writeLockResourceKindFor(resource: string): WriteLockResourceKind {
  const resolvedResource = path.resolve(resource);
  const resolvedFaissRoot = path.resolve(FAISS_INDEX_PATH);
  if (resolvedResource === resolvedFaissRoot) return 'active_index';
  const modelsRoot = path.join(resolvedFaissRoot, 'models');
  const relativeToModels = path.relative(modelsRoot, resolvedResource);
  if (relativeToModels !== '' && !relativeToModels.startsWith('..') && !path.isAbsolute(relativeToModels)) {
    return 'model_index';
  }
  return 'other';
}

async function writeLockOwnerMetadata(ownerPath: string): Promise<void> {
  const metadata: WriteLockOwnerMetadata = {
    schema_version: WRITE_LOCK_OWNER_SCHEMA_VERSION,
    pid: process.pid,
    command: process.argv.join(' '),
    cwd: safeCwd(),
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  };
  try {
    await fsp.writeFile(ownerPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn(`Error writing write lock owner metadata: ${(err as Error).message}`);
  }
}

function safeCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function emitWriteLockTiming(input: {
  resourceKind: WriteLockResourceKind;
  waitMs: number;
  holdMs: number;
  error?: CanonicalError;
}): void {
  emitCanonicalLog({
    process: canonicalProcessKind(),
    event: 'write_lock',
    took_ms: input.waitMs + input.holdMs,
    lock_wait_ms: input.waitMs,
    lock_hold_ms: input.holdMs,
    lock_resource_kind: input.resourceKind,
    ...(input.error === undefined ? {} : { error: input.error }),
  });
}

function canonicalProcessKind(): 'cli' | 'mcp' {
  const argv = process.argv.map((entry) => path.basename(entry));
  return argv.some((entry) => entry === 'kb' || entry === 'cli.js') ? 'cli' : 'mcp';
}

function performanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Issue #90 follow-up — cross-model serialization for per-KB hash sidecar
 * state at `<kb>/.index/`. Sidecars are SHARED across models (the on-disk
 * shape is per-KB, not per-model), but `updateIndex` historically protected
 * them with a PER-MODEL write lock. That left two concurrent windows racy:
 *   1. Two models updating different KBs simultaneously: harmless overwrite
 *      with the same hash bytes.
 *   2. One model's `purgeStaleSidecars` (init under missing store) firing
 *      while another model's `updateIndex` is mid-`Promise.all` of sidecar
 *      writes: the writer's `fsp.rename(tmp, target)` ENOENTs because the
 *      parent `.index/` dir was just rmrf'd by the purger.
 *
 * The shared lock at `${FAISS_INDEX_PATH}/.kb-sidecar.lock` serializes
 * every cross-model sidecar mutation: both the purge and the post-save
 * sidecar write batch acquire it briefly. The lock is held only across
 * filesystem syscalls (no embedding work), so cross-model contention adds
 * at most milliseconds per `updateIndex`.
 */
export async function withSidecarLock<T>(action: () => Promise<T>): Promise<T> {
  await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
  const lockfilePath = sidecarLockPathFor();
  let release: (() => Promise<void>) | null = null;
  try {
    release = await properLockfile.lock(FAISS_INDEX_PATH, {
      ...SIDECAR_LOCK_OPTS_BASE,
      lockfilePath,
    });
  } catch (err) {
    // Lock acquisition exhausted retries: a peer is holding it for an
    // unusually long time, or we're on a filesystem where proper-lockfile
    // can't operate. Either way, falling through is safer than aborting:
    // the worst case (rename ENOENT from a concurrent rmrf) is recoverable
    // on the next updateIndex pass, while a hard abort poisons the caller.
    logger.warn(
      `Issue #90 sidecar lock: could not acquire ${lockfilePath}, proceeding without serialization: ${(err as Error).message}`,
    );
  }
  try {
    return await action();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // best-effort
      }
    }
  }
}

export function sidecarLockPathFor(): string {
  return path.join(FAISS_INDEX_PATH, '.kb-sidecar.lock');
}
