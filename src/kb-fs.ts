// RFC 012 §4.9 — pure filesystem helpers shared by MCP and CLI surfaces.
//
// Extracted from KnowledgeBaseServer.handleListKnowledgeBases so the CLI
// can call the same logic without going through the MCP CallToolResult
// envelope.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { KBError } from './errors.js';
import {
  DEFAULT_ENUMERATION_FAILURE_SAMPLE_LIMIT,
  getFilesRecursivelyWithDiagnostics,
  type FilesystemEnumerationDiagnostics,
} from './file-utils.js';
import { filterIngestablePaths } from './ingest-filter.js';

/**
 * Issue #160 step 3 — single home for "is this rel path safe to join
 * under a KB root?". Pure lexical check (no I/O, no realpath):
 *
 *   1. Reject POSIX-absolute paths (after normalizing `\\` → `/`).
 *   2. Reject Win32-absolute paths (drive-letter and `\\?\` shapes).
 *   3. Reject any path segment equal to `..`.
 *
 * Throws plain `Error` with the canonical
 * `path escapes KB root: <relativePath>` message. Call sites that
 * need a typed error (e.g. `KBError`) wrap their own check on top —
 * the goal of the helper is to dedupe the byte-identical implementations
 * in `cli-capture.ts` and `cli-remember.ts`, plus the inline mirror in
 * `resolveKnowledgeBaseDocumentPath`.
 *
 * Empty strings and null bytes are NOT checked here because the
 * appropriate response varies per call site (different message wording,
 * sometimes a different error type). Callers handle those separately.
 */
export function assertNoTraversal(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(relativePath) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
}

/**
 * Returns the names of available knowledge bases under `rootDir` (one per
 * subdirectory). Hidden entries (dot-prefixed) are filtered — they include
 * the `.faiss` index, the `.reindex-trigger`, and any user-created
 * `.drafts/` etc. that the embedding walker also skips.
 *
 * Throws on filesystem errors (caller decides how to surface them — MCP
 * wraps in `CallToolResult.isError`; CLI exits non-zero).
 */
export async function listKnowledgeBases(rootDir: string): Promise<string[]> {
  const entries = await fsp.readdir(rootDir);
  return entries.filter((entry) => !entry.startsWith('.'));
}

export interface KbFileEnumeration {
  kbName: string;
  kbPath: string;
  filePaths: string[];
  diagnostics: FilesystemEnumerationDiagnostics;
}

export interface KbFilesystemEnumerationFailure {
  kbName: string;
  path: string;
  code: string | null;
  message: string;
}

export interface KbFilesystemEnumerationDiagnostics {
  failure_count: number;
  failures: KbFilesystemEnumerationFailure[];
}

export type KbSymlinkClassification = 'inside_root' | 'escaping' | 'broken' | 'loop_or_error';

export interface KbSymlinkInventoryEntry {
  kbName: string;
  path: string;
  relative_path: string;
  link_target: string | null;
  resolved_target: string | null;
  classification: KbSymlinkClassification;
  error_code: string | null;
  error_message: string | null;
}

export interface KbSymlinkScanError {
  path: string;
  code: string | null;
  message: string;
}

export interface KbSymlinkInventory {
  root_dir: string;
  root_realpath: string | null;
  summary: {
    total: number;
    inside_root: number;
    escaping: number;
    broken: number;
    loop_or_error: number;
    scan_error_count: number;
    sample_limit: number;
  };
  symlinks: KbSymlinkInventoryEntry[];
  scan_errors: KbSymlinkScanError[];
}

export interface EnumerateIngestableKbFilesOptions {
  extraExtensions?: readonly string[];
  excludePaths?: readonly string[];
}

/**
 * Issue #157 — single home for the per-KB walk + ingest-filter shape that
 * `kb_stats`, the indexer, `kb models add` cost preview, and `kb search`
 * staleness preview all share.
 *
 * For each name in `kbNames`, walks `<rootDir>/<kbName>` with
 * `getFilesRecursively` (which already skips dot-prefixed entries) and
 * applies `filterIngestablePaths` (with caller-supplied extras/excludes).
 * Result preserves input order so callers can stream progress against a
 * stable denominator.
 *
 * Caller is responsible for filtering dot-prefixed names out of `kbNames`
 * if its source admits them (e.g. raw `fsp.readdir`); `listKnowledgeBases`
 * already does this.
 */
export async function enumerateIngestableKbFiles(
  rootDir: string,
  kbNames: readonly string[],
  options?: EnumerateIngestableKbFilesOptions,
): Promise<KbFileEnumeration[]> {
  const filterOpts = options ?? {};
  const result: KbFileEnumeration[] = [];
  for (const kbName of kbNames) {
    const kbPath = path.join(rootDir, kbName);
    const enumeration = await getFilesRecursivelyWithDiagnostics(kbPath);
    const candidates = enumeration.files;
    const filePaths = filterIngestablePaths(candidates, kbPath, filterOpts);
    result.push({
      kbName,
      kbPath,
      filePaths,
      diagnostics: enumeration.diagnostics,
    });
  }
  return result;
}

export function aggregateEnumerationDiagnostics(
  enumerations: readonly KbFileEnumeration[],
  sampleLimit = DEFAULT_ENUMERATION_FAILURE_SAMPLE_LIMIT,
): KbFilesystemEnumerationDiagnostics {
  const failures: KbFilesystemEnumerationFailure[] = [];
  let failureCount = 0;
  for (const entry of enumerations) {
    failureCount += entry.diagnostics.failure_count;
    for (const failure of entry.diagnostics.failures) {
      if (failures.length >= sampleLimit) break;
      failures.push({
        kbName: entry.kbName,
        path: failure.path,
        code: failure.code,
        message: failure.message,
      });
    }
  }
  return { failure_count: failureCount, failures };
}

export async function inventoryKbSymlinks(
  rootDir: string,
  options: { sampleLimit?: number } = {},
): Promise<KbSymlinkInventory> {
  const sampleLimit = options.sampleLimit ?? DEFAULT_ENUMERATION_FAILURE_SAMPLE_LIMIT;
  const summary: KbSymlinkInventory['summary'] = {
    total: 0,
    inside_root: 0,
    escaping: 0,
    broken: 0,
    loop_or_error: 0,
    scan_error_count: 0,
    sample_limit: sampleLimit,
  };
  const symlinks: KbSymlinkInventoryEntry[] = [];
  const scanErrors: KbSymlinkScanError[] = [];
  let rootRealpath: string | null = null;

  try {
    rootRealpath = await fsp.realpath(rootDir);
  } catch (error: unknown) {
    recordScanError(rootDir, error);
    return {
      root_dir: rootDir,
      root_realpath: null,
      summary,
      symlinks,
      scan_errors: scanErrors,
    };
  }

  async function scanDirectory(currentPath: string, kbName: string): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(currentPath);
    } catch (error: unknown) {
      recordScanError(currentPath, error);
      return;
    }

    for (const name of names) {
      const childPath = path.join(currentPath, name);
      let st: import('fs').Stats;
      try {
        st = await fsp.lstat(childPath);
      } catch (error: unknown) {
        recordScanError(childPath, error);
        continue;
      }
      if (st.isSymbolicLink()) {
        await recordSymlink(childPath, kbName);
        continue;
      }
      if (st.isDirectory()) {
        await scanDirectory(childPath, kbName);
      }
    }
  }

  async function recordSymlink(linkPath: string, kbName: string): Promise<void> {
    summary.total += 1;
    const relativePath = path.relative(rootDir, linkPath);
    const linkTarget = await readLinkTarget(linkPath);
    let resolvedTarget: string | null = null;
    let classification: KbSymlinkClassification = 'loop_or_error';
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    try {
      resolvedTarget = await fsp.realpath(linkPath);
      classification = isInsideOrEqual(rootRealpath!, resolvedTarget) ? 'inside_root' : 'escaping';
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      errorCode = typeof err.code === 'string' ? err.code : null;
      errorMessage = err.message;
      classification = errorCode === 'ENOENT' || errorCode === 'ENOTDIR'
        ? 'broken'
        : 'loop_or_error';
    }

    summary[classification] += 1;
    if (symlinks.length < sampleLimit) {
      symlinks.push({
        kbName,
        path: linkPath,
        relative_path: relativePath,
        link_target: linkTarget,
        resolved_target: resolvedTarget,
        classification,
        error_code: errorCode,
        error_message: errorMessage,
      });
    }
  }

  function recordScanError(targetPath: string, error: unknown): void {
    summary.scan_error_count += 1;
    if (scanErrors.length >= sampleLimit) return;
    const err = error as NodeJS.ErrnoException;
    scanErrors.push({
      path: targetPath,
      code: typeof err.code === 'string' ? err.code : null,
      message: err.message,
    });
  }

  const rootEntries = await fsp.readdir(rootDir).catch((error: unknown) => {
    recordScanError(rootDir, error);
    return [];
  });
  for (const name of rootEntries) {
    if (name.startsWith('.')) continue;
    const entryPath = path.join(rootDir, name);
    let st: import('fs').Stats;
    try {
      st = await fsp.lstat(entryPath);
    } catch (error: unknown) {
      recordScanError(entryPath, error);
      continue;
    }
    if (st.isSymbolicLink()) {
      await recordSymlink(entryPath, name);
    } else if (st.isDirectory()) {
      await scanDirectory(entryPath, name);
    }
  }

  return {
    root_dir: rootDir,
    root_realpath: rootRealpath,
    summary,
    symlinks,
    scan_errors: scanErrors,
  };
}

async function readLinkTarget(linkPath: string): Promise<string | null> {
  try {
    return await fsp.readlink(linkPath);
  } catch {
    return null;
  }
}

const KB_DESCRIPTION_MAX_LEN = 80;

/**
 * Extract a one-line description from a `README.md` body.
 *
 * Used by `kb list --describe` (#140) so the listing is self-documenting:
 * each KB's own README — not a hand-edited side table — is the source of
 * truth. The first `#`-style heading wins (any level, leading hashes
 * stripped); if none exists, the first non-blank line is returned,
 * truncated at 80 characters so a stray long paragraph cannot break
 * column alignment.
 *
 * Returns the empty string for an empty file or content with no
 * non-blank lines, so callers can treat "no description" uniformly.
 */
export function extractKbDescription(content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const heading = /^\s*#+\s+(.+?)\s*$/.exec(line);
    if (heading) {
      return heading[1].trim();
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > KB_DESCRIPTION_MAX_LEN
        ? trimmed.slice(0, KB_DESCRIPTION_MAX_LEN)
        : trimmed;
    }
  }
  return '';
}

/**
 * Read `<rootDir>/<name>/README.md` and return a one-line description
 * (`extractKbDescription`). Missing or unreadable READMEs surface as the
 * empty string — `kb list --describe` is a read-only listing surface and
 * a partial filesystem must not turn it into an error.
 *
 * Hidden / dot-prefixed names are rejected on the same grounds as
 * `listKnowledgeBases` to keep the addressable surface aligned.
 */
export async function describeKnowledgeBase(
  rootDir: string,
  name: string,
): Promise<string> {
  if (name.length === 0 || name.startsWith('.') || hasPathSeparator(name)) {
    return '';
  }
  const readmePath = path.join(rootDir, name, 'README.md');
  let content: string;
  try {
    content = await fsp.readFile(readmePath, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return '';
    }
    throw error;
  }
  return extractKbDescription(content);
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

async function realpathIfExists(target: string): Promise<string | null> {
  try {
    return await fsp.realpath(target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

export interface ResolveKbPathOptions {
  /**
   * When true (resources/read), the resolved file MUST exist on disk;
   * a missing target throws `path not found: "<relativePath>"`. The
   * returned path is realpath-resolved.
   *
   * When false (add_document, kb remember/capture writes), the lexical
   * target may not exist yet, but every existing ancestor in the path
   * prefix MUST resolve inside the KB root. The returned path is
   * lexical (the user-requested location, not a symlink target).
   */
  mustExist: boolean;
}

/**
 * Issue #160 step 2 — single home for "validate user-supplied
 * KB-relative path and return its absolute fs path under the KB root".
 *
 * Replaces the prior pair of `resolveKnowledgeBaseDocumentPath` (must-exist)
 * and `resolveKbRelativePath` (may-not-exist). The defence-in-depth chain
 * is the same in both modes:
 *   1. Lexical guards: empty / null-byte / traversal (`assertNoTraversal`).
 *   2. KB-name + KB-dir validation (`resolveKnowledgeBaseDir`).
 *   3. Lexical inside-or-equal check on `<kbDir>/<relativePath>`.
 *   4. realpath check on the existing target (or its nearest existing
 *      ancestor when `mustExist === false`).
 *
 * Failures throw `KBError('VALIDATION', ...)` for input/escape problems
 * and propagate `KBError('KB_NOT_FOUND', ...)` from the KB-dir resolver.
 * `path not found` is a plain `Error` to match the prior public wording
 * of `resolves/read` test assertions; the message format is preserved.
 */
export async function resolveKbPath(
  rootDir: string,
  knowledgeBaseName: string,
  relativePath: string,
  options: ResolveKbPathOptions,
): Promise<string> {
  if (relativePath.length === 0) {
    throw new KBError('VALIDATION', 'path must not be empty');
  }
  if (relativePath.includes('\0')) {
    throw new KBError('VALIDATION', 'path contains null byte');
  }
  try {
    assertNoTraversal(relativePath);
  } catch (err) {
    // Promote the plain Error to a typed KBError so callers (add_document,
    // delete_document) keep their `error.code === 'VALIDATION'` contract.
    throw new KBError('VALIDATION', (err as Error).message);
  }

  const kbDir = await resolveKnowledgeBaseDir(rootDir, knowledgeBaseName);
  const kbReal = await fsp.realpath(kbDir);
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  const lexicalCandidate = path.resolve(kbDir, normalizedRelative);
  const escapesError = (): KBError =>
    new KBError(
      'VALIDATION',
      `path escapes KB root: ${JSON.stringify(relativePath)}`,
    );
  if (!isInsideOrEqual(path.resolve(kbDir), lexicalCandidate)) {
    throw escapesError();
  }

  const realCandidate = await realpathIfExists(lexicalCandidate);
  if (realCandidate !== null) {
    if (!isInsideOrEqual(kbReal, realCandidate)) {
      throw escapesError();
    }
    return options.mustExist ? realCandidate : lexicalCandidate;
  }

  if (options.mustExist) {
    // Plain Error (not KBError) — `mcpErrorContent` would otherwise stamp
    // this as `INTERNAL` for `resources/read`; the SDK serializes the
    // raw `error.message` directly, and the existing test pin
    // (KnowledgeBaseServer.test.ts:717) expects exactly this wording.
    throw new Error(`path not found: ${JSON.stringify(relativePath)}`);
  }

  // mustExist === false: walk up to the nearest existing ancestor and
  // confirm it resolves inside the KB. This is what lets add_document
  // create new files at not-yet-existing paths while still rejecting
  // ones whose realpath chain points outside the KB.
  let existingAncestor = path.dirname(lexicalCandidate);
  while (!(await realpathIfExists(existingAncestor))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw escapesError();
    }
    existingAncestor = parent;
  }
  const ancestorReal = await fsp.realpath(existingAncestor);
  if (!isInsideOrEqual(kbReal, ancestorReal)) {
    throw escapesError();
  }
  return lexicalCandidate;
}

/**
 * Resolve an existing, addressable KB directory below `rootDir`.
 *
 * The ingest tools deliberately treat dot-prefixed entries and path-like KB
 * names as not addressable. That keeps the write surface aligned with
 * `listKnowledgeBases` and prevents a KB name from participating in path
 * traversal before the document path helper runs.
 */
export async function resolveKnowledgeBaseDir(
  rootDir: string,
  knowledgeBaseName: string,
): Promise<string> {
  if (
    knowledgeBaseName.length === 0 ||
    knowledgeBaseName.startsWith('.') ||
    knowledgeBaseName.includes('\0') ||
    path.isAbsolute(knowledgeBaseName) ||
    hasPathSeparator(knowledgeBaseName)
  ) {
    throw new KBError(
      'KB_NOT_FOUND',
      `Knowledge base "${knowledgeBaseName}" not found under ${rootDir}.`,
    );
  }

  const rootReal = await realpathIfExists(rootDir);
  if (rootReal === null) {
    throw new KBError('KB_NOT_FOUND', `Knowledge base root ${rootDir} does not exist.`);
  }

  const kbDir = path.join(rootDir, knowledgeBaseName);
  let stat;
  try {
    stat = await fsp.stat(kbDir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new KBError(
        'KB_NOT_FOUND',
        `Knowledge base "${knowledgeBaseName}" not found under ${rootDir}.`,
      );
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new KBError(
      'KB_NOT_FOUND',
      `Knowledge base "${knowledgeBaseName}" not found under ${rootDir}.`,
    );
  }

  const kbReal = await fsp.realpath(kbDir);
  if (!isInsideOrEqual(rootReal, kbReal)) {
    throw new KBError(
      'VALIDATION',
      `Knowledge base "${knowledgeBaseName}" resolves outside ${rootDir}.`,
    );
  }
  return kbDir;
}
