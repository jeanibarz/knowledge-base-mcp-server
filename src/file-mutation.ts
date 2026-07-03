import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { writeFileAtomicDurable } from './file-utils.js';
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
  await writeFileAtomicDurable(targetPath, data, { mode, hooks });
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
