import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { logger } from './logger.js';

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

/**
 * KB-name grammar: `^[a-z0-9][a-z0-9._-]*$`, length 1-64.
 *
 * The leading-char rule rejects dotfiles (`.hidden`), relative traversal
 * (`..`), CLI-flag ambiguity (`-foo`), and the empty string. The tail rule
 * forbids `/`, `\\`, uppercase, and any other separator the filesystem
 * could split on. Null bytes are rejected as a side-effect of the regex
 * character class.
 */
export const KB_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidKbName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 64) return false;
  return KB_NAME_REGEX.test(name);
}

export function assertValidKbName(name: string): void {
  if (!isValidKbName(name)) {
    throw new Error(`invalid KB name: ${JSON.stringify(name)}`);
  }
}

/**
 * Resolves a user-supplied relative path against `<kbRootDir>/<kbName>/` and
 * asserts the real path stays inside the KB. Throws on null bytes, escapes,
 * or a missing KB directory. The returned path is realpath-resolved so
 * callers can use it directly for fs reads.
 *
 * Symlinks are followed — a link pointing outside the KB is rejected.
 */
export async function resolveKbPath(
  kbName: string,
  relativePath: string,
  kbRootDir: string,
): Promise<string> {
  if (typeof relativePath !== 'string') {
    throw new Error('relativePath must be a string');
  }
  if (relativePath.includes('\0')) {
    throw new Error('path contains null byte');
  }

  const kbRoot = path.join(kbRootDir, kbName);
  const kbRootReal = await fsp.realpath(kbRoot);
  const prefix = kbRootReal.endsWith(path.sep) ? kbRootReal : kbRootReal + path.sep;

  const candidate = path.join(kbRoot, relativePath);
  let resolved: string;
  try {
    resolved = await fsp.realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // If the target does not exist, a lexical escape is still detectable:
      // compare the (non-real) candidate against the kbRoot prefix. The
      // realpath of the KB root itself was successful above, so only the
      // candidate is missing.
      const lexical = path.resolve(candidate);
      if (lexical !== kbRootReal && !lexical.startsWith(prefix)) {
        throw new Error('path escapes KB root');
      }
      throw error;
    }
    throw error;
  }

  if (resolved !== kbRootReal && !resolved.startsWith(prefix)) {
    throw new Error('path escapes KB root');
  }
  return resolved;
}

const FRONTMATTER_MAX_BYTES = 8192;

/**
 * Parses YAML frontmatter bounded at `---` delimiters. Returns extracted
 * `tags` (array or scalar-coerced) and the `body` with frontmatter stripped.
 * Never throws: malformed YAML, oversized frontmatter, or no fence all
 * degrade to `{ tags: [], body: content }`.
 */
export function parseFrontmatter(content: string): { tags: string[]; body: string } {
  if (typeof content !== 'string' || content.length === 0) {
    return { tags: [], body: content };
  }

  // Opening fence must be `---\n` (or `---\r\n`) at byte 0.
  const openMatch = content.match(/^---\r?\n/);
  if (!openMatch) {
    return { tags: [], body: content };
  }
  const openEnd = openMatch[0].length;

  // Search for the closing fence within the size cap. The closing fence
  // `---` must sit at the start of a line — either at position 0 of the
  // slice (empty frontmatter: `---\n---\n`) or right after a `\n`.
  const searchLimit = Math.min(content.length, FRONTMATTER_MAX_BYTES);
  const searchSlice = content.slice(openEnd, searchLimit);
  const closeMatch = searchSlice.match(/(^|\n)---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { tags: [], body: content };
  }
  const leadNL = closeMatch[1]; // '' or '\n'
  // YAML ends at matchStart when there is a leading `\n` (the `\n` is part
  // of the fence, not the YAML). With no leading `\n` the match sits at
  // position 0, so YAML is empty.
  const yamlEnd = leadNL === '\n' ? closeMatch.index : 0;
  const fenceEnd = closeMatch.index + closeMatch[0].length;
  const yamlRaw = searchSlice.slice(0, yamlEnd);
  const body = content.slice(openEnd + fenceEnd);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlRaw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return { tags: [], body: content };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tags: [], body };
  }

  const raw = (parsed as Record<string, unknown>).tags;
  let tags: string[] = [];
  if (Array.isArray(raw)) {
    tags = raw
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) tags = [trimmed];
  }
  return { tags, body };
}
