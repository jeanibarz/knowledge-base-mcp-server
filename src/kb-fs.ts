// RFC 012 §4.9 — pure filesystem helpers shared by MCP and CLI surfaces.
//
// Extracted from KnowledgeBaseServer.handleListKnowledgeBases so the CLI
// can call the same logic without going through the MCP CallToolResult
// envelope.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { assertValidKbName } from './utils.js';

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

function assertPathInsideKb(kbRoot: string, resolvedPath: string, originalPath: string): void {
  const relative = path.relative(kbRoot, resolvedPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(originalPath)}`);
  }
}

/**
 * Resolves a KB-relative document path under `<rootDir>/<kbName>/` and
 * verifies the final filesystem target remains inside that KB directory.
 *
 * The guard is both lexical (before touching the candidate) and realpath
 * based (after following symlinks), so `../`, absolute-path payloads, and
 * symlinks that point outside the KB are refused.
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
  let kbRootReal: string;
  try {
    kbRootReal = await fsp.realpath(kbRoot);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`knowledge base not found: ${JSON.stringify(kbName)}`);
    }
    throw error;
  }

  const lexicalCandidate = path.resolve(kbRootReal, normalizedRelative);
  assertPathInsideKb(kbRootReal, lexicalCandidate, relativePath);

  try {
    const realCandidate = await fsp.realpath(lexicalCandidate);
    assertPathInsideKb(kbRootReal, realCandidate, relativePath);
    return realCandidate;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`path not found: ${JSON.stringify(relativePath)}`);
    }
    throw error;
  }
}
