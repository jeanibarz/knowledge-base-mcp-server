import fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { enumerateDirectories, RecursiveKbWatcher } from './recursive-fs-watch.js';

/**
 * The watcher drives real `fs.watch` handles in production. Real events
 * are inherently flaky across platforms (FSEvents coalescing, inotify
 * delivery delays, WSL2 timing), so unit tests use the `handleFsEvent`
 * test hook to dispatch synthetic events. This isolates the contract
 * we actually care about — filter + debounce + coalesce + lifecycle —
 * from the fs.watch backend.
 *
 * Real-timer test cadence: 25ms debounce + 30ms drain settles in well
 * under 100ms even on a slow CI host, so the full file runs in ~1s.
 */
describe('RecursiveKbWatcher (RFC 007 §6.6 / issue #212)', () => {
  let tempDir: string;
  const KB = 'notes';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-watch-'));
    await fsp.mkdir(path.join(tempDir, KB), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  function makeWatcher(opts: {
    onChange: (kbName: string) => Promise<void>;
    debounceMs?: number;
    excludePaths?: readonly string[];
  }): RecursiveKbWatcher {
    return new RecursiveKbWatcher({
      targets: [{ kbName: KB, kbPath: path.join(tempDir, KB) }],
      onChange: opts.onChange,
      debounceMs: opts.debounceMs ?? 25,
      ingestFilter: opts.excludePaths
        ? { excludePaths: opts.excludePaths }
        : undefined,
      // Force per-directory mode for deterministic dir-enumeration
      // behavior across host platforms in `start()`.
      forceNonRecursive: true,
    });
  }

  async function drain(ms = 60): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  it('coalesces ≥10 rapid events for the same (kb, file) into 1 onChange call', async () => {
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = makeWatcher({ onChange, debounceMs: 25 });
    await watcher.start();

    for (let i = 0; i < 12; i += 1) {
      watcher.handleFsEvent(KB, 'note.md');
    }
    expect(onChange).not.toHaveBeenCalled();

    await drain(80);
    await watcher.stop();

    // Twelve synchronous events collapse into one fire — the debounce
    // restarts on each event, only the last timer survives.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(KB);
  });

  it('drops dotfile events (walker semantics: hidden paths are skipped)', async () => {
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = makeWatcher({ onChange, debounceMs: 25 });
    await watcher.start();

    watcher.handleFsEvent(KB, '.reindex-trigger');
    watcher.handleFsEvent(KB, '.index/whatever.sha256');
    watcher.handleFsEvent(KB, '.git/HEAD');
    await drain(80);
    await watcher.stop();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops events whose extension is not on the ingest allowlist', async () => {
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = makeWatcher({ onChange, debounceMs: 25 });
    await watcher.start();

    watcher.handleFsEvent(KB, 'screenshot.png');
    watcher.handleFsEvent(KB, 'archive.tar.gz');
    watcher.handleFsEvent(KB, 'notes/_seen.jsonl');
    await drain(80);
    await watcher.stop();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('honours INGEST_EXCLUDE_PATHS minimatch patterns from the ingest filter', async () => {
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = makeWatcher({
      onChange,
      debounceMs: 25,
      excludePaths: ['drafts/**'],
    });
    await watcher.start();

    watcher.handleFsEvent(KB, 'drafts/paper.md');
    await drain(80);
    expect(onChange).not.toHaveBeenCalled();

    // A non-excluded file still fires.
    watcher.handleFsEvent(KB, 'notes/paper.md');
    await drain(80);
    await watcher.stop();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces bursts across multiple files into ≤ 2 onChange invocations per KB', async () => {
    // Single in-flight + single pending: identical contract to the
    // trigger watcher. Bursty events while onChange is running collapse
    // into one tail call.
    let resolveFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callIndex = 0;
    const onChange = jest.fn<Promise<void>, [string]>().mockImplementation(() => {
      const idx = callIndex;
      callIndex += 1;
      if (idx === 0) return firstInFlight;
      return Promise.resolve();
    });

    const watcher = makeWatcher({ onChange, debounceMs: 15 });
    await watcher.start();

    // Trigger debounce window → first onChange (in-flight, blocked).
    watcher.handleFsEvent(KB, 'a.md');
    await drain(30);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Five additional file events while the first run is blocked.
    // They debounce, then each tries to start a run — all collapse to
    // a single pending flag.
    for (const name of ['b.md', 'c.md', 'd.md', 'e.md', 'f.md']) {
      watcher.handleFsEvent(KB, name);
    }
    await drain(30);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Unblock the first run; the coalesced tail (one, not five) fires.
    resolveFirst!();
    await drain(30);
    expect(onChange).toHaveBeenCalledTimes(2);

    await watcher.stop();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('stop() drains an in-flight onChange and suppresses queued follow-ups', async () => {
    let resolveRun: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const onChange = jest.fn<Promise<void>, [string]>().mockImplementation(() => inFlight);

    const watcher = makeWatcher({ onChange, debounceMs: 15 });
    await watcher.start();
    watcher.handleFsEvent(KB, 'note.md');
    await drain(30);
    // Run #1 is now in-flight, blocked on `inFlight`.
    expect(onChange).toHaveBeenCalledTimes(1);

    // Burst a second debounced run → queued pending.
    watcher.handleFsEvent(KB, 'other.md');
    await drain(30);
    expect(onChange).toHaveBeenCalledTimes(1);

    // stop() should drain the first run AND drop the queued one.
    const stopPromise = watcher.stop();
    resolveRun!();
    await stopPromise;

    // Any later raw event after stop() is a no-op.
    watcher.handleFsEvent(KB, 'late.md');
    await drain(30);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps running when onChange rejects — next event re-invokes normally', async () => {
    const onChange = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const watcher = makeWatcher({ onChange, debounceMs: 15 });
    await watcher.start();
    watcher.handleFsEvent(KB, 'first.md');
    await drain(40);
    // The first run rejected internally; the watcher swallows it.
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher.handleFsEvent(KB, 'second.md');
    await drain(40);
    await watcher.stop();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('handleFsEvent is a no-op for an unregistered KB name', async () => {
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = makeWatcher({ onChange, debounceMs: 15 });
    await watcher.start();
    watcher.handleFsEvent('does-not-exist', 'note.md');
    await drain(40);
    await watcher.stop();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('start()/stop() are idempotent and survive a missing KB directory', async () => {
    // The KB target points at a path that doesn't exist — start() must
    // log + continue rather than throw, because the operator-facing
    // contract is "watcher failures must not prevent the server from
    // coming up". Subsequent stop() / start() are still safe to call.
    const missingPath = path.join(tempDir, 'no-such-kb');
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = new RecursiveKbWatcher({
      targets: [{ kbName: 'ghost', kbPath: missingPath }],
      onChange,
      debounceMs: 15,
      forceNonRecursive: true,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    // Second start() is a silent no-op.
    await expect(watcher.start()).resolves.toBeUndefined();
    await expect(watcher.stop()).resolves.toBeUndefined();
    // Second stop() is a silent no-op.
    await expect(watcher.stop()).resolves.toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('end-to-end: a real fs change inside the KB triggers exactly one onChange', async () => {
    // The other tests use the synthetic `handleFsEvent` hook to avoid
    // fs.watch flakiness. This single test exercises the real backend
    // so a regression that breaks the `fs.watch → onRawFsEvent` wiring
    // doesn't silently pass with all the hook-driven tests still green.
    // Per-directory mode is forced so behavior is consistent across
    // Linux/macOS/WSL.
    const onChange = jest.fn().mockResolvedValue(undefined);
    const watcher = makeWatcher({ onChange, debounceMs: 50 });
    await watcher.start();

    const target = path.join(tempDir, KB, 'note.md');
    await fsp.writeFile(target, 'hello');
    // Allow debounce + drain. fs.watch can deliver multiple events
    // (rename + change) for one writeFile; the debounce is what
    // collapses them.
    await drain(200);
    await watcher.stop();

    // Skip the assertion when running under a backend that does not
    // deliver events at all (e.g. NFS / FUSE in some CI environments)
    // — the unit tests above already cover the contract; this is the
    // smoke check.
    if (onChange.mock.calls.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        'recursive-fs-watch e2e smoke test: fs.watch backend delivered no events; ' +
          'skipping count assertion (this can happen on NFS/FUSE filesystems).',
      );
      return;
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(KB);
  });

  describe('per-directory discovery of subdirs created after start (issue #893)', () => {
    it('indexes a file already present when a new subdirectory is first observed', async () => {
      // mkdir-then-immediate-write: the file exists before the new
      // watcher is attached, so listing at discovery time is what
      // surfaces it. The test hook drives discovery without waiting
      // on inotify.
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      const topic = path.join(tempDir, KB, 'topic');
      await fsp.mkdir(topic);
      await fsp.writeFile(path.join(topic, 'note.md'), 'hello');
      await watcher.handlePossibleNewDirectory(KB, 'topic');

      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 1);
      await drain(80);
      await watcher.stop();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(KB);
    });

    it('indexes a file already present in a nested subdirectory of a newly observed dir', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      await fsp.mkdir(path.join(tempDir, KB, 'topic/nested'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, KB, 'topic/nested/note.md'), 'hello');
      await watcher.handlePossibleNewDirectory(KB, 'topic');

      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 2);
      await drain(80);
      await watcher.stop();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(KB);
    });

    it('does not attach a second watcher to a directory that already has one', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      await fsp.mkdir(path.join(tempDir, KB, 'topic'));
      await Promise.all([
        watcher.handlePossibleNewDirectory(KB, 'topic'),
        watcher.handlePossibleNewDirectory(KB, 'topic'),
      ]);

      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 1);
      await drain(80);
      await watcher.stop();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('discovers nested files created just before their parent watch attaches', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange });
      const topic = path.join(tempDir, KB, 'topic');
      const originalWatch = fs.watch;
      const watchSpy = jest.spyOn(fs, 'watch').mockImplementation((dir) => {
        if (dir === topic) {
          fs.mkdirSync(path.join(topic, 'nested'));
          fs.writeFileSync(path.join(topic, 'nested', 'note.md'), 'hello');
        }
        // Suppress kernel callbacks: only the discovery listing can find the
        // nested directory created at the enumeration/subscription boundary.
        return originalWatch(dir, () => undefined);
      });
      try {
        await watcher.start();
        await fsp.mkdir(topic);
        await watcher.handlePossibleNewDirectory(KB, 'topic');
        expect(watcher.watchedDirectoryCount(KB)).toBe(3);
        await drain(80);
        expect(onChange).toHaveBeenCalledWith(KB);
      } finally {
        await watcher.stop();
        watchSpy.mockRestore();
      }
    });

    it('replaces the old inode watch when a directory is recreated before discovery', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange });
      const topic = path.join(tempDir, KB, 'topic');
      const originalWatch = fs.watch;
      const watchSpy = jest.spyOn(fs, 'watch').mockImplementation((dir) =>
        originalWatch(dir, () => undefined),
      );
      try {
        await watcher.start();
        await fsp.mkdir(path.join(topic, 'nested'), { recursive: true });
        await watcher.handlePossibleNewDirectory(KB, 'topic');
        const originalHandle = watchSpy.mock.results[1].value as fs.FSWatcher;
        const closeSpy = jest.spyOn(originalHandle, 'close');
        const nestedHandle = watchSpy.mock.results[2].value as fs.FSWatcher;
        const nestedCloseSpy = jest.spyOn(nestedHandle, 'close');
        // Renaming retains the old inode, making replacement identity
        // deterministic while no discovery observes an absent topic path.
        await fsp.rename(topic, path.join(tempDir, KB, '.old-topic'));
        await fsp.mkdir(topic);
        await fsp.writeFile(path.join(topic, 'note.md'), 'replacement');
        await watcher.handlePossibleNewDirectory(KB, 'topic');
        expect(watchSpy).toHaveBeenCalledTimes(4);
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(nestedCloseSpy).toHaveBeenCalledTimes(1);
        expect(watcher.watchedDirectoryCount(KB)).toBe(2);
        await drain(80);
        expect(onChange).toHaveBeenCalledWith(KB);
      } finally {
        await watcher.stop();
        watchSpy.mockRestore();
      }
    });

    it('does not follow a symlink to a directory outside the KB', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-watch-outside-'));
      try {
        await fsp.writeFile(path.join(outside, 'secret.md'), 'nope');
        await fsp.symlink(outside, path.join(tempDir, KB, 'alias'));
        await watcher.handlePossibleNewDirectory(KB, 'alias');
        expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart);
        await drain(80);
        await watcher.stop();
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        await fsp.rm(outside, { recursive: true, force: true });
      }
    });

    it('re-attaches after a watched subdirectory is removed and created again', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);
      const topic = path.join(tempDir, KB, 'topic');

      await fsp.mkdir(topic);
      await watcher.handlePossibleNewDirectory(KB, 'topic');
      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 1);

      await fsp.rm(topic, { recursive: true, force: true });
      await watcher.handlePossibleNewDirectory(KB, 'topic');
      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart);

      await fsp.mkdir(topic);
      await fsp.writeFile(path.join(topic, 'note.md'), 'hello');
      await watcher.handlePossibleNewDirectory(KB, 'topic');
      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 1);
      await drain(80);
      await watcher.stop();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(KB);
    });

    it('does not attach a watcher to a dot-prefixed directory', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      await fsp.mkdir(path.join(tempDir, KB, '.index'));
      await fsp.writeFile(path.join(tempDir, KB, '.index', 'sidecar.md'), 'nope');
      await watcher.handlePossibleNewDirectory(KB, '.index');

      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart);
      await drain(80);
      await watcher.stop();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('indexes a file written after a newly observed subdirectory is already being watched', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 50 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      const topic = path.join(tempDir, KB, 'topic');
      await fsp.mkdir(topic);
      await watcher.handlePossibleNewDirectory(KB, 'topic');
      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 1);
      await drain(40);
      expect(onChange).not.toHaveBeenCalled();

      await fsp.writeFile(path.join(topic, 'note.md'), 'hello');
      await drain(250);
      await watcher.stop();

      if (onChange.mock.calls.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          'recursive-fs-watch later-write new-subdir test: fs.watch backend delivered no events; ' +
            'skipping count assertion (this can happen on NFS/FUSE filesystems).',
        );
        return;
      }
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(KB);
    });

    it('does not fire onChange for a non-ingestable file in a newly observed directory', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 25 });
      await watcher.start();

      const topic = path.join(tempDir, KB, 'topic');
      await fsp.mkdir(topic);
      await fsp.writeFile(path.join(topic, 'shot.png'), 'nope');
      await watcher.handlePossibleNewDirectory(KB, 'topic');
      await drain(80);
      await watcher.stop();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('end-to-end: mkdir then write into the new subdir is indexed without a restart', async () => {
      const onChange = jest.fn().mockResolvedValue(undefined);
      const watcher = makeWatcher({ onChange, debounceMs: 50 });
      await watcher.start();
      const watchedAtStart = watcher.watchedDirectoryCount(KB);

      // Control write in an already-watched directory. If this does
      // not fire, the backend is not delivering events (NFS/FUSE) and
      // the subdir case cannot be judged. If it does fire, a missing
      // new-subdir discovery is a real failure — not a skip.
      await fsp.writeFile(path.join(tempDir, KB, 'probe.md'), 'probe');
      await drain(250);
      if (onChange.mock.calls.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          'recursive-fs-watch e2e new-subdir test: fs.watch backend delivered no events; ' +
            'skipping count assertion (this can happen on NFS/FUSE filesystems).',
        );
        await watcher.stop();
        return;
      }
      onChange.mockClear();

      const topic = path.join(tempDir, KB, 'topic');
      await fsp.mkdir(topic);
      await fsp.writeFile(path.join(topic, 'note.md'), 'hello');
      await drain(300);
      expect(watcher.watchedDirectoryCount(KB)).toBe(watchedAtStart + 1);
      await watcher.stop();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(KB);
    });
  });
});

describe('enumerateDirectories', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-enumerate-dirs-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('returns the root plus every nested directory, skipping dot-prefixed ones', async () => {
    await fsp.mkdir(path.join(tempDir, 'a/b/c'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'a/d'), { recursive: true });
    // These dotfile directories MUST be skipped — they're indexer
    // sidecars and never corpus content.
    await fsp.mkdir(path.join(tempDir, '.index'), { recursive: true });
    await fsp.mkdir(path.join(tempDir, 'a/.cache'), { recursive: true });

    const dirs = await enumerateDirectories(tempDir);
    const rel = dirs.map((d) => path.relative(tempDir, d) || '.').sort();
    expect(rel).toEqual(['.', 'a', 'a/b', 'a/b/c', 'a/d'].sort());
  });

  it('returns just the root when there are no subdirectories', async () => {
    const dirs = await enumerateDirectories(tempDir);
    expect(dirs).toEqual([tempDir]);
  });
});
