import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// All env state is read at module load by config.ts → so each test resets
// modules and re-imports instance-lock.ts after setting env. Pattern matches
// the rest of the suite.

const originalEnv = {
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

afterEach(() => {
  if (originalEnv.FAISS_INDEX_PATH === undefined) delete process.env.FAISS_INDEX_PATH;
  else process.env.FAISS_INDEX_PATH = originalEnv.FAISS_INDEX_PATH;
});

describe('acquireInstanceAdvisory / releaseInstanceAdvisory', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-instance-lock-'));
    process.env.FAISS_INDEX_PATH = tempDir;
  });

  it('writes a PID file with current pid and mode 0o600', async () => {
    jest.resetModules();
    const { acquireInstanceAdvisory, PID_FILE_PATH_FOR_TESTS, releaseInstanceAdvisory } =
      await import('./instance-lock.js');

    await acquireInstanceAdvisory();

    const stat = await fsp.stat(PID_FILE_PATH_FOR_TESTS);
    expect((stat.mode & 0o777).toString(8)).toBe('600');
    const recorded = (await fsp.readFile(PID_FILE_PATH_FOR_TESTS, 'utf-8')).trim();
    expect(Number.parseInt(recorded, 10)).toBe(process.pid);

    await releaseInstanceAdvisory();
    await expect(fsp.stat(PID_FILE_PATH_FOR_TESTS)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws InstanceAlreadyRunningError when a live PID is recorded', async () => {
    jest.resetModules();
    const { acquireInstanceAdvisory, InstanceAlreadyRunningError, PID_FILE_PATH_FOR_TESTS } =
      await import('./instance-lock.js');

    // Seed a live PID — process.ppid is reliably alive (the shell that spawned us).
    await fsp.writeFile(PID_FILE_PATH_FOR_TESTS, `${process.ppid}\n`, { mode: 0o600 });

    await expect(acquireInstanceAdvisory()).rejects.toBeInstanceOf(InstanceAlreadyRunningError);
  });

  it('overwrites a stale PID file (recorded pid is dead)', async () => {
    jest.resetModules();
    const { acquireInstanceAdvisory, PID_FILE_PATH_FOR_TESTS, releaseInstanceAdvisory } =
      await import('./instance-lock.js');

    // PID 1 is init/systemd — alive on most systems. Use a clearly-dead PID
    // instead: spawn a child, wait for exit, capture its PID. Once the child
    // is reaped, that PID is dead until reused.
    const { spawn } = await import('child_process');
    const child = spawn('node', ['-e', 'process.exit(0)']);
    const deadPid: number = await new Promise((resolve) => {
      child.once('exit', () => resolve(child.pid!));
    });
    // Tiny wait to ensure reaper has run.
    await new Promise((r) => setTimeout(r, 50));

    await fsp.writeFile(PID_FILE_PATH_FOR_TESTS, `${deadPid}\n`, { mode: 0o600 });

    await acquireInstanceAdvisory(); // should overwrite, not throw
    const recorded = (await fsp.readFile(PID_FILE_PATH_FOR_TESTS, 'utf-8')).trim();
    expect(Number.parseInt(recorded, 10)).toBe(process.pid);
    await releaseInstanceAdvisory();
  });

  it('release is idempotent and refuses to delete other-process PID files', async () => {
    jest.resetModules();
    const { releaseInstanceAdvisory, PID_FILE_PATH_FOR_TESTS } = await import('./instance-lock.js');

    // No PID file → release is a no-op.
    await releaseInstanceAdvisory();

    // Foreign PID file → release refuses to delete.
    await fsp.writeFile(PID_FILE_PATH_FOR_TESTS, `${process.ppid}\n`, { mode: 0o600 });
    await releaseInstanceAdvisory();
    // Foreign file still there.
    await expect(fsp.stat(PID_FILE_PATH_FOR_TESTS)).resolves.toBeDefined();
    // Cleanup so afterEach doesn't see ours.
    await fsp.unlink(PID_FILE_PATH_FOR_TESTS);
  });
});
