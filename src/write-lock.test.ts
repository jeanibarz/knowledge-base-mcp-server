import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';

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
    const { withWriteLock, writeLockOwnerPathFor } = await import('./write-lock.js');

    let observed: { lockedDuringFn: boolean; ownerPid: number | null } = {
      lockedDuringFn: false,
      ownerPid: null,
    };
    const result = await withWriteLock(tempDir, async () => {
      // Lock dir should exist while fn runs.
      observed.lockedDuringFn = await fsp
        .stat(lockPath)
        .then(() => true)
        .catch(() => false);
      const owner = JSON.parse(await fsp.readFile(writeLockOwnerPathFor(tempDir), 'utf-8')) as { pid: number };
      observed.ownerPid = owner.pid;
      return 'value';
    });
    expect(result).toBe('value');
    expect(observed.lockedDuringFn).toBe(true);
    expect(observed.ownerPid).toBe(process.pid);
    // Lock released after fn.
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(writeLockOwnerPathFor(tempDir))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('surfaces exhausted contention as a structured error', async () => {
    jest.resetModules();
    const { withWriteLock, WriteLockContentionError } = await import('./write-lock.js');

    const release = await properLockfile.lock(tempDir, { lockfilePath: lockPath });
    try {
      await expect(withWriteLock(tempDir, async () => undefined))
        .rejects.toMatchObject({
          code: 'REFRESH_LOCK_BUSY',
          lockPath,
          resource: tempDir,
        });
      await expect(withWriteLock(tempDir, async () => undefined))
        .rejects.toBeInstanceOf(WriteLockContentionError);
    } finally {
      await release();
    }
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

describe('withSidecarLock', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sidecar-lock-'));
    process.env.FAISS_INDEX_PATH = tempDir;
  });

  it('acquires the shared sidecar lock, runs fn, releases', async () => {
    jest.resetModules();
    const { sidecarLockPathFor, withSidecarLock } = await import('./write-lock.js');
    const lockPath = sidecarLockPathFor();

    let lockedDuringFn = false;
    const result = await withSidecarLock(async () => {
      lockedDuringFn = await fsp
        .stat(lockPath)
        .then(() => true)
        .catch(() => false);
      return 'value';
    });

    expect(result).toBe('value');
    expect(lockedDuringFn).toBe(true);
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the shared sidecar lock even if fn throws', async () => {
    jest.resetModules();
    const { sidecarLockPathFor, withSidecarLock } = await import('./write-lock.js');
    const lockPath = sidecarLockPathFor();

    await expect(
      withSidecarLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
