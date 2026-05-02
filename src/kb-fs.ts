// RFC 012 §4.9 — pure filesystem helpers shared by MCP and CLI surfaces.
//
// Extracted from KnowledgeBaseServer.handleListKnowledgeBases so the CLI
// can call the same logic without going through the MCP CallToolResult
// envelope.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { assertValidKbName } from './kb-paths.js';
import { KBError } from './errors.js';

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

/**
 * Resolves a KB-relative document path under `<rootDir>/<kbName>/` and
 * verifies the final filesystem target remains inside that KB directory.
 *
 * The guard is both lexical (before touching the candidate) and realpath
 * based (after following symlinks), so `../`, absolute-path payloads, and
 * symlinks that point outside the KB are refused.
 *
 * Used by the MCP `resources/read` handler (kb:// URIs). Requires the
 * resolved file to exist — throws "path not found" otherwise. For ingest
 * tools that may target a not-yet-created file, see `resolveKbRelativePath`.
 */
export async function resolveKnowledgeBaseDocumentPath(
  rootDir: string,
  kbName: string,
  relativePath: string,
): Promise<string> {
  assertValidKbName(kbName);

  if (relativePath.length === 0) {
    throw new Error('kb:// URI requires a non-empty resource path');
  }
  if (relativePath.includes('\0')) {
    throw new Error('path contains null byte');
  }

  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalizedRelative)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }

  const posixNormalized = path.posix.normalize(normalizedRelative);
  if (posixNormalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }

  const kbRoot = path.resolve(rootDir, kbName);
  const kbRootReal = await realpathIfExists(kbRoot);
  if (kbRootReal === null) {
    throw new Error(`knowledge base not found: ${JSON.stringify(kbName)}`);
  }

  const lexicalCandidate = path.resolve(kbRootReal, normalizedRelative);
  if (!isInsideOrEqual(kbRootReal, lexicalCandidate)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }

  const realCandidate = await realpathIfExists(lexicalCandidate);
  if (realCandidate === null) {
    throw new Error(`path not found: ${JSON.stringify(relativePath)}`);
  }
  if (!isInsideOrEqual(kbRootReal, realCandidate)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
  return realCandidate;
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

/**
 * Resolve a user-supplied KB-relative document path to an absolute path under
 * `<rootDir>/<knowledgeBaseName>`.
 *
 * The final path may not exist yet (needed by add_document), but any existing
 * ancestor, existing file, or existing symlink target must resolve under the
 * KB root. `..` components are rejected lexically, even if normalization
 * would bring the path back inside the KB.
 */
export async function resolveKbRelativePath(
  rootDir: string,
  knowledgeBaseName: string,
  relativePath: string,
): Promise<string> {
  if (relativePath.length === 0) {
    throw new KBError('VALIDATION', 'Document path must not be empty.');
  }
  if (relativePath.includes('\0')) {
    throw new KBError('VALIDATION', 'Document path contains a null byte.');
  }

  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalizedRelative)) {
    throw new KBError(
      'VALIDATION',
      `Document path escapes KB root: ${JSON.stringify(relativePath)}.`,
    );
  }

  const rawSegments = normalizedRelative.split('/').filter((segment) => segment.length > 0);
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment === '..')) {
    throw new KBError(
      'VALIDATION',
      `Document path escapes KB root: ${JSON.stringify(relativePath)}.`,
    );
  }

  const kbDir = await resolveKnowledgeBaseDir(rootDir, knowledgeBaseName);
  const kbReal = await fsp.realpath(kbDir);
  const normalizedSegments = path.posix.normalize(rawSegments.join('/')).split('/');
  const candidate = path.resolve(kbDir, ...normalizedSegments);
  if (!isInsideOrEqual(path.resolve(kbDir), candidate)) {
    throw new KBError(
      'VALIDATION',
      `Document path escapes KB root: ${JSON.stringify(relativePath)}.`,
    );
  }

  const existingTarget = await realpathIfExists(candidate);
  if (existingTarget !== null) {
    if (!isInsideOrEqual(kbReal, existingTarget)) {
      throw new KBError(
        'VALIDATION',
        `Document path escapes KB root: ${JSON.stringify(relativePath)}.`,
      );
    }
    return candidate;
  }

  let existingAncestor = path.dirname(candidate);
  while (!(await realpathIfExists(existingAncestor))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new KBError(
        'VALIDATION',
        `Document path escapes KB root: ${JSON.stringify(relativePath)}.`,
      );
    }
    existingAncestor = parent;
  }

  const ancestorReal = await fsp.realpath(existingAncestor);
  if (!isInsideOrEqual(kbReal, ancestorReal)) {
    throw new KBError(
      'VALIDATION',
      `Document path escapes KB root: ${JSON.stringify(relativePath)}.`,
    );
  }

  return candidate;
}
