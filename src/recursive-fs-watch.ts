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
//      startup, then attach more watches when new subdirectories appear
//      after start (issue #893). Native recursive mode already delivers
//      those events; per-directory `fs.watch` does not follow children
//      created later, so we must discover them ourselves.
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
  /** Absolute paths that already have a per-directory watcher. */
  watchedDirs: Set<string>;
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
        watchedDirs: new Set(),
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
      state.watchedDirs.clear();
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

  /**
   * Test hook — run the per-directory "new subdirectory" discovery
   * path without waiting on a real `fs.watch` event. Covers the
   * mkdir-then-immediate-write race and duplicate-attach guard
   * without depending on inotify timing.
   */
  async handlePossibleNewDirectory(kbName: string, eventTarget: string): Promise<void> {
    const state = this.states.get(kbName);
    if (state === undefined) return;
    const relativePath = eventTarget.split(path.sep).join('/');
    const absPath = path.join(state.kbPath, relativePath);
    // Same shape as a real per-directory `fs.watch` callback: `filename`
    // is one path segment relative to the already-watched parent.
    await this.onPerDirectoryFsEvent(state, path.dirname(absPath), path.basename(absPath));
  }

  /**
   * Test hook — number of per-directory `fs.watch` handles currently
   * attached for a KB. Recursive mode never populates this set.
   */
  watchedDirectoryCount(kbName: string): number {
    const state = this.states.get(kbName);
    if (state === undefined) return 0;
    return state.watchedDirs.size;
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
      this.watchDirectory(state, dir);
    }
  }

  /**
   * Attach one non-recursive `fs.watch` to `dir` if this KB does not
   * already have one. Claim the path before `fs.watch` so a re-entrant
   * discovery (parent event + nested walk) cannot open a second handle.
   */
  private watchDirectory(state: PerKbState, dir: string): void {
    if (this.stopped) return;
    const absDir = path.resolve(dir);
    if (state.watchedDirs.has(absDir)) return;
    state.watchedDirs.add(absDir);
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        void this.onPerDirectoryFsEvent(state, dir, filename);
      });
      watcher.on('error', (err) => {
        // Deleted-dir / dead-inode errors leave a stale claim that
        // would block re-attach if the same path is created again.
        state.watchedDirs.delete(absDir);
        logger.warn(
          `RecursiveKbWatcher: error on ${dir} (${state.kbName}): ${err.message}`,
        );
      });
      state.watchers.push(watcher);
    } catch (err) {
      // A subdir that disappeared between enumerate and attach, or an
      // inotify slot exhaustion on this one dir, is not a hard error —
      // drop the claim so a later event can retry.
      state.watchedDirs.delete(absDir);
      logger.debug(
        `RecursiveKbWatcher: skip ${dir} (${state.kbName}): ${(err as Error).message}`,
      );
    }
  }

  private onPerDirectoryFsEvent(
    state: PerKbState,
    dir: string,
    filename: string | Buffer | null,
  ): Promise<void> {
    if (filename === null || filename.toString() === '') return Promise.resolve();
    // `filename` is relative to the watched directory; rebuild a
    // KB-root-relative path so the ingest filter sees the same
    // shape it would from the recursive mode.
    const absPath = path.join(dir, filename.toString());
    const relFromKb = path.relative(state.kbPath, absPath);
    if (relFromKb === '' || relFromKb.startsWith('..')) return Promise.resolve();
    this.onRawFsEvent(state, relFromKb);
    // Directory-creation events fail the ingest allowlist (no
    // extension), so discovery lives here rather than in
    // `onRawFsEvent`. Recursive mode never calls this method.
    return this.discoverNewDirectory(state, absPath).catch((err) => {
      logger.debug(
        `RecursiveKbWatcher: discover ${absPath} (${state.kbName}): ${(err as Error).message}`,
      );
    });
  }

  /**
   * When a per-directory event names a newly created subdirectory,
   * attach watchers to it (and any directories already nested inside)
   * and emit events for files already present. The listing step is
   * what closes the mkdir-then-immediate-write race: a file written
   * before the new watcher is attached never generates its own event.
   */
  private async discoverNewDirectory(state: PerKbState, absPath: string): Promise<void> {
    if (this.stopped || this.useRecursive()) return;

    const relFromKb = path.relative(state.kbPath, absPath);
    if (relFromKb === '' || relFromKb.startsWith('..')) return;
    // Same skip as `enumerateDirectories`: `.index/` and `.git/` are
    // indexer / vcs sidecars, never corpus.
    if (relFromKb.split(path.sep).some((segment) => segment.startsWith('.'))) return;

    const resolved = path.resolve(absPath);
    let st: fs.Stats;
    try {
      // lstat, not stat: a symlink whose name sits inside the KB must
      // not pull us into the target tree. Startup enumeration uses
      // dirent.isDirectory(), which likewise does not follow links.
      st = await fsp.lstat(absPath);
    } catch {
      // Path vanished (typical: rmdir of a previously watched dir).
      // Drop the claim so a later mkdir of the same name can attach.
      state.watchedDirs.delete(resolved);
      return;
    }
    if (!st.isDirectory()) return;
    if (state.watchedDirs.has(resolved)) return;

    const dirs = await enumerateDirectories(absPath);
    if (this.stopped) return;

    for (const dir of dirs) {
      const wasNew = !state.watchedDirs.has(path.resolve(dir));
      this.watchDirectory(state, dir);
      if (wasNew) {
        await this.emitExistingFiles(state, dir);
        if (this.stopped) return;
      }
    }
  }

  private async emitExistingFiles(state: PerKbState, dir: string): Promise<void> {
    if (this.stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      logger.debug(
        `RecursiveKbWatcher: list ${dir} (${state.kbName}): ${(err as Error).message}`,
      );
      return;
    }
    for (const entry of entries) {
      if (this.stopped) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) continue;
      const absPath = path.join(dir, entry.name);
      const relFromKb = path.relative(state.kbPath, absPath);
      if (relFromKb === '' || relFromKb.startsWith('..')) continue;
      this.onRawFsEvent(state, relFromKb);
    }
  }

  private onRawFsEvent(state: PerKbState, rawTarget: string): void {
    if (this.stopped) return;

    // POSIX-form the path so the ingest filter (which builds patterns
    // with forward slashes) matches identically on Windows.
    const relativePath = rawTarget.split(path.sep).join('/');
    if (relativePath === '' || relativePath === '.') return;

    // Reuse the indexer's exact filter set: dotfile / `_seen.jsonl` /
    // `logs/` / extension allowlist / operator excludes. Directory
    // creation is not handled here — a new dir has no ingestible
    // extension, and attaching extra watches from this shared path
    // would change recursive (macOS/Windows) behavior. The watcher
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
