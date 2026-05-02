import * as fsp from 'fs/promises';
import * as path from 'path';

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
 * Symlinks are followed - a link pointing outside the KB is rejected.
 */
export async function resolveKbPath(
  kbName: string,
  relativePath: string,
  kbRootDir: string,
): Promise<string> {
  // Reject `kbName === '..'` and friends before path.join can walk out of
  // kbRootDir. Without this, a `..` kbName would make kbRoot === kbRootDir's
  // parent and `prefix` would cover every path on disk.
  assertValidKbName(kbName);

  if (typeof relativePath !== 'string') {
    throw new Error('relativePath must be a string');
  }
  if (relativePath.includes('\0')) {
    throw new Error('path contains null byte');
  }

  // RFC 010 §5.1.1 steps 3+4: normalize backslashes, then lexical traversal
  // check (defence-in-depth before realpath). Catches Windows-style payloads
  // on POSIX hosts and absolute/`..` injections even when intermediate
  // realpath chains would resolve back inside the KB.
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalizedRelative)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
  const posixNormalized = path.posix.normalize(normalizedRelative);
  const segments = posixNormalized.split('/');
  if (segments.some((s) => s === '..')) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }

  const kbRoot = path.join(kbRootDir, kbName);
  let kbRootReal: string;
  try {
    kbRootReal = await fsp.realpath(kbRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`knowledge base not found: ${JSON.stringify(kbName)}`);
    }
    throw error;
  }
  const prefix = kbRootReal.endsWith(path.sep) ? kbRootReal : kbRootReal + path.sep;

  const candidate = path.join(kbRoot, normalizedRelative);
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
        throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
      }
      // RFC 010 §5.1.1: error messages MUST NOT leak absolute paths.
      throw new Error(`path not found: ${JSON.stringify(relativePath)}`);
    }
    throw error;
  }

  if (resolved !== kbRootReal && !resolved.startsWith(prefix)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}
