// RFC 012 §4.9 — pure filesystem helpers shared by MCP and CLI surfaces.
//
// Extracted from KnowledgeBaseServer.handleListKnowledgeBases so the CLI
// can call the same logic without going through the MCP CallToolResult
// envelope.

import * as fsp from 'fs/promises';

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
