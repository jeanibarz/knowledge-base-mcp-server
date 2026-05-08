import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';

type FsError = NodeJS.ErrnoException & { code?: string };

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

/**
 * Recursively gets all files in a directory, excluding hidden files and directories.
 * @param dirPath The directory path to search
 * @returns Array of file paths
 */
export async function getFilesRecursively(dirPath: string): Promise<string[]> {
  const files: string[] = [];

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
      logger.error(`Error traversing directory ${currentPath}:`, error);
    }
  }

  await traverse(dirPath);
  return files;
}
