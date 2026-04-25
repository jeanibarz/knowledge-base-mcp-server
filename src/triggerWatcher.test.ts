import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { ReindexTriggerWatcher } from './triggerWatcher.js';

/**
 * The watcher runs off `setInterval`, which makes real-time testing flaky
 * and slow. Instead we construct the instance with a large interval (so
 * the real timer never fires during the test), then call `poll()`
 * directly — it is the same method the interval calls under the hood.
 * This gives deterministic per-tick control over the scheduler.
 */
describe('ReindexTriggerWatcher (RFC 011 §5.5)', () => {
  let tempDir: string;
  let triggerPath: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-trigger-watcher-'));
    triggerPath = path.join(tempDir, '.reindex-trigger');
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  // Bump an existing file's mtime by `delta` seconds. `fs.utimes` takes
  // atime + mtime and is the only way to deterministically control
  // `stat().mtimeMs` — `touch`-via-writeFile produces whatever the host
  // clock emits next, which can equal the previous sample on fast SSDs.
  async function bumpMtime(filePath: string, delta: number): Promise<void> {
    const stat = await fsp.stat(filePath);
    const newSec = stat.mtimeMs / 1000 + delta;
    await fsp.utimes(filePath, newSec, newSec);
  }

  it('does not fire on first poll when the trigger file does not exist (ENOENT is no-op)', async () => {
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);
    await watcher.poll();
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('does not fire on the first successful stat (baseline seed, not a signal)', async () => {
    await fsp.writeFile(triggerPath, '');
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);
    await watcher.poll();
    // Pre-existing trigger file ≠ "content landed while we were running".
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('fires on the first successful stat when an earlier poll observed ENOENT (post-startup creation)', async () => {
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);

    // Poll #1: trigger file absent (workflow hasn't touched it yet).
    await watcher.poll();
    expect(onTrigger).not.toHaveBeenCalled();

    // Workflow creates the file in-between polls — this IS new content.
    await fsp.writeFile(triggerPath, '');

    // Poll #2: first successful stat. Must fire, not silently seed.
    await watcher.poll();
    await watcher.stop();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once when the trigger mtime advances', async () => {
    await fsp.writeFile(triggerPath, '');
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);
    // Seed baseline.
    await watcher.poll();
    expect(onTrigger).not.toHaveBeenCalled();

    await bumpMtime(triggerPath, 1);
    await watcher.poll();
    // Wait for the in-flight trigger to complete before asserting counts.
    await watcher.stop();

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('coalesces five rapid triggers into at most two onTrigger invocations', async () => {
    // The contract: if a trigger fires while the previous one is in
    // flight, at most ONE additional run is queued. Five bursty pokes
    // produce ≤ 2 invocations (the in-flight one + one queued tail).
    await fsp.writeFile(triggerPath, '');

    let resolveFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond: (() => void) | undefined;
    const secondInFlight = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    let callIndex = 0;
    const onTrigger = jest.fn().mockImplementation(() => {
      const idx = callIndex;
      callIndex += 1;
      if (idx === 0) return firstInFlight;
      if (idx === 1) return secondInFlight;
      return Promise.resolve();
    });

    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);
    await watcher.poll(); // seed baseline

    // Five rapid mtime bumps. The first kicks off run #1 (in-flight).
    // Runs #2-#5 all collapse into a single pending flag.
    for (let i = 0; i < 5; i += 1) {
      await bumpMtime(triggerPath, i + 1);
      await watcher.poll();
    }

    // onTrigger started for run #1; coalesced pending for one more.
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Unblock the first run; the coalesced pending run (one, not four)
    // is scheduled as a follow-up.
    resolveFirst!();
    await firstInFlight;
    // Allow the finally-callback to schedule the pending run.
    await new Promise((r) => setImmediate(r));
    expect(onTrigger).toHaveBeenCalledTimes(2);

    // Unblock the second run; nothing further is queued.
    resolveSecond!();
    await watcher.stop();

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('stop() awaits an in-flight onTrigger invocation and prevents further runs', async () => {
    await fsp.writeFile(triggerPath, '');
    let resolveRun: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const onTrigger = jest.fn().mockImplementation(() => inFlight);

    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);
    await watcher.poll(); // baseline
    await bumpMtime(triggerPath, 1);
    await watcher.poll(); // kicks off run #1 (blocked)

    // Meanwhile a second mtime advance arrives — the coalescer queues it.
    await bumpMtime(triggerPath, 2);
    await watcher.poll();

    // stop() should drain: resolve the first run, skip the queued one.
    const stopPromise = watcher.stop();
    resolveRun!();
    await stopPromise;

    // Only the in-flight invocation got to run; the queued follow-up is
    // suppressed because `stopped === true` when the finally-callback
    // tries to reschedule.
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Further polls after stop() are no-ops.
    await bumpMtime(triggerPath, 3);
    await watcher.poll();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('keeps running when onTrigger throws — next mtime advance re-invokes normally', async () => {
    await fsp.writeFile(triggerPath, '');
    const onTrigger = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 60_000);
    await watcher.poll(); // baseline
    await bumpMtime(triggerPath, 1);
    await watcher.poll(); // run #1 rejects

    // Allow the catch in runTrigger to settle.
    await new Promise((r) => setImmediate(r));

    await bumpMtime(triggerPath, 2);
    await watcher.poll(); // run #2 succeeds
    await watcher.stop();

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('pollMs=0 disables the interval but start()/stop() remain safe to call', async () => {
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 0);
    expect(() => watcher.start()).not.toThrow();
    await expect(watcher.stop()).resolves.toBeUndefined();
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('start() installs a timer that invokes poll() periodically', async () => {
    // Smoke test the real-timer path at a short interval — this is the
    // only test that exercises setInterval directly; the rest drive
    // poll() by hand. Kept short (200ms) so it never dominates the suite.
    await fsp.writeFile(triggerPath, '');
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const watcher = new ReindexTriggerWatcher(triggerPath, onTrigger, 50);
    watcher.start();

    // Two ticks: first seeds the baseline, second+ can fire if mtime advances.
    // Bump mtime after the baseline tick so the second tick sees it.
    await new Promise((r) => setTimeout(r, 80));
    await bumpMtime(triggerPath, 1);
    await new Promise((r) => setTimeout(r, 200));

    await watcher.stop();
    expect(onTrigger).toHaveBeenCalled();
  });
});
