// Issue #645 — unit tests for the disk-space preflight guard.
//
// Coverage:
//  - resolveMinFreeDiskBytes: env parsing + fallback to the default margin.
//  - evaluateDiskSpace: the pure sufficient/insufficient compare + clamping.
//  - formatBytes: human-readable message formatting.
//  - directorySizeBytes: recursive sizing of a real temp tree (+ ENOENT → 0).
//  - assertSufficientDiskSpace: throws the typed KBError with a "need ~X,
//    have Y" message when space is short (mocked statfs / current bytes),
//    passes when ample, and degrades gracefully when statfs fails.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_REINDEX_ESTIMATE_FACTOR,
  assertSufficientDiskSpace,
  availableDiskBytes,
  directorySizeBytes,
  evaluateDiskSpace,
  formatBytes,
  resolveMinFreeDiskBytes,
} from './disk-preflight.js';
import { KBError } from './errors.js';

const MiB = 1024 * 1024;

describe('resolveMinFreeDiskBytes (issue #645)', () => {
  it('returns the default margin when unset or empty', () => {
    expect(resolveMinFreeDiskBytes(undefined)).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
    expect(resolveMinFreeDiskBytes('')).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
    expect(resolveMinFreeDiskBytes('   ')).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
  });

  it('parses a valid non-negative integer', () => {
    expect(resolveMinFreeDiskBytes('0')).toBe(0);
    expect(resolveMinFreeDiskBytes('1048576')).toBe(MiB);
    expect(resolveMinFreeDiskBytes('123.9')).toBe(123); // floored
  });

  it('falls back to the default on garbage or negative input', () => {
    expect(resolveMinFreeDiskBytes('abc')).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
    expect(resolveMinFreeDiskBytes('-5')).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
    expect(resolveMinFreeDiskBytes('NaN')).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
  });
});

describe('evaluateDiskSpace (issue #645)', () => {
  it('is sufficient when available >= estimate + margin', () => {
    const e = evaluateDiskSpace({ estimatedBytes: 100, availableBytes: 250, marginBytes: 150 });
    expect(e.required_bytes).toBe(250);
    expect(e.sufficient).toBe(true);
  });

  it('is insufficient when available < estimate + margin', () => {
    const e = evaluateDiskSpace({ estimatedBytes: 100, availableBytes: 249, marginBytes: 150 });
    expect(e.required_bytes).toBe(250);
    expect(e.sufficient).toBe(false);
  });

  it('treats exact equality as sufficient', () => {
    const e = evaluateDiskSpace({ estimatedBytes: 100, availableBytes: 100, marginBytes: 0 });
    expect(e.sufficient).toBe(true);
  });

  it('clamps negative / non-finite inputs to zero', () => {
    const e = evaluateDiskSpace({
      estimatedBytes: -10,
      availableBytes: Number.NaN,
      marginBytes: -1,
    });
    expect(e.estimated_bytes).toBe(0);
    expect(e.available_bytes).toBe(0);
    expect(e.margin_bytes).toBe(0);
    expect(e.required_bytes).toBe(0);
    expect(e.sufficient).toBe(true);
  });
});

describe('formatBytes (issue #645)', () => {
  it('renders 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(512 * MiB)).toBe('512 MiB');
    expect(formatBytes(2 * 1024 * MiB)).toBe('2 GiB');
  });

  it('handles non-positive / non-finite input', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('availableDiskBytes (issue #645)', () => {
  it('multiplies bavail by bsize from the injected statfs', async () => {
    const bytes = await availableDiskBytes('/whatever', async () => ({ bavail: 10, bsize: 4096 }));
    expect(bytes).toBe(40960);
  });
});

describe('directorySizeBytes (issue #645)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-disk-preflight-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('returns 0 for a non-existent directory (never indexed)', async () => {
    expect(await directorySizeBytes(path.join(dir, 'missing'))).toBe(0);
  });

  it('sums file sizes recursively across nested directories', async () => {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(100));
    const sub = path.join(dir, 'nested', 'deep');
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, 'b.bin'), Buffer.alloc(250));
    expect(await directorySizeBytes(dir)).toBe(350);
  });
});

describe('assertSufficientDiskSpace (issue #645)', () => {
  const okStatfs = (availableBytes: number) => async () => ({ bavail: availableBytes, bsize: 1 });

  it('returns the estimate when space is ample', async () => {
    const estimate = await assertSufficientDiskSpace('/index', {
      currentBytes: 1000,
      estimateFactor: 2,
      minFreeBytes: 500,
      statfs: okStatfs(10_000),
    });
    expect(estimate.estimated_bytes).toBe(2000); // 1000 * factor 2
    expect(estimate.required_bytes).toBe(2500); // + 500 margin
    expect(estimate.available_bytes).toBe(10_000);
    expect(estimate.sufficient).toBe(true);
  });

  it('throws a typed INSUFFICIENT_DISK_SPACE KBError when space is short', async () => {
    expect.assertions(4);
    try {
      await assertSufficientDiskSpace('/index', {
        currentBytes: 4 * MiB,
        estimateFactor: 1.5,
        minFreeBytes: 2 * MiB,
        statfs: okStatfs(5 * MiB),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(KBError);
      expect((err as KBError).code).toBe('INSUFFICIENT_DISK_SPACE');
      // need = 6 MiB estimate + 2 MiB margin = 8 MiB; have 5 MiB.
      expect((err as KBError).message).toMatch(/need ~8 MiB/);
      expect((err as KBError).message).toMatch(/have 5 MiB free/);
    }
  });

  it('applies the default estimate factor when not overridden', async () => {
    // current 1000 * 1.5 = 1500 estimate; margin 0; available 1500 → exact fit.
    const estimate = await assertSufficientDiskSpace('/index', {
      currentBytes: 1000,
      minFreeBytes: 0,
      statfs: okStatfs(1500),
    });
    expect(estimate.estimated_bytes).toBe(Math.ceil(1000 * DEFAULT_REINDEX_ESTIMATE_FACTOR));
    expect(estimate.sufficient).toBe(true);
  });

  it('degrades gracefully (no throw) when statfs is unavailable', async () => {
    const estimate = await assertSufficientDiskSpace('/index', {
      currentBytes: 9_999_999,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      statfs: async () => {
        throw new Error('statfs not supported');
      },
    });
    expect(estimate.sufficient).toBe(true);
    expect(estimate.available_bytes).toBe(Number.POSITIVE_INFINITY);
  });
});
