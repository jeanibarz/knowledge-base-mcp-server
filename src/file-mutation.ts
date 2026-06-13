import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { assertKbWritePolicyAllowsMutation } from './kb-write-policy.js';

interface AtomicWriteHooks {
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

interface FileMutationOptions {
  kbDir?: string;
}

const FILE_MUTATION_LOCK_OPTS: Omit<properLockfile.LockOptions, 'lockfilePath'> = {
  stale: 30_000,
  retries: { retries: 50, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
};

export async function appendFileAtomically(
  targetPath: string,
  content: string,
  options: FileMutationOptions = {},
): Promise<void> {
  await rewriteFileAtomically(targetPath, (original) => `${original}${content}`, options);
}

export async function rewriteFileAtomically(
  targetPath: string,
  rewrite: (original: string) => string | Promise<string>,
  options: FileMutationOptions = {},
): Promise<void> {
  await withFileMutationLock(targetPath, async () => {
    if (options.kbDir !== undefined) {
      await assertKbWritePolicyAllowsMutation(options.kbDir, targetPath);
    }
    const stat = await fsp.stat(targetPath);
    if (!stat.isFile()) {
      throw new Error(`append target is not a file: ${JSON.stringify(path.basename(targetPath))}`);
    }

    const original = await fsp.readFile(targetPath, 'utf-8');
    await atomicWriteFile(targetPath, await rewrite(original), stat.mode);
  });
}

export async function atomicWriteFile(
  targetPath: string,
  data: string,
  mode?: number,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const tmpPath = `${targetPath}.kb-tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const permissions = mode === undefined ? undefined : mode & 0o7777;
  const handle = await fsp.open(tmpPath, 'w', permissions);
  try {
    if (permissions !== undefined) {
      await handle.chmod(permissions);
    }
    await handle.writeFile(data, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await (hooks.rename ?? fsp.rename)(tmpPath, targetPath);
    await syncDirectoryBestEffort(path.dirname(targetPath));
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function withFileMutationLock<T>(targetPath: string, action: () => Promise<T>): Promise<T> {
  const lockfilePath = `${targetPath}.kb-file.lock`;
  let release: () => Promise<void>;
  try {
    release = await properLockfile.lock(targetPath, {
      ...FILE_MUTATION_LOCK_OPTS,
      lockfilePath,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw err;
    }
    throw new Error(
      `Could not acquire KB file mutation lock for ${JSON.stringify(path.basename(targetPath))}: ${(err as Error).message}`,
    );
  }

  try {
    return await action();
  } finally {
    await release().catch(() => {});
  }
}

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(dirPath, 'r');
    await handle.sync();
  } catch {
    // Some filesystems/platforms do not allow fsync on directories. The temp
    // file is still fsynced before the atomic rename; directory sync is a
    // best-effort durability upgrade.
  } finally {
    await handle?.close().catch(() => {});
  }
}
