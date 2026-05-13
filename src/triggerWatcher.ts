// RFC 011 §5.5 — dotfile-aware mtime poller for
// `<KNOWLEDGE_BASES_ROOT_DIR>/.reindex-trigger`. External workflows (the
// arxiv-ingestion n8n flow is the canonical producer) `touch` the trigger
// after every successful write; a running MCP server picks up those writes
// without the caller having to invoke `refresh_knowledge_base` manually.
//
// The poller runs ALONGSIDE RFC 007 §6.6's `fs.watch` recursive watcher
// (issue #212, `recursive-fs-watch.ts`, opt-in via `KB_FS_WATCH=1`). The
// `fs.watch` path sees per-file edits *inside* each KB directory (which
// is the right surface for inline editing); the poller sees the root-level
// dotfile that the walker and `fs.watch` both deliberately skip.
import * as fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

type FsError = NodeJS.ErrnoException & { code?: string };

export type ReindexTriggerFileKind = 'file' | 'directory' | 'other' | 'missing';

export interface ReindexTriggerFilesystemState {
  trigger_path: string;
  parent_path: string;
  exists: boolean;
  kind: ReindexTriggerFileKind;
  mtime: string | null;
  size_bytes: number | null;
  parent_exists: boolean;
  parent_writable: boolean | null;
  stat_error: string | null;
  parent_access_error: string | null;
  warnings: string[];
}

export async function inspectReindexTriggerFilesystem(
  triggerPath: string,
): Promise<ReindexTriggerFilesystemState> {
  const parentPath = path.dirname(triggerPath);
  const warnings: string[] = [];
  let exists = false;
  let kind: ReindexTriggerFileKind = 'missing';
  let mtime: string | null = null;
  let sizeBytes: number | null = null;
  let statError: string | null = null;

  try {
    const st = await fsp.stat(triggerPath);
    exists = true;
    kind = st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other';
    mtime = new Date(st.mtimeMs).toISOString();
    sizeBytes = st.size;
    if (kind !== 'file') {
      warnings.push(`trigger path exists but is ${kind}, not a file`);
    }
  } catch (error) {
    const code = (error as FsError | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      warnings.push('trigger file does not exist yet');
    } else {
      statError = (error as Error).message;
      warnings.push(`trigger stat failed: ${statError}`);
    }
  }

  let parentExists = false;
  let parentWritable: boolean | null = null;
  let parentAccessError: string | null = null;
  try {
    const parentStat = await fsp.stat(parentPath);
    parentExists = parentStat.isDirectory();
    if (!parentExists) {
      warnings.push('trigger parent exists but is not a directory');
      parentWritable = false;
    } else {
      try {
        await fsp.access(parentPath, fsConstants.W_OK);
        parentWritable = true;
      } catch (error) {
        parentWritable = false;
        parentAccessError = (error as Error).message;
        warnings.push(`trigger parent is not writable: ${parentAccessError}`);
      }
    }
  } catch (error) {
    const code = (error as FsError | undefined)?.code;
    parentWritable = false;
    parentAccessError = (error as Error).message;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      warnings.push('trigger parent directory does not exist');
    } else {
      warnings.push(`trigger parent stat failed: ${parentAccessError}`);
    }
  }

  return {
    trigger_path: triggerPath,
    parent_path: parentPath,
    exists,
    kind,
    mtime,
    size_bytes: sizeBytes,
    parent_exists: parentExists,
    parent_writable: parentWritable,
    stat_error: statError,
    parent_access_error: parentAccessError,
    warnings,
  };
}

/**
 * Observes mtime on a single file and invokes `onTrigger` whenever it
 * advances past the last-seen value. Uses `setInterval` rather than
 * `fs.watch` because the trigger file:
 *
 *   1. Sits at the KB root, which is dotfile-skipped by the existing
 *      walker — not inside a watched KB directory.
 *   2. Must coalesce bursts of rapid touches into a small number of
 *      `updateIndex` calls (fixed interval is a natural debouncer).
 *   3. Behaves unpredictably under `fs.watch` for dotfiles on Linux
 *      and across bind-mounts / WSL2 / Docker.
 *
 * Coalescing: if a trigger fires while `onTrigger` is in flight, a
 * single-slot pending flag is set. On completion of the in-flight call
 * the flag is consumed and one additional call is scheduled. Bursts of
 * N touches produce ≤ 2 invocations (one in-flight, one queued).
 *
 * Robustness:
 *   - ENOENT on `fsp.stat` is not an error — the trigger file need not
 *     exist yet (first-run case).
 *   - If `onTrigger` throws, the error is logged and the poller keeps
 *     running; the next mtime advance re-invokes normally.
 *   - `stop()` clears the interval immediately and awaits the in-flight
 *     callback so shutdown can drain cleanly.
 */
export class ReindexTriggerWatcher {
  private readonly triggerPath: string;
  private readonly onTrigger: () => Promise<void>;
  private readonly pollMs: number;

  private timer: NodeJS.Timeout | null = null;
  private lastMtimeMs: number | null = null;
  /**
   * True once a poll has observed the trigger file missing. When the
   * file subsequently appears, the first successful stat fires the
   * trigger instead of silently seeding the baseline — "file created
   * post-startup" IS "new content landed while we were running", which
   * is exactly what the watcher is trying to catch (RFC §5.5).
   */
  private sawAbsent = false;
  private inFlight: Promise<void> | null = null;
  private pending = false;
  private stopped = false;

  constructor(
    triggerPath: string,
    onTrigger: () => Promise<void>,
    pollMs: number,
  ) {
    this.triggerPath = triggerPath;
    this.onTrigger = onTrigger;
    this.pollMs = pollMs;
  }

  /**
   * Begins polling. Once `stop()` has been called the instance is
   * terminal — `start()` is a silent no-op on a stopped watcher. A
   * `pollMs` of `0` disables the poller entirely (no timer is
   * installed); callers that want the watcher off should avoid
   * constructing it at all, but this escape hatch matches the
   * `REINDEX_TRIGGER_POLL_MS=0` env contract.
   */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    if (this.pollMs <= 0) {
      logger.info(
        `ReindexTriggerWatcher disabled (pollMs=${this.pollMs}) path=${this.triggerPath}`,
      );
      return;
    }
    logger.info(
      `ReindexTriggerWatcher started; poll=${this.pollMs}ms path=${this.triggerPath}`,
    );
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    // Don't pin the Node event loop open just because of this poller —
    // the MCP server's transport layer is what should keep the process
    // alive. unref() is a no-op in environments that don't support it.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stops the poller and awaits any in-flight `onTrigger` invocation.
   * Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Drain the in-flight call so shutdown doesn't race a write.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // Already logged in `runTrigger`.
      }
    }
  }

  /**
   * One poll tick. Public only so tests can drive the scheduler
   * deterministically without waiting on real timers.
   */
  async poll(): Promise<void> {
    if (this.stopped) return;
    let mtimeMs: number;
    try {
      const stat = await fsp.stat(this.triggerPath);
      mtimeMs = stat.mtimeMs;
    } catch (error) {
      const code = (error as FsError | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Trigger file absent. Not an error — the workflow hasn't run
        // yet, or the operator moved the file. Record that we saw it
        // absent so the next successful stat fires (rather than seeding
        // the baseline silently) — a file created post-startup is a
        // real signal.
        this.sawAbsent = true;
        return;
      }
      logger.warn(
        `ReindexTriggerWatcher stat failed for ${this.triggerPath}: ${(error as Error).message}`,
      );
      return;
    }

    // A poll that succeeds AFTER stop() was requested must not fire —
    // stop() may already be awaiting drain, and we don't want a late
    // stat to schedule another onTrigger against a shutting-down server.
    if (this.stopped) return;

    if (this.lastMtimeMs === null) {
      if (this.sawAbsent) {
        // File just appeared post-startup (poll N saw ENOENT; poll N+1
        // sees a real mtime). That IS the signal we're watching for.
        this.lastMtimeMs = mtimeMs;
        this.requestRun();
        return;
      }
      // First successful stat AND no prior absence observed: a trigger
      // file that predates server startup is NOT a signal that new
      // content landed while we were running.
      this.lastMtimeMs = mtimeMs;
      return;
    }

    if (mtimeMs > this.lastMtimeMs) {
      this.lastMtimeMs = mtimeMs;
      this.requestRun();
    }
  }

  private requestRun(): void {
    // Belt and braces: `poll()` already checks `stopped`, but a late
    // `stop()` that lands between the stat and the mtime-compare would
    // otherwise still reach here. Drop the run entirely in that case so
    // a shutdown never has an unawaited onTrigger chasing it.
    if (this.stopped) return;
    if (this.inFlight) {
      // An earlier poll is already running `onTrigger`. Coalesce: remember
      // that another run is needed, but don't start it in parallel — the
      // index update path is not safe to overlap with itself.
      this.pending = true;
      return;
    }
    this.inFlight = this.runTrigger();
    void this.inFlight.finally(() => {
      this.inFlight = null;
      if (this.pending && !this.stopped) {
        this.pending = false;
        this.requestRun();
      }
    });
  }

  private async runTrigger(): Promise<void> {
    const mtimeIso = this.lastMtimeMs !== null
      ? new Date(this.lastMtimeMs).toISOString()
      : 'unknown';
    logger.info(
      `Reindex trigger observed at mtime ${mtimeIso}; running updateIndex(*)`,
    );
    try {
      await this.onTrigger();
    } catch (error) {
      logger.error('Reindex trigger handler failed:', error);
    }
  }
}
