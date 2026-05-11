// RFC 007 §6.6 — recursive `fs.watch` KB watcher with per-(kb, file)
// debounce (issue #212). Observes per-file edits *inside* each registered
// KB tree, complementing the RFC 011 trigger-file poller in
// `triggerWatcher.ts` (which observes a single dotfile at the KB root
// touched by external batch workflows like the arxiv-ingestion n8n flow).
//
// Off by default — the `KB_FS_WATCH=1` flag opts in. `fs.watch` has well
// known platform quirks (NFS / FUSE never deliver events, very large
// trees on Linux exhaust inotify watch slots) that we don't want to
// surprise existing users with on a minor release.
//
// Design contract (mirrors `ReindexTriggerWatcher`):
//   1. Per registered KB, attach a recursive `fs.watch(kbPath,
//      {recursive: true})` on macOS / Windows. On Linux + WSL fall back
//      to a non-recursive watch on each subdirectory enumerated at
//      startup (`getFilesRecursively` already supplies the subdir set
//      we need; we re-walk it here to harvest the directory list).
//   2. Filter events through the same dotfile + extension allowlist +
//      `INGEST_EXCLUDE_PATHS` rules the indexer uses. Anything the
//      walker would skip is dropped on the watcher path too.
//   3. Debounce each `(kb, relativePath)` for `debounceMs` (default
//      250 ms). Coalesce bursts — VSCode and similar editors save
//      via `tmp + rename`, producing 2-3 events per logical save.
//   4. After debounce, schedule a per-KB `updateIndex` under the
//      existing write lock. The FaissIndexManager already uses sidecar
//      hashes to skip unchanged files inside that KB, so the cost is
//      proportional to what actually changed, not the full KB.
//   5. Lifecycle: `start()` from `KnowledgeBaseServer.runStdio/Sse/Http`
//      after the transport binds; `stop()` from the SIGINT shutdown
//      path. Identical to the trigger watcher's start/stop semantics.
//
// Concurrency: a single in-flight `updateIndex(kbName)` runs per KB at
// a time, with at most one queued follow-up — the same "single-slot
// pending" coalescer the trigger watcher uses. Bursts of N debounced
// per-file events collapse to ≤ 2 `updateIndex` calls per KB.
//
// Robustness:
//   - Errors from `fs.watch` (ENOSPC = inotify slots exhausted, ENOTSUP
//     = filesystem doesn't support fs.watch) are caught, logged, and
//     the watcher continues running with the KBs it could attach to.
//   - `stop()` is idempotent and awaits any in-flight `onChange`.
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import { filterIngestablePaths } from './ingest-filter.js';
import { logger } from './logger.js';

/**
 * Per-KB binding the watcher uses to translate `fs.watch` events back
 * to `(kbName, kbRelativePath)`. `kbPath` is the absolute directory the
 * watcher attaches to; `relPathFromKbRoot` is computed at event time.
 */
export interface RecursiveKbWatcherTarget {
  kbName: string;
  kbPath: string;
}

export interface RecursiveKbWatcherOptions {
  targets: ReadonlyArray<RecursiveKbWatcherTarget>;
  /**
   * Invoked when at least one ingestable file inside a KB has settled
   * past its debounce window. Receives the KB name; the implementation
   * decides what to re-index (typical: `updateIndex(kbName)` under the
   * write lock, which the FaissIndexManager narrows via sidecar hashes).
   */
  onChange: (kbName: string) => Promise<void>;
  /** Per-(kb, file) debounce window in milliseconds. */
  debounceMs: number;
  /** Forwarded to `filterIngestablePaths`. Operator-extensible allowlist. */
  ingestFilter?: {
    extraExtensions?: readonly string[];
    excludePaths?: readonly string[];
  };
  /**
   * Force the non-recursive (per-directory) attach mode even on
   * platforms where `{recursive: true}` is supported. Exposed for
   * tests; production code picks the mode automatically from
   * `process.platform`.
   */
  forceNonRecursive?: boolean;
}

interface PerKbState {
  kbName: string;
  kbPath: string;
  watchers: fs.FSWatcher[];
  debounceTimers: Map<string, NodeJS.Timeout>;
  inFlight: Promise<void> | null;
  pending: boolean;
}

export class RecursiveKbWatcher {
  private readonly targets: ReadonlyArray<RecursiveKbWatcherTarget>;
  private readonly onChange: (kbName: string) => Promise<void>;
  private readonly debounceMs: number;
  private readonly extraExtensions: readonly string[];
  private readonly excludePaths: readonly string[];
  private readonly forceNonRecursive: boolean;

  private readonly states: Map<string, PerKbState> = new Map();
  private started = false;
  private stopped = false;

  constructor(options: RecursiveKbWatcherOptions) {
    this.targets = options.targets;
    this.onChange = options.onChange;
    this.debounceMs = options.debounceMs;
    this.extraExtensions = options.ingestFilter?.extraExtensions ?? [];
    this.excludePaths = options.ingestFilter?.excludePaths ?? [];
    this.forceNonRecursive = options.forceNonRecursive ?? false;
  }

  /**
   * Attaches `fs.watch` to every target KB. Idempotent: a second
   * `start()` is a silent no-op so a caller can wire it into both
   * stdio and HTTP startup paths without guarding. After `stop()` the
   * instance is terminal.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;

    for (const target of this.targets) {
      const state: PerKbState = {
        kbName: target.kbName,
        kbPath: target.kbPath,
        watchers: [],
        debounceTimers: new Map(),
        inFlight: null,
        pending: false,
      };
      this.states.set(target.kbName, state);

      try {
        if (this.useRecursive()) {
          this.attachRecursive(state);
        } else {
          await this.attachPerDirectory(state);
        }
      } catch (err) {
        // ENOSPC (Linux inotify slots), ENOTSUP (some FUSE mounts), or
        // ENOENT if the KB directory vanished mid-startup — log and
        // keep going for other KBs rather than aborting the server.
        logger.warn(
          `RecursiveKbWatcher: failed to attach to ${target.kbPath} ` +
            `(${target.kbName}): ${(err as Error).message}`,
        );
      }
    }

    if (this.states.size > 0) {
      const mode = this.useRecursive() ? 'recursive' : 'per-directory';
      logger.info(
        `RecursiveKbWatcher started (${mode}); kbs=${this.targets.length} debounceMs=${this.debounceMs}`,
      );
    }
  }

  /**
   * Closes every `fs.watch` handle, clears all pending debounce timers,
   * and awaits any in-flight `onChange`. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const state of this.states.values()) {
      for (const timer of state.debounceTimers.values()) {
        clearTimeout(timer);
      }
      state.debounceTimers.clear();
      for (const watcher of state.watchers) {
        try {
          watcher.close();
        } catch {
          // Already closed (e.g. dir was removed): no recovery needed.
        }
      }
      state.watchers = [];
    }
    const drains = Array.from(this.states.values())
      .map((state) => state.inFlight)
      .filter((p): p is Promise<void> => p !== null);
    if (drains.length > 0) {
      await Promise.allSettled(drains);
    }
  }

  /**
   * Test hook — drive the debounce path deterministically without
   * waiting on real timers. Bypasses the `fs.watch` callback so a unit
   * test can assert filter + debounce + coalesce behavior on a fake
   * event without standing up a real directory tree.
   */
  handleFsEvent(kbName: string, eventTarget: string): void {
    const state = this.states.get(kbName);
    if (state === undefined) return;
    this.onRawFsEvent(state, eventTarget);
  }

  private useRecursive(): boolean {
    if (this.forceNonRecursive) return false;
    // Node 14+ supports `recursive: true` on macOS and Windows; Linux
    // gained it in 20. Per the issue, Linux/WSL gets per-directory
    // attach by default because inotify cost is the same either way
    // and operators see clearer errors when they hit a watch-slot cap.
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  private attachRecursive(state: PerKbState): void {
    const watcher = fs.watch(
      state.kbPath,
      { recursive: true },
      (_event, filename) => {
        if (filename === null) return;
        this.onRawFsEvent(state, filename.toString());
      },
    );
    watcher.on('error', (err) => {
      logger.warn(
        `RecursiveKbWatcher: error on ${state.kbPath} (${state.kbName}): ${err.message}`,
      );
    });
    state.watchers.push(watcher);
  }

  private async attachPerDirectory(state: PerKbState): Promise<void> {
    const dirs = await enumerateDirectories(state.kbPath);
    for (const dir of dirs) {
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename === null) return;
          // `filename` is relative to the watched directory; rebuild a
          // KB-root-relative path so the ingest filter sees the same
          // shape it would from the recursive mode.
          const absPath = path.join(dir, filename.toString());
          const relFromKb = path.relative(state.kbPath, absPath);
          if (relFromKb === '' || relFromKb.startsWith('..')) return;
          this.onRawFsEvent(state, relFromKb);
        });
        watcher.on('error', (err) => {
          logger.warn(
            `RecursiveKbWatcher: error on ${dir} (${state.kbName}): ${err.message}`,
          );
        });
        state.watchers.push(watcher);
      } catch (err) {
        // A subdir that disappeared between enumerate and attach is
        // not a hard error — skip it.
        logger.debug(
          `RecursiveKbWatcher: skip ${dir} (${state.kbName}): ${(err as Error).message}`,
        );
      }
    }
  }

  private onRawFsEvent(state: PerKbState, rawTarget: string): void {
    if (this.stopped) return;

    // POSIX-form the path so the ingest filter (which builds patterns
    // with forward slashes) matches identically on Windows.
    const relativePath = rawTarget.split(path.sep).join('/');
    if (relativePath === '' || relativePath === '.') return;

    // Reuse the indexer's exact filter set: dotfile / `_seen.jsonl` /
    // `logs/` / extension allowlist / operator excludes. The watcher
    // synthesises an "absolute" path under `state.kbPath` so the
    // filter's `path.relative(kbRoot, ...)` strips it back to the same
    // shape it would see for a walker-discovered file.
    const synthesizedAbs = path.join(state.kbPath, relativePath);
    const accepted = filterIngestablePaths([synthesizedAbs], state.kbPath, {
      extraExtensions: this.extraExtensions,
      excludePaths: this.excludePaths,
    });
    if (accepted.length === 0) return;

    const existing = state.debounceTimers.get(relativePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      state.debounceTimers.delete(relativePath);
      this.requestRun(state);
    }, this.debounceMs);
    if (typeof timer.unref === 'function') {
      // Same reasoning as the trigger watcher: a watcher debouncer
      // should not pin the Node event loop open after the transport
      // closes. unref() is a no-op when not supported.
      timer.unref();
    }
    state.debounceTimers.set(relativePath, timer);
  }

  private requestRun(state: PerKbState): void {
    if (this.stopped) return;
    if (state.inFlight !== null) {
      state.pending = true;
      return;
    }
    state.inFlight = this.runChange(state);
    void state.inFlight.finally(() => {
      state.inFlight = null;
      if (state.pending && !this.stopped) {
        state.pending = false;
        this.requestRun(state);
      }
    });
  }

  private async runChange(state: PerKbState): Promise<void> {
    try {
      await this.onChange(state.kbName);
    } catch (err) {
      logger.error(
        `RecursiveKbWatcher onChange failed for ${state.kbName}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Returns the KB root plus every nested directory under it. Mirrors
 * the dotfile skip in `getFilesRecursively` so we don't attach to
 * `.index/` or `.git/`. Exposed for tests that want to assert the set
 * of directories the non-recursive attach mode will subscribe to.
 */
export async function enumerateDirectories(rootDir: string): Promise<string[]> {
  const dirs: string[] = [];

  async function traverse(currentPath: string): Promise<void> {
    dirs.push(currentPath);
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      logger.debug(
        `enumerateDirectories: skip ${currentPath}: ${(err as Error).message}`,
      );
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory()) continue;
      await traverse(path.join(currentPath, entry.name));
    }
  }

  await traverse(rootDir);
  return dirs;
}
