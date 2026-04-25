// RFC 012 §4.8 — split-lock coordination for the FAISS index.
//
// Two distinct mechanisms share this module by design (and by the RFC's
// §4.9 boundary call): they touch the same FAISS_INDEX_PATH directory and
// share lifecycle concerns (process exit must clean both up), but their
// purposes are different.
//
// 1. INSTANCE ADVISORY — a long-lived PID file at
//    `${FAISS_INDEX_PATH}/.kb-mcp.pid`. Written by `KnowledgeBaseServer.run()`
//    at startup; removed on graceful shutdown. Enforces "one MCP server per
//    FAISS_INDEX_PATH" (the constraint documented in
//    `docs/architecture/threat-model.md`). Acquired with O_EXCL so two
//    concurrent starts cannot both pass the check (TOCTOU-safe).
//
// 2. WRITE LOCK — a short-lived `proper-lockfile` lock at
//    `${FAISS_INDEX_PATH}/.kb-write.lock`. Acquired around each
//    `updateIndex()` call (in MCP, in ReindexTriggerWatcher, in CLI
//    `--refresh`). Released immediately after the write. Default `kb search`
//    (read-only) does NOT acquire this lock — concurrent reads are fine.
//
// The split was the round-2 design fix: an earlier draft had a single
// lifetime-scoped lock that broke `kb search --refresh` whenever the MCP
// server was running (the dogfood workflow the CLI exists to support).

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { FAISS_INDEX_PATH } from './config.js';
import { logger } from './logger.js';

// ----- Instance advisory (long-lived PID file) ------------------------------

const PID_FILE_PATH = path.join(FAISS_INDEX_PATH, '.kb-mcp.pid');

export class InstanceAlreadyRunningError extends Error {
  constructor(pid: number) {
    super(
      `Another knowledge-base-mcp-server is already running (PID ${pid}) ` +
      `against FAISS_INDEX_PATH=${FAISS_INDEX_PATH}. ` +
      `Stop it before starting a new instance, or set a different ` +
      `FAISS_INDEX_PATH for this server.`,
    );
    this.name = 'InstanceAlreadyRunningError';
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 just probes for the process; doesn't actually signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = process exists but we can't signal it (still "alive" for
    // single-instance purposes — another user owns it). ESRCH = no such
    // process.
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Atomically claim the single-instance advisory file. Throws
 * `InstanceAlreadyRunningError` when another live instance is detected.
 * Stale PID files (from a crashed previous run) are silently overwritten.
 *
 * Uses `O_CREAT | O_EXCL` so two simultaneous startups cannot both pass
 * the check — exactly one wins atomically. Mode 0o600 so the PID isn't
 * world-readable on shared filesystems.
 */
export async function acquireInstanceAdvisory(): Promise<void> {
  // Ensure FAISS_INDEX_PATH exists — the PID file lives inside it. The
  // FaissIndexManager.initialize() also handles this, but we need it before
  // initialize runs.
  await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });

  const pid = process.pid;
  const pidStr = `${pid}\n`;

  try {
    // O_EXCL: fail if file exists. Atomic.
    const fh = await fsp.open(PID_FILE_PATH, 'wx', 0o600);
    try {
      await fh.write(pidStr);
      await fh.sync();
    } finally {
      await fh.close();
    }
    logger.info(`Acquired instance advisory at ${PID_FILE_PATH} (pid ${pid})`);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
  }

  // EEXIST: read the recorded PID and check liveness.
  const recorded = (await fsp.readFile(PID_FILE_PATH, 'utf-8')).trim();
  const recordedPid = Number.parseInt(recorded, 10);
  if (Number.isFinite(recordedPid) && pidIsAlive(recordedPid)) {
    throw new InstanceAlreadyRunningError(recordedPid);
  }

  // Stale PID file. Replace atomically: unlink + create-O_EXCL.
  logger.warn(
    `Removing stale instance advisory at ${PID_FILE_PATH} ` +
    `(recorded PID ${recorded} is no longer alive)`,
  );
  await fsp.unlink(PID_FILE_PATH).catch(() => {});

  // One retry. If a third process raced in between unlink and create-O_EXCL,
  // they own it now and we should fail-fast with the same error UX.
  try {
    const fh = await fsp.open(PID_FILE_PATH, 'wx', 0o600);
    try {
      await fh.write(pidStr);
      await fh.sync();
    } finally {
      await fh.close();
    }
    logger.info(`Acquired instance advisory at ${PID_FILE_PATH} (pid ${pid})`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Race: another process took the slot. Treat as "another instance
      // running" with whatever PID is now there.
      const racePid = Number.parseInt(
        (await fsp.readFile(PID_FILE_PATH, 'utf-8')).trim(),
        10,
      );
      throw new InstanceAlreadyRunningError(Number.isFinite(racePid) ? racePid : -1);
    }
    throw err;
  }
}

/**
 * Remove the instance advisory file. Idempotent. Safe to call from
 * shutdown handlers even if `acquireInstanceAdvisory` was never called
 * (e.g., process started before the lock module loaded).
 */
export async function releaseInstanceAdvisory(): Promise<void> {
  try {
    // Only delete if we actually own it — refuse to delete another
    // process's PID file even if we somehow got here.
    const recorded = (await fsp.readFile(PID_FILE_PATH, 'utf-8').catch(() => '')).trim();
    const recordedPid = Number.parseInt(recorded, 10);
    if (Number.isFinite(recordedPid) && recordedPid !== process.pid) {
      logger.warn(
        `Refusing to delete instance advisory ${PID_FILE_PATH}: recorded PID ` +
        `${recordedPid} is not us (${process.pid}).`,
      );
      return;
    }
    await fsp.unlink(PID_FILE_PATH).catch(() => {});
  } catch (err) {
    logger.warn(`Error releasing instance advisory: ${(err as Error).message}`);
  }
}

// ----- Write lock (short-lived, around updateIndex calls) ------------------

const WRITE_LOCK_PATH = path.join(FAISS_INDEX_PATH, '.kb-write.lock');
const WRITE_LOCK_OPTS: properLockfile.LockOptions = {
  // proper-lockfile requires the LOCKED resource to exist; it locks a
  // sibling .lock directory. We point it at FAISS_INDEX_PATH itself
  // (which always exists by the time this runs) and let it manage the
  // lockfile internally. lockfilePath overrides the auto-derived path
  // so we get a stable, predictable file we can find from tests.
  lockfilePath: WRITE_LOCK_PATH,
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
 * Acquire the write lock, run `fn`, release the lock. The lock is held
 * for exactly the duration of `fn` — not longer.
 *
 * Throws if the lock can't be acquired within the retry budget. The
 * caller decides whether to surface that error or fall back to a
 * read-only path.
 */
export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  // Ensure target exists — proper-lockfile requires the resource path to
  // be lockable. FAISS_INDEX_PATH is always present in normal operation
  // (FaissIndexManager.initialize ensures it), but mkdir-p is cheap.
  await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });

  const release = await properLockfile.lock(FAISS_INDEX_PATH, WRITE_LOCK_OPTS);
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
 * Test-only export: the path the write lock occupies. Tests assert on
 * its existence/non-existence to verify acquire/release behavior.
 */
export const WRITE_LOCK_PATH_FOR_TESTS = WRITE_LOCK_PATH;

/** Test-only export: the PID file path for advisory tests. */
export const PID_FILE_PATH_FOR_TESTS = PID_FILE_PATH;
