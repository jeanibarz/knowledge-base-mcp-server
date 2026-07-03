import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';

type FsError = NodeJS.ErrnoException & { code?: string };

export interface WriteFileAtomicDurableHooks {
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  syncDirectory?: (dirPath: string) => Promise<void>;
}

export interface WriteFileAtomicDurableOptions {
  mode?: number;
  encoding?: BufferEncoding;
  syncParentDirectory?: boolean;
  hooks?: WriteFileAtomicDurableHooks;
}

export interface FilesystemEnumerationFailure {
  path: string;
  code: string | null;
  message: string;
}

export interface FilesystemEnumerationDiagnostics {
  failure_count: number;
  failures: FilesystemEnumerationFailure[];
}

export interface RecursiveFileEnumeration {
  files: string[];
  diagnostics: FilesystemEnumerationDiagnostics;
}

export const DEFAULT_ENUMERATION_FAILURE_SAMPLE_LIMIT = 5;

/**
 * Issue #160 step 1 — single home for "does this path exist?".
 *
 * Returns `true` for a real entry, `false` for `ENOENT`/`ENOTDIR`, and
 * RETHROWS every other filesystem error (`EACCES`, `ELOOP`, `EMFILE`,
 * etc.). The deliberate non-swallow on permission/handle errors is the
 * point: the inline `fsp.access(...).then(() => true).catch(() => false)`
 * forms scattered around the repo silently masked them, so a bad
 * permission setup or fd exhaustion would look exactly like a missing
 * file. A real `pathExists` should report only existence — not "I gave
 * up checking".
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    const code = (error as FsError | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

export async function calculateSHA256(filePath: string): Promise<string> {
  const fileBuffer = await fsp.readFile(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

export async function writeFileAtomicDurable(
  targetPath: string,
  data: string | Uint8Array,
  options: WriteFileAtomicDurableOptions = {},
): Promise<void> {
  const tmpPath = `${targetPath}.kb-tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const permissions = options.mode === undefined ? undefined : options.mode & 0o7777;
  let handle: fsp.FileHandle | null = await fsp.open(tmpPath, 'w', permissions);
  try {
    if (permissions !== undefined) {
      await handle.chmod(permissions);
    }
    if (typeof data === 'string') {
      await handle.writeFile(data, options.encoding ?? 'utf-8');
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
    await handle.close();
    handle = null;

    await (options.hooks?.rename ?? fsp.rename)(tmpPath, targetPath);
    if (options.syncParentDirectory ?? true) {
      await (options.hooks?.syncDirectory ?? syncDirectoryBestEffort)(path.dirname(targetPath));
    }
  } catch (err) {
    await handle?.close().catch(() => {});
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
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

/**
 * Recursively gets all files in a directory, excluding hidden files and directories.
 * @param dirPath The directory path to search
 * @returns Array of file paths
 */
export async function getFilesRecursively(dirPath: string): Promise<string[]> {
  return (await getFilesRecursivelyWithDiagnostics(dirPath)).files;
}

export async function getFilesRecursivelyWithDiagnostics(
  dirPath: string,
  options: { failureSampleLimit?: number } = {},
): Promise<RecursiveFileEnumeration> {
  const files: string[] = [];
  const sampleLimit = options.failureSampleLimit ?? DEFAULT_ENUMERATION_FAILURE_SAMPLE_LIMIT;
  const diagnostics: FilesystemEnumerationDiagnostics = {
    failure_count: 0,
    failures: [],
  };

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await fsp.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files and directories
        if (entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      diagnostics.failure_count += 1;
      if (diagnostics.failures.length < sampleLimit) {
        const err = error as NodeJS.ErrnoException;
        diagnostics.failures.push({
          path: currentPath,
          code: typeof err.code === 'string' ? err.code : null,
          message: err.message,
        });
      }
      logger.error(`Error traversing directory ${currentPath}:`, error);
    }
  }

  await traverse(dirPath);
  return { files, diagnostics };
}
