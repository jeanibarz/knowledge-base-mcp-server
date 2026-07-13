// Shared document inventory for the CLI and MCP resources/list surfaces.
//
// Keeping ingest filtering and quarantine handling here prevents a document
// from being discoverable through one surface while silently absent from the
// other. The returned order is deterministic so callers can page or pipe it
// without adding their own sorting rules.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { INGEST_EXCLUDE_PATHS, INGEST_EXTRA_EXTENSIONS } from './config/ingest.js';
import {
  assertNoTraversal,
  enumerateIngestableKbFiles,
  type KbFileEnumeration,
  listKnowledgeBases,
  resolveKnowledgeBaseDir,
} from './kb-fs.js';
import { filterIngestablePaths } from './ingest-filter.js';
import { isValidKbName } from './kb-paths.js';
import { listIngestQuarantine } from './ingest-quarantine.js';
import { getFilesRecursivelyWithDiagnostics } from './file-utils.js';

export interface KnowledgeBaseDocument {
  kbName: string;
  absolutePath: string;
  relativePath: string;
}

export interface ListKnowledgeBaseDocumentsOptions {
  rootDir: string;
  kbName?: string;
  prefix?: string;
  extraExtensions?: readonly string[];
  excludePaths?: readonly string[];
  /** Preserve the historical partial-leaf matching used by resources/list. */
  prefixMode?: 'subtree' | 'resource-prefix';
  /** Reject incomplete filesystem walks instead of returning a partial listing. */
  failOnEnumerationError?: boolean;
  /** Stop after this many sorted matches; used to retain MCP lookahead pagination. */
  maxDocuments?: number;
  /** Treat a missing/stale KB name as an empty scope for MCP compatibility. */
  skipMissingKb?: boolean;
}

export interface KnowledgeBaseDocumentListing {
  knowledgeBases: string[];
  documents: KnowledgeBaseDocument[];
  prefix: string;
}

/** Normalize a user- or protocol-supplied KB-relative subtree prefix. */
export function normalizeDocumentPrefix(raw: string | undefined): string {
  const prefix = raw ?? '';
  if (prefix.includes('\0')) {
    throw new Error('document listing prefix contains null byte');
  }
  if (prefix.length === 0) return '';

  assertNoTraversal(prefix);
  const normalized = path.posix.normalize(prefix.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === './') return '';
  const withoutTrailingSlash = normalized.replace(/\/+$/g, '');
  return withoutTrailingSlash.length === 0 ? '' :
    (normalized.endsWith('/') ? `${withoutTrailingSlash}/` : withoutTrailingSlash);
}

/**
 * Return whether a relative document path matches the requested path prefix.
 * The CLI uses segment-complete subtree matching so `docs` does not match
 * `docs2`. The resources/list compatibility mode additionally supports its
 * established partial-leaf behavior (`docs/g` matches `docs/guide.md`).
 */
export function documentMatchesPrefix(
  relativePath: string,
  prefix: string,
  prefixMode: 'subtree' | 'resource-prefix' = 'subtree',
): boolean {
  if (prefix.length === 0) return true;
  if (prefix.endsWith('/')) return relativePath.startsWith(prefix);
  if (!relativePath.startsWith(prefix)) return false;
  if (relativePath.length === prefix.length || relativePath[prefix.length] === '/') return true;
  return prefixMode === 'resource-prefix';
}

export async function listKnowledgeBaseDocuments(
  options: ListKnowledgeBaseDocumentsOptions,
): Promise<KnowledgeBaseDocumentListing> {
  const prefix = normalizeDocumentPrefix(options.prefix);
  const knowledgeBases = options.kbName === undefined
    ? await listKnowledgeBaseDirectories(options.rootDir)
    : [validateKbName(options.kbName)];

  const documents: KnowledgeBaseDocument[] = [];
  if (
    options.maxDocuments !== undefined &&
    (!Number.isInteger(options.maxDocuments) || options.maxDocuments <= 0)
  ) {
    throw new Error('maxDocuments must be a positive integer');
  }
  let reachedMax = false;
  const resolvedKnowledgeBases: string[] = [];
  for (const kbName of knowledgeBases) {
    // Resolve every discovered KB before walking it. In particular, a
    // directory symlink may pass listKnowledgeBases() but point outside the
    // configured root, which must never become an enumerable document scope.
    try {
      await resolveKnowledgeBaseDir(options.rootDir, kbName);
    } catch (error: unknown) {
      const skipMissing = options.skipMissingKb ?? options.kbName === undefined;
      if (skipMissing && (error as { code?: unknown }).code === 'KB_NOT_FOUND') continue;
      throw error;
    }
    resolvedKnowledgeBases.push(kbName);
    const enumeration = prefix.length === 0
      ? (await enumerateIngestableKbFiles(
        options.rootDir,
        [kbName],
        {
          extraExtensions: options.extraExtensions ?? INGEST_EXTRA_EXTENSIONS,
          excludePaths: options.excludePaths ?? INGEST_EXCLUDE_PATHS,
        },
      ))[0]
      : await enumerateKbForPrefix(options.rootDir, kbName, prefix, options);
    if (enumeration === undefined) continue;
    if ((options.failOnEnumerationError ?? true) && enumeration.diagnostics.failure_count > 0) {
      const sample = enumeration.diagnostics.failures[0];
      const detail = sample === undefined ? '' : ` (${sample.path}: ${sample.message})`;
      throw new Error(
        `incomplete document listing for knowledge base ${JSON.stringify(kbName)}: ` +
        `${enumeration.diagnostics.failure_count} filesystem traversal failure(s)${detail}`,
      );
    }
    const quarantined = new Set(
      (await listIngestQuarantine(enumeration.kbPath, { useLock: false }))
        .map((record) => record.relative_path),
    );
    for (const absolutePath of enumeration.filePaths.sort(compareStrings)) {
      const relativePath = normalizeRelativePath(absolutePath, enumeration.kbPath);
      if (
        quarantined.has(relativePath) ||
        !documentMatchesPrefix(relativePath, prefix, options.prefixMode)
      ) continue;
      documents.push({
        kbName: enumeration.kbName,
        absolutePath,
        relativePath,
      });
      if (options.maxDocuments !== undefined && documents.length >= options.maxDocuments) {
        reachedMax = true;
        break;
      }
    }
    if (reachedMax) break;
  }

  documents.sort((a, b) =>
    compareStrings(a.kbName, b.kbName) || compareStrings(a.relativePath, b.relativePath),
  );
  return { knowledgeBases: resolvedKnowledgeBases, documents, prefix };
}

async function enumerateKbForPrefix(
  rootDir: string,
  kbName: string,
  prefix: string,
  options: ListKnowledgeBaseDocumentsOptions,
): Promise<KbFileEnumeration> {
  const kbPath = path.join(rootDir, kbName);
  if (prefix.split('/').some((segment) => segment.startsWith('.'))) {
    return { kbName, kbPath, filePaths: [], diagnostics: { failure_count: 0, failures: [] } };
  }
  const searchRelativeDir = prefixSearchRelativeDir(prefix, options.prefixMode);
  const searchRoot = path.join(kbPath, searchRelativeDir);
  let stat;
  try {
    stat = await fsp.stat(searchRoot);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kbName, kbPath, filePaths: [], diagnostics: { failure_count: 0, failures: [] } };
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    return { kbName, kbPath, filePaths: [], diagnostics: { failure_count: 0, failures: [] } };
  }

  const kbRealPath = await fsp.realpath(kbPath);
  const searchRealPath = await fsp.realpath(searchRoot);
  if (!isPathWithin(kbRealPath, searchRealPath)) {
    throw new Error(
      `document listing prefix ${JSON.stringify(prefix)} resolves outside ` +
      `knowledge base ${JSON.stringify(kbName)}`,
    );
  }

  const enumeration = await getFilesRecursivelyWithDiagnostics(searchRoot);
  return {
    kbName,
    kbPath,
    filePaths: filterIngestablePaths(enumeration.files, kbPath, {
      extraExtensions: options.extraExtensions ?? INGEST_EXTRA_EXTENSIONS,
      excludePaths: options.excludePaths ?? INGEST_EXCLUDE_PATHS,
    }),
    diagnostics: enumeration.diagnostics,
  };
}

async function listKnowledgeBaseDirectories(rootDir: string): Promise<string[]> {
  const candidates = (await listKnowledgeBases(rootDir)).filter(isValidKbName);
  const directories: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await fsp.stat(path.join(rootDir, candidate))).isDirectory()) {
        directories.push(candidate);
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
  }
  return directories.sort(compareStrings);
}

function prefixSearchRelativeDir(
  prefix: string,
  prefixMode: ListKnowledgeBaseDocumentsOptions['prefixMode'],
): string {
  if (prefix.endsWith('/')) return prefix.slice(0, -1);
  if (prefixMode === 'resource-prefix') {
    const segments = prefix.split('/');
    return segments.length > 1 ? segments.slice(0, -1).join('/') : '';
  }
  return prefix;
}

function validateKbName(kbName: string): string {
  if (!isValidKbName(kbName)) {
    throw new Error(`invalid KB name: ${JSON.stringify(kbName)}`);
  }
  return kbName;
}

function normalizeRelativePath(filePath: string, kbPath: string): string {
  return path.relative(kbPath, filePath).split(path.sep).join('/');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}
