// Shared document inventory for the CLI and MCP resources/list surfaces.
//
// Keeping ingest filtering and quarantine handling here prevents a document
// from being discoverable through one surface while silently absent from the
// other. The returned order is deterministic so callers can page or pipe it
// without adding their own sorting rules.

import * as path from 'path';
import { INGEST_EXCLUDE_PATHS, INGEST_EXTRA_EXTENSIONS } from './config/ingest.js';
import {
  assertNoTraversal,
  enumerateIngestableKbFiles,
  listKnowledgeBases,
} from './kb-fs.js';
import { isValidKbName } from './kb-paths.js';
import { listIngestQuarantine } from './ingest-quarantine.js';

export interface KnowledgeBaseDocument {
  kbName: string;
  kbPath: string;
  absolutePath: string;
  relativePath: string;
}

export interface ListKnowledgeBaseDocumentsOptions {
  rootDir: string;
  kbName?: string;
  prefix?: string;
  extraExtensions?: readonly string[];
  excludePaths?: readonly string[];
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
  const normalized = prefix.replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized;
}

/**
 * Return whether a relative document path matches the requested path prefix.
 * A segment-complete prefix such as `docs` is subtree-scoped (`docs2` does
 * not match), while prefixes containing a slash retain resources/list's
 * established partial-leaf behavior (`docs/g` matches `docs/guide.md`).
 */
export function documentMatchesPrefix(relativePath: string, prefix: string): boolean {
  if (prefix.length === 0) return true;
  if (!relativePath.startsWith(prefix)) return false;
  if (relativePath.length === prefix.length || relativePath[prefix.length] === '/') return true;
  return prefix.includes('/');
}

export async function listKnowledgeBaseDocuments(
  options: ListKnowledgeBaseDocumentsOptions,
): Promise<KnowledgeBaseDocumentListing> {
  const prefix = normalizeDocumentPrefix(options.prefix);
  const knowledgeBases = options.kbName === undefined
    ? (await listKnowledgeBases(options.rootDir)).filter(isValidKbName).sort(compareStrings)
    : [validateKbName(options.kbName)];

  const enumerations = await enumerateIngestableKbFiles(
    options.rootDir,
    knowledgeBases,
    {
      extraExtensions: options.extraExtensions ?? INGEST_EXTRA_EXTENSIONS,
      excludePaths: options.excludePaths ?? INGEST_EXCLUDE_PATHS,
    },
  );

  const documents: KnowledgeBaseDocument[] = [];
  for (const enumeration of enumerations) {
    const quarantined = new Set(
      (await listIngestQuarantine(enumeration.kbPath)).map((record) => record.relative_path),
    );
    for (const absolutePath of enumeration.filePaths.sort(compareStrings)) {
      const relativePath = normalizeRelativePath(absolutePath, enumeration.kbPath);
      if (quarantined.has(relativePath) || !documentMatchesPrefix(relativePath, prefix)) continue;
      documents.push({
        kbName: enumeration.kbName,
        kbPath: enumeration.kbPath,
        absolutePath,
        relativePath,
      });
    }
  }

  documents.sort((a, b) =>
    compareStrings(a.kbName, b.kbName) || compareStrings(a.relativePath, b.relativePath),
  );
  return { knowledgeBases, documents, prefix };
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
  return a.localeCompare(b);
}
