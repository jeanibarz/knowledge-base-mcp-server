import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { writeFileAtomicDurable } from './file-utils.js';
import { assertKbWritePolicyAllowsMutation } from './kb-write-policy.js';

interface AtomicWriteHooks {
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

interface FileMutationOptions {
  kbDir: string;
}

const FILE_MUTATION_LOCK_OPTS: Omit<properLockfile.LockOptions, 'lockfilePath'> = {
  stale: 30_000,
  retries: { retries: 50, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
};

export async function appendFileAtomically(
  targetPath: string,
  content: string,
  options: FileMutationOptions,
): Promise<void> {
  await rewriteFileAtomically(targetPath, (original) => `${original}${content}`, options);
}

export async function rewriteFileAtomically(
  targetPath: string,
  rewrite: (original: string) => string | Promise<string>,
  options: FileMutationOptions,
): Promise<void> {
  await assertKbWritePolicyAllowsMutation(options.kbDir, targetPath);
  await withFileMutationLock(targetPath, async () => {
    // Re-check after acquiring the file lock so a policy changed while this
    // operation was waiting cannot be bypassed by the initial preflight.
    await assertKbWritePolicyAllowsMutation(options.kbDir, targetPath);
    const stat = await fsp.stat(targetPath);
    if (!stat.isFile()) {
      throw new Error(`append target is not a file: ${JSON.stringify(path.basename(targetPath))}`);
    }

    const original = await fsp.readFile(targetPath, 'utf-8');
    const nextContent = await rewrite(original);
    // Re-check after content generation and immediately before publishing so
    // a policy change during an expensive rewrite cannot be bypassed.
    await assertKbWritePolicyAllowsMutation(options.kbDir, targetPath);
    await atomicWriteFile(targetPath, nextContent, stat.mode);
  });
}

/**
 * Create a new managed file without exposing a partially written target.
 *
 * The policy check intentionally runs before parent-directory creation. This
 * keeps the guarded helper a chokepoint for new KB notes, including callers
 * that need to create nested note directories.
 */
export async function createFileAtomically(
  targetPath: string,
  data: string,
  options: FileMutationOptions,
): Promise<void> {
  await assertKbWritePolicyAllowsMutation(options.kbDir, targetPath);
  try {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      throw Object.assign(
        new Error(`cannot create parent directory for ${JSON.stringify(targetPath)}`),
        { code: 'ENOTDIR', cause: error },
      );
    }
    throw error;
  }

  const tempPath = `${targetPath}.kb-tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    const handle = await fsp.open(tempPath, 'wx');
    try {
      await handle.writeFile(data, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Re-check immediately before publishing the complete note. A policy can
    // be edited directly while extraction or LLM work is still in progress;
    // in that case discard the staged file instead of linking it into the KB.
    await assertKbWritePolicyAllowsMutation(options.kbDir, targetPath);
    // A hard link gives the create operation no-overwrite semantics while
    // making the complete file visible in one filesystem operation.
    await fsp.link(tempPath, targetPath);
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
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
