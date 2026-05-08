// src/file-ingest.ts
//
// Issue #179 — per-file embedding helpers extracted out of the
// `FaissIndexManager.updateIndex` loop. Two pieces live here:
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
//
// The class still owns the loop orchestration and `addDocumentsToIndex`
// (which mutates `this.faissIndex`); these helpers are pure / I/O-only
// so they're testable on their own and don't carry per-instance state.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { Document } from '@langchain/core/documents';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { KNOWLEDGE_BASES_ROOT_DIR, resolveChunkSize } from './config.js';
import { handleFsOperationError } from './error-utils.js';
import { parseFrontmatter } from './frontmatter.js';
import { detectSiblingPdfPath, liftFrontmatter } from './frontmatter-lift.js';
import { withSidecarLock } from './write-lock.js';

export interface PendingSidecarWrite {
  /** Absolute path of the sidecar file under `<kb>/.index/`. */
  path: string;
  /** SHA-256 hex digest of the embedded source file. */
  hash: string;
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

  const { tags, body, frontmatter } = parseFrontmatter(content);
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
