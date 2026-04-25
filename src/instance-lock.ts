// RFC 013 §4.6 — single-instance advisory PID file.
//
// Enforces "one MCP server per FAISS_INDEX_PATH" (the constraint documented
// in `docs/architecture/threat-model.md`). Acquired with O_EXCL so two
// concurrent starts cannot both pass the check (TOCTOU-safe).
//
// Lifted from `src/lock.ts` in RFC 013 M0. The previous module conflated
// process-lifetime advisory with short-lived write coordination; the split
// lets each concern evolve independently and matches RFC 012 round-3's
// deferred boundary nit.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { FAISS_INDEX_PATH } from './config.js';
import { logger } from './logger.js';

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

/** Test-only export: the PID file path for advisory tests. */
export const PID_FILE_PATH_FOR_TESTS = PID_FILE_PATH;
