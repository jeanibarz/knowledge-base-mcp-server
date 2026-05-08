// mcp-resources.ts — MCP resources surface (#49) for the knowledge-base
// server. Owns the `kb://` URI scheme: parsing, building, MIME mapping,
// and the `resources/list` + `resources/read` handlers.
//
// Issue #157 step 2 — extracted out of `KnowledgeBaseServer.ts` to give
// the resources surface its own seam. The server's `buildMcpServer()`
// calls `registerResources(mcp)`; the per-method handler bodies are pure
// functions of `KNOWLEDGE_BASES_ROOT_DIR` + the URI/file-tree, with no
// dependency on the server class.

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  type ListResourcesResult,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { toError } from './error-utils.js';
import { getFilesRecursively } from './file-utils.js';
import { listKnowledgeBases, resolveKbPath } from './kb-fs.js';
import { isValidKbName } from './kb-paths.js';

export function mimeTypeForResource(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.pdf':
      return 'application/pdf';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.txt':
    default:
      return 'text/plain';
  }
}

/**
 * Build a `kb://<kbName>/<encoded-relative-path>` URI. Each path segment
 * is percent-encoded with `encodeURIComponent` so reserved characters
 * (`#`, `?`, `&`, `+`, `=`, space) round-trip cleanly through MCP
 * clients; `parseKnowledgeBaseResourceUri` decodes per-segment to match.
 */
export function buildResourceUri(kbName: string, relativePath: string): string {
  const encodedPath = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `kb://${kbName}/${encodedPath}`;
}

export function parseKnowledgeBaseResourceUri(uri: string): { kbName: string; relativePath: string } {
  const rawMatch = /^kb:\/\/([^/?#]*)([^?#]*)/i.exec(uri);
  if (!rawMatch) {
    throw new Error('resource URI must use the kb:// scheme');
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch (error: unknown) {
    throw new Error(`invalid kb:// URI: ${toError(error).message}`);
  }

  if (url.protocol !== 'kb:') {
    throw new Error(`unsupported resource URI scheme: ${url.protocol}`);
  }

  const kbName = url.hostname;
  if (kbName.length === 0) {
    throw new Error('kb:// URI requires a non-empty KB authority');
  }
  if (!isValidKbName(kbName)) {
    throw new Error('invalid KB name in kb:// URI');
  }

  const rawPath = rawMatch[2] ?? '';
  if (!rawPath.startsWith('/')) {
    throw new Error('kb:// URI requires a non-empty resource path');
  }

  const rawRelativePath = rawPath.slice(1);
  if (rawRelativePath.length === 0) {
    throw new Error('kb:// URI requires a non-empty resource path');
  }
  if (/%(?:2f|5c)/i.test(rawRelativePath)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(rawRelativePath)}`);
  }

  // Decode each path segment with `decodeURIComponent` to round-trip
  // `buildResourceUri()`, which percent-encodes per-segment with the
  // matching function. `decodeURI` leaves reserved characters (`#`, `?`,
  // `&`, `+`, `=`, …) literal, so a filename like `bug#123.md` would
  // round-trip to a literal `%23` and `resources/read` would fail with
  // "path not found". The earlier `%2f|%5c` guard already rejects
  // encoded path separators before this point, so per-segment decoding
  // cannot reintroduce a `/` or `\` boundary.
  let relativePath: string;
  try {
    relativePath = rawRelativePath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch (error: unknown) {
    throw new Error(`invalid kb:// URI path encoding: ${toError(error).message}`);
  }

  if (relativePath.split('/').some((segment) => segment === '..')) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }

  return { kbName, relativePath };
}

/**
 * `resources/list` body. Walks every registered KB under
 * `KNOWLEDGE_BASES_ROOT_DIR` and emits one `Resource` per file with a
 * percent-encoded `kb://` URI and a content-type-by-extension mime hint.
 */
export async function listResources(): Promise<ListResourcesResult> {
  const resources: Resource[] = [];
  const knowledgeBases = (await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR)).sort();

  for (const kbName of knowledgeBases) {
    if (!isValidKbName(kbName)) continue;
    const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
    const filePaths = (await getFilesRecursively(kbPath)).sort();
    for (const filePath of filePaths) {
      const relativePath = path
        .relative(kbPath, filePath)
        .split(path.sep)
        .join('/');

      resources.push({
        uri: buildResourceUri(kbName, relativePath),
        name: relativePath,
        description: `Document in knowledge base "${kbName}"`,
        mimeType: mimeTypeForResource(filePath),
      });
    }
  }

  return { resources };
}

/**
 * `resources/read` body. Parses the `kb://` URI, resolves the document
 * under `KNOWLEDGE_BASES_ROOT_DIR` (which rejects traversal escapes),
 * and returns either a base64 blob (PDF) or UTF-8 text (markdown,
 * HTML, plain text).
 */
export async function readResource(uri: string): Promise<ReadResourceResult> {
  const { kbName, relativePath } = parseKnowledgeBaseResourceUri(uri);
  const filePath = await resolveKbPath(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbName,
    relativePath,
    { mustExist: true },
  );
  const mimeType = mimeTypeForResource(filePath);

  if (mimeType === 'application/pdf') {
    const blob = (await fsp.readFile(filePath)).toString('base64');
    return {
      contents: [{ uri, mimeType, blob }],
    };
  }

  const text = await fsp.readFile(filePath, 'utf-8');
  return {
    contents: [{ uri, mimeType, text }],
  };
}

/**
 * Wire the resources surface onto an `McpServer`. Registers
 * `resources/list`, `resources/read`, and an empty
 * `resources/templates/list` (the server has no templates; clients that
 * probe for them must get an empty response, not a method-not-found
 * error). Called once from `KnowledgeBaseServer.buildMcpServer`.
 */
export function registerResources(mcp: McpServer): void {
  mcp.server.registerCapabilities({
    resources: {
      listChanged: true,
    },
  });

  mcp.server.setRequestHandler(ListResourcesRequestSchema, async () => listResources());
  mcp.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));
  mcp.server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(request.params.uri),
  );
}
