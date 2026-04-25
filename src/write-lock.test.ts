import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// All env state is read at module load by config.ts → so each test resets
// modules and re-imports write-lock.ts after setting env. Pattern matches
// the rest of the suite.

const originalEnv = {
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

afterEach(() => {
  if (originalEnv.FAISS_INDEX_PATH === undefined) delete process.env.FAISS_INDEX_PATH;
  else process.env.FAISS_INDEX_PATH = originalEnv.FAISS_INDEX_PATH;
});

describe('withWriteLock', () => {
  let tempDir: string;
  let lockPath: string;
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-write-lock-'));
    process.env.FAISS_INDEX_PATH = tempDir;
    lockPath = path.join(tempDir, '.kb-write.lock');
  });

  it('acquires the lock, runs fn, releases', async () => {
    jest.resetModules();
    const { withWriteLock } = await import('./write-lock.js');

    let observed: { lockedDuringFn: boolean } = { lockedDuringFn: false };
    const result = await withWriteLock(tempDir, async () => {
      // Lock dir should exist while fn runs.
      observed.lockedDuringFn = await fsp
        .stat(lockPath)
        .then(() => true)
        .catch(() => false);
      return 'value';
    });
    expect(result).toBe('value');
    expect(observed.lockedDuringFn).toBe(true);
    // Lock released after fn.
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent callers (second waits for the first)', async () => {
    jest.resetModules();
    const { withWriteLock } = await import('./write-lock.js');

    const events: string[] = [];
    const slow = withWriteLock(tempDir, async () => {
      events.push('slow:start');
      await new Promise((r) => setTimeout(r, 200));
      events.push('slow:end');
    });
    // Tiny gap so the slow one definitely owns the lock first.
    await new Promise((r) => setTimeout(r, 20));
    const fast = withWriteLock(tempDir, async () => {
      events.push('fast:start');
      events.push('fast:end');
    });
    await Promise.all([slow, fast]);
    // The fast one must observe slow:end before its own start.
    expect(events).toEqual(['slow:start', 'slow:end', 'fast:start', 'fast:end']);
  });

  it('releases the lock even if fn throws', async () => {
    jest.resetModules();
    const { withWriteLock } = await import('./write-lock.js');

    await expect(
      withWriteLock(tempDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // No stranded lock.
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates per-resource: two different resources do not contend (RFC 013 M1+M2 prep)', async () => {
    jest.resetModules();
    const { withWriteLock } = await import('./write-lock.js');

    const resA = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-write-lock-a-'));
    const resB = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-write-lock-b-'));

    const events: string[] = [];
    const a = withWriteLock(resA, async () => {
      events.push('a:start');
      await new Promise((r) => setTimeout(r, 100));
      events.push('a:end');
    });
    // B starts while A holds A's lock; different resource, must not block.
    await new Promise((r) => setTimeout(r, 10));
    const b = withWriteLock(resB, async () => {
      events.push('b:start');
      events.push('b:end');
    });
    await Promise.all([a, b]);
    // B's start must precede A's end (no contention across resources).
    const bStart = events.indexOf('b:start');
    const aEnd = events.indexOf('a:end');
    expect(bStart).toBeLessThan(aEnd);
  });
});
