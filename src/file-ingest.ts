// src/file-ingest.ts
//
// Issue #179 — per-file embedding helpers extracted out of the
// `FaissIndexManager.updateIndex` loop. Three pieces live here:
//
//   1. `buildChunkDocuments(filePath, content, knowledgeBaseName)` —
//      run the markdown / recursive splitter, attach the wire-shape
//      metadata (source, relativePath, knowledgeBase, extension,
//      chunkIndex, tags, lifted frontmatter, sibling PDF path).
//   2. `writeSidecarHashes(pendingHashWrites)` — atomically rename
//      tmp files into `<kb>/.index/...` under the cross-model sidecar
//      lock. Recreates the parent dir if a peer's `purgeStaleSidecars`
//      raced and rmrf'd it between the loop's pre-pass `mkdir` and
//      this write.
//   3. `normalizeChunkTextForEmbedding(text)` — canonicalize chunk text
//      for exact duplicate embedding compaction during indexing.
//
// The class still owns the loop orchestration and `addDocumentsToIndex`
// (which mutates `this.faissIndex`); these helpers are pure / I/O-only
// so they're testable on their own and don't carry per-instance state.

import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import { Document } from '@langchain/core/documents';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { resolveChunkSize } from './config/indexing.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { handleFsOperationError } from './error-utils.js';
import { parseFrontmatter } from './frontmatter.js';
import { detectSiblingPdfPath, liftFrontmatter } from './frontmatter-lift.js';
import { applyExtractedTextLimit } from './loaders.js';
import { withSidecarLock } from './write-lock.js';

export interface PendingSidecarWrite {
  /** Absolute path of the sidecar file under `<kb>/.index/`. */
  path: string;
  /** SHA-256 hex digest of the embedded source file. */
  hash: string;
}

export const CHUNK_MANIFEST_SCHEMA_VERSION = 'kb.chunk-manifest.v1';

export interface ChunkManifestEntry {
  chunkIndex: number;
  textHash: string;
  metadataHash: string;
  vectorDocstoreId: string;
}

export interface ChunkManifest {
  schema_version: typeof CHUNK_MANIFEST_SCHEMA_VERSION;
  source_sha256: string;
  chunks: ChunkManifestEntry[];
}

export interface PendingChunkManifestWrite {
  /** Absolute path of the chunk manifest sidecar under `<kb>/.index/`. */
  path: string;
  manifest: ChunkManifest;
}

export function normalizeChunkTextForEmbedding(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (isJsonObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalizeJsonValue(value[key]);
    }
    return sorted;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return null;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function buildChunkManifest(
  documents: ReadonlyArray<Document>,
  sourceHash: string,
): ChunkManifest {
  return {
    schema_version: CHUNK_MANIFEST_SCHEMA_VERSION,
    source_sha256: sourceHash,
    chunks: documents.map((document, index) => {
      const chunkIndex = typeof document.metadata?.chunkIndex === 'number'
        ? document.metadata.chunkIndex
        : index;
      const textHash = sha256Hex(normalizeChunkTextForEmbedding(document.pageContent));
      const metadataHash = sha256Hex(stableJsonStringify(document.metadata ?? {}));
      return {
        chunkIndex,
        textHash,
        metadataHash,
        vectorDocstoreId: sha256Hex(`${chunkIndex}\0${textHash}\0${metadataHash}`),
      };
    }),
  };
}

function isChunkManifestEntry(value: unknown): value is ChunkManifestEntry {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.chunkIndex === 'number' &&
    Number.isSafeInteger(value.chunkIndex) &&
    value.chunkIndex >= 0 &&
    typeof value.textHash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.textHash) &&
    typeof value.metadataHash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.metadataHash) &&
    typeof value.vectorDocstoreId === 'string' &&
    /^[0-9a-f]{64}$/.test(value.vectorDocstoreId)
  );
}

function isChunkManifest(value: unknown): value is ChunkManifest {
  if (!isJsonObject(value)) return false;
  return (
    value.schema_version === CHUNK_MANIFEST_SCHEMA_VERSION &&
    typeof value.source_sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.source_sha256) &&
    Array.isArray(value.chunks) &&
    value.chunks.every(isChunkManifestEntry)
  );
}

export async function readChunkManifest(manifestPath: string): Promise<ChunkManifest | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isChunkManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function countStableChunkPrefix(
  previous: ChunkManifest,
  next: ChunkManifest,
): number {
  const limit = Math.min(previous.chunks.length, next.chunks.length);
  let stablePrefix = 0;
  for (; stablePrefix < limit; stablePrefix += 1) {
    const previousChunk = previous.chunks[stablePrefix];
    const nextChunk = next.chunks[stablePrefix];
    if (
      previousChunk.chunkIndex !== nextChunk.chunkIndex ||
      previousChunk.textHash !== nextChunk.textHash ||
      previousChunk.metadataHash !== nextChunk.metadataHash
    ) {
      break;
    }
  }
  return stablePrefix;
}

/**
 * RFC 011 §5.4.2-aware chunk builder. Markdown files use the markdown
 * splitter (heading-aware); everything else (PDF text via pdf-parse,
 * HTML via html-to-text, operator-supplied extensions like `.json` /
 * `.csv`) goes through the recursive character splitter.
 *
 * Each emitted `Document` carries the wire-shape metadata
 * `retrieve_knowledge` projects: `source`, `relativePath` (POSIX-form,
 * KNOWLEDGE_BASES_ROOT_DIR-relative, used by `path_glob` filters),
 * `knowledgeBase`, `extension`, `chunkIndex`, `tags`, plus optional
 * `frontmatter` (whitelisted) and `pdf_path` (sibling-PDF detection
 * for `.md`, RFC 011 §5.3.4).
 */
export async function buildChunkDocuments(
  filePath: string,
  content: string,
  knowledgeBaseName: string,
): Promise<Document[]> {
  const ext = path.extname(filePath).toLowerCase();
  const { chunkSize, chunkOverlap } = resolveChunkSize();
  const splitter = ext === '.md'
    ? new MarkdownTextSplitter({
        chunkSize,
        chunkOverlap,
        keepSeparator: false,
      })
    : new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
      });

  const boundedContent = applyExtractedTextLimit(filePath, content);
  const { tags, body, frontmatter } = parseFrontmatter(boundedContent);
  const relativePath = path
    .relative(KNOWLEDGE_BASES_ROOT_DIR, filePath)
    .split(path.sep)
    .join('/');

  // RFC 011 §5.4.2: whitelist the known frontmatter keys and divert any
  // other string-valued keys into `extras`. Non-string-valued keys are
  // dropped (FAILSAFE YAML produces strings, arrays, or maps — the last
  // two are not whitelisted and have no safe scalar representation here).
  const liftedFrontmatter = liftFrontmatter(frontmatter, filePath);

  // RFC 011 §5.3.4: detect a sibling PDF for `.md` files. Once per file,
  // before the splitter loop; attached to every chunk via the metadata
  // spread below.
  const pdfPath = ext === '.md'
    ? detectSiblingPdfPath(filePath, knowledgeBaseName)
    : undefined;

  const documents = await splitter.createDocuments(
    [body],
    [{ source: filePath }],
  );
  for (let i = 0; i < documents.length; i += 1) {
    documents[i].metadata = {
      ...documents[i].metadata,
      source: filePath,
      relativePath,
      knowledgeBase: knowledgeBaseName,
      extension: ext,
      chunkIndex: i,
      tags,
      ...(liftedFrontmatter !== undefined ? { frontmatter: liftedFrontmatter } : {}),
      ...(pdfPath !== undefined ? { pdf_path: pdfPath } : {}),
    };
  }
  return documents;
}

/**
 * Atomic sidecar-hash write batch. tmp+rename keeps each sidecar atomic;
 * if `mkdir` fails (a peer purged the parent) it's recreated before the
 * tmp write. The whole batch runs under `withSidecarLock` so a concurrent
 * `purgeStaleSidecars` cross-model can't rmrf `<kb>/.index/` between the
 * loop's pre-pass `mkdir` and our `rename`.
 *
 * Best-effort tmp cleanup on failure: the original FS error is the one
 * that propagates via `handleFsOperationError`, the leftover `.tmp` is
 * harmless (next pass overwrites it).
 */
export async function writeSidecarHashes(
  pendingHashWrites: ReadonlyArray<PendingSidecarWrite>,
): Promise<void> {
  if (pendingHashWrites.length === 0) return;
  await withSidecarLock(async () => {
    await Promise.all(
      pendingHashWrites.map(async ({ path: target, hash }) => {
        const tmpPath = `${target}.tmp`;
        try {
          // Recreate the parent if a peer purged it between the
          // pre-loop mkdir and now. mkdir({ recursive: true }) is a
          // no-op when the dir already exists.
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(tmpPath, hash, { encoding: 'utf-8' });
          await fsp.rename(tmpPath, target);
        } catch (error) {
          try {
            await fsp.unlink(tmpPath);
          } catch {
            // best-effort cleanup; original error is what matters
          }
          handleFsOperationError('write file hash metadata to', target, error);
        }
      }),
    );
  });
}

export async function writeChunkManifests(
  pendingManifestWrites: ReadonlyArray<PendingChunkManifestWrite>,
): Promise<void> {
  if (pendingManifestWrites.length === 0) return;
  await withSidecarLock(async () => {
    await Promise.all(
      pendingManifestWrites.map(async ({ path: target, manifest }) => {
        const tmpPath = `${target}.tmp`;
        try {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(tmpPath, JSON.stringify(manifest), {
            encoding: 'utf-8',
            mode: 0o600,
          });
          await fsp.rename(tmpPath, target);
        } catch (error) {
          try {
            await fsp.unlink(tmpPath);
          } catch {
            // best-effort cleanup; original error is what matters
          }
          handleFsOperationError('write chunk manifest to', target, error);
        }
      }),
    );
  });
}
