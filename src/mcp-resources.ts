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
  type ListResourceTemplatesResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INGEST_EXCLUDE_PATHS, INGEST_EXTRA_EXTENSIONS } from './config/ingest.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { toError } from './error-utils.js';
import { parseFrontmatter } from './frontmatter.js';
import { filterIngestablePaths } from './ingest-filter.js';
import { listIngestQuarantine } from './ingest-quarantine.js';
import { resolveKbPath } from './kb-fs.js';
import {
  listKnowledgeBaseDocuments,
  normalizeDocumentPrefix,
} from './kb-document-listing.js';
import { isValidKbName } from './kb-paths.js';
import {
  decideResourceRead,
  normalizeKbSensitivityPolicy,
  resolveResourceReadAccess,
  type KbResourceReadAccess,
} from './sensitivity-policy.js';

export interface ListResourcesOptions {
  cursor?: string;
  kbName?: string;
  knowledgeBase?: string;
  knowledge_base_name?: string;
  prefix?: string;
  limit?: number;
  pageSize?: number;
}

export interface ReadResourceOptions {
  access?: KbResourceReadAccess;
}

interface NormalizedListResourcesOptions {
  kbName?: string;
  prefix: string;
  limit?: number;
  offset: number;
}

interface ListResourcesCursor {
  v: 1;
  offset: number;
  kbName?: string;
  prefix: string;
  limit: number;
}

const LIST_RESOURCES_CURSOR_PREFIX = 'kbres1.';
const LIST_RESOURCES_MAX_PAGE_SIZE = 1000;

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

function encodeListResourcesCursor(cursor: ListResourcesCursor): string {
  return `${LIST_RESOURCES_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url')}`;
}

function decodeListResourcesCursor(raw: string): ListResourcesCursor {
  if (!raw.startsWith(LIST_RESOURCES_CURSOR_PREFIX)) {
    throw new Error('invalid resources/list cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(raw.slice(LIST_RESOURCES_CURSOR_PREFIX.length), 'base64url').toString('utf-8'),
    );
  } catch (error: unknown) {
    throw new Error(`invalid resources/list cursor: ${toError(error).message}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    !Number.isInteger((parsed as { offset?: unknown }).offset) ||
    (parsed as { offset: number }).offset < 0 ||
    typeof (parsed as { prefix?: unknown }).prefix !== 'string' ||
    !Number.isInteger((parsed as { limit?: unknown }).limit) ||
    (parsed as { limit: number }).limit <= 0
  ) {
    throw new Error('invalid resources/list cursor');
  }

  const kbName = (parsed as { kbName?: unknown }).kbName;
  if (kbName !== undefined && typeof kbName !== 'string') {
    throw new Error('invalid resources/list cursor');
  }
  if (kbName !== undefined && !isValidKbName(kbName)) {
    throw new Error('invalid resources/list cursor');
  }

  const prefix = (parsed as { prefix: string }).prefix;
  if (prefix.includes('\0')) {
    throw new Error('invalid resources/list cursor');
  }
  try {
    normalizeDocumentPrefix(prefix);
  } catch {
    throw new Error('invalid resources/list cursor');
  }

  const limit = (parsed as { limit: number }).limit;
  if (limit > LIST_RESOURCES_MAX_PAGE_SIZE) {
    throw new Error('invalid resources/list cursor');
  }

  return {
    v: 1,
    offset: (parsed as { offset: number }).offset,
    kbName,
    prefix,
    limit,
  };
}

function readStringOption(options: ListResourcesOptions | undefined, key: keyof ListResourcesOptions): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeListResourcesOptions(
  options: ListResourcesOptions | undefined,
): NormalizedListResourcesOptions {
  const explicitKbName =
    readStringOption(options, 'kbName') ??
    readStringOption(options, 'knowledgeBase') ??
    readStringOption(options, 'knowledge_base_name');
  const explicitPrefix = normalizeDocumentPrefix(readStringOption(options, 'prefix'));
  const explicitLimit = options?.limit ?? options?.pageSize;

  if (explicitKbName !== undefined && !isValidKbName(explicitKbName)) {
    throw new Error('invalid KB name in resources/list filter');
  }
  if (explicitLimit !== undefined && (!Number.isInteger(explicitLimit) || explicitLimit <= 0)) {
    throw new Error('resources/list limit must be a positive integer');
  }

  if (options?.cursor === undefined) {
    return {
      kbName: explicitKbName,
      prefix: explicitPrefix,
      limit:
        explicitLimit === undefined
          ? undefined
          : Math.min(explicitLimit, LIST_RESOURCES_MAX_PAGE_SIZE),
      offset: 0,
    };
  }

  const cursor = decodeListResourcesCursor(options.cursor);
  if (explicitKbName !== undefined && explicitKbName !== cursor.kbName) {
    throw new Error('resources/list cursor does not match kbName filter');
  }
  if (explicitPrefix !== '' && explicitPrefix !== cursor.prefix) {
    throw new Error('resources/list cursor does not match prefix filter');
  }
  if (explicitLimit !== undefined && Math.min(explicitLimit, LIST_RESOURCES_MAX_PAGE_SIZE) !== cursor.limit) {
    throw new Error('resources/list cursor does not match limit');
  }

  return {
    kbName: cursor.kbName,
    prefix: cursor.prefix,
    limit: cursor.limit,
    offset: cursor.offset,
  };
}

/**
 * `resources/list` body. No-option calls preserve the original full listing:
 * every registered KB under `KNOWLEDGE_BASES_ROOT_DIR` contributes one
 * `Resource` per ingestable, non-quarantined file. Optional KB/prefix filters
 * and MCP cursors narrow/page that same deterministic listing.
 */
export async function listResources(options?: ListResourcesOptions): Promise<ListResourcesResult> {
  const normalizedOptions = normalizeListResourcesOptions(options);
  const listing = await listKnowledgeBaseDocuments({
    rootDir: KNOWLEDGE_BASES_ROOT_DIR,
    ...(normalizedOptions.kbName !== undefined ? { kbName: normalizedOptions.kbName } : {}),
    prefix: normalizedOptions.prefix,
    prefixMode: 'resource-prefix',
    failOnEnumerationError: false,
    ...(normalizedOptions.limit !== undefined
      ? { maxDocuments: normalizedOptions.offset + normalizedOptions.limit + 1 }
      : {}),
    extraExtensions: INGEST_EXTRA_EXTENSIONS,
    excludePaths: INGEST_EXCLUDE_PATHS,
  });
  const resources = listing.documents.map((document) => ({
    uri: buildResourceUri(document.kbName, document.relativePath),
    name: document.relativePath,
    description: `Document in knowledge base "${document.kbName}"`,
    mimeType: mimeTypeForResource(document.absolutePath),
  }));

  if (normalizedOptions.limit === undefined) {
    return { resources };
  }

  const pageResources = resources.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.limit,
  );
  const nextOffset = normalizedOptions.offset + pageResources.length;
  const nextCursor = nextOffset < resources.length
    ? encodeListResourcesCursor({
      v: 1,
      offset: nextOffset,
      kbName: normalizedOptions.kbName,
      prefix: normalizedOptions.prefix,
      limit: normalizedOptions.limit,
    })
    : undefined;

  return nextCursor === undefined
    ? { resources: pageResources }
    : { resources: pageResources, nextCursor };
}

export function listResourceTemplates(): ListResourceTemplatesResult {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'kb://{kb}/{path}',
        name: 'kb-document',
        description: 'Read an ingestable, non-quarantined knowledge-base document by KB name and relative path.',
      },
    ],
  };
}

/**
 * `resources/read` body. Parses the `kb://` URI, resolves the document
 * under `KNOWLEDGE_BASES_ROOT_DIR` (which rejects traversal escapes),
 * rejects files the ingest pipeline would skip or has quarantined, and
 * returns either a base64 blob (PDF) or UTF-8 text (markdown, HTML,
 * plain text).
 */
export async function readResource(
  uri: string,
  options: ReadResourceOptions = {},
): Promise<ReadResourceResult> {
  const { kbName, relativePath } = parseKnowledgeBaseResourceUri(uri);
  const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  const requestedPath = path.join(kbPath, relativePath);
  const filePath = await resolveKbPath(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbName,
    relativePath,
    { mustExist: true },
  );
  const ingestable = filterIngestablePaths([requestedPath], kbPath, {
    extraExtensions: INGEST_EXTRA_EXTENSIONS,
    excludePaths: INGEST_EXCLUDE_PATHS,
  });
  if (ingestable.length === 0) {
    throw new Error(`resource excluded by ingest filters: ${JSON.stringify(relativePath)}`);
  }

  const quarantined = await listIngestQuarantine(kbPath);
  if (quarantined.some((record) => record.relative_path === relativePath)) {
    throw new Error(`resource quarantined by ingest pipeline: ${JSON.stringify(relativePath)}`);
  }

  const mimeType = mimeTypeForResource(filePath);

  if (mimeType === 'application/pdf') {
    const blob = (await fsp.readFile(filePath)).toString('base64');
    return {
      contents: [{ uri, mimeType, blob }],
    };
  }

  const text = await fsp.readFile(filePath, 'utf-8');
  assertResourceReadPolicy({
    text,
    relativePath,
    access: options.access ?? resolveResourceReadAccess(),
  });

  return {
    contents: [{ uri, mimeType, text }],
  };
}

function assertResourceReadPolicy(input: {
  text: string;
  relativePath: string;
  access: KbResourceReadAccess;
}): void {
  const parsed = parseFrontmatter(input.text);
  const policy = normalizeKbSensitivityPolicy(parsed.frontmatter.kb_policy);
  const decision = decideResourceRead(policy, input.access);
  if (decision.allowed) return;

  const detail = decision.reason === 'resource_read_local_only'
    ? 'resource is marked local_only and the MCP transport is remote'
    : 'resource is marked deny';
  throw new Error(`resource blocked by kb_policy.resource_read: ${JSON.stringify(input.relativePath)} (${detail})`);
}

/**
 * Wire the resources surface onto an `McpServer`. Registers
 * `resources/list`, `resources/read`, and `resources/templates/list`.
 * Called once from `KnowledgeBaseServer.buildMcpServer`.
 */
export function registerResources(mcp: McpServer): void {
  mcp.server.registerCapabilities({
    resources: {
      listChanged: true,
    },
  });

  mcp.server.setRequestHandler(ListResourcesRequestSchema, async (request: ListResourcesRequest) =>
    listResources(request.params),
  );
  mcp.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => listResourceTemplates());
  mcp.server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(request.params.uri),
  );
}
