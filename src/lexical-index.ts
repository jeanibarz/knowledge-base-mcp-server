// Issue #206 stage 1 — per-KB BM25 lexical index.
//
// Why this module exists. The dense FAISS retriever has known blind spots
// on exact-token queries: filenames, RFC/ADR numbers, error codes, env var
// names, model ids. RFC 006 §4 explicitly named sparse+dense hybrid
// retrieval as a non-goal and deferred it to a "follow-up sparse-hybrid
// RFC". Issue #206 is that follow-up's stage 1 — ship a per-KB BM25 index
// and a `kb search --mode=lexical` debug surface, with no MCP-surface
// change. Stage 2 (RRF fusion) lands on top.
//
// Why a self-contained module rather than wiring into FaissIndexManager.
// `@langchain/community/retrievers/bm25` is in-memory only — it stores a
// `Document[]` and recomputes BM25 scores on every query (verified by
// reading `node_modules/.../utils/@furkantoprak/bm25/BM25.js`). There is
// no precomputed sparse index, no native incremental upsert. The
// invalidation primitives this module needs (per-file SHA + the same
// chunker the FAISS path uses) already exist as separate building blocks
// (`calculateSHA256`, `buildChunkDocuments`); reusing them lets stage 1
// land without surgery on `FaissIndexManager.updateIndex`, which the
// recent #156-#179 refactor cluster just reshaped. Stage 2 is free to
// wire deeper integration once fusion semantics demand it.
//
// Storage layout. `${FAISS_INDEX_PATH}/lexical/<kbName>/index.json` —
// JSON, atomic tmp+rename. The on-disk shape is deliberately the doc
// list (one entry per *file*, holding that file's chunk array) plus the
// per-file SHA the entry was built from. That makes invalidation a
// per-file hash compare, mirroring the FAISS sidecar pattern but in a
// single JSON document. The per-KB nesting (rather than per-model) is
// because BM25 is embedding-model-agnostic — one index serves every
// dense model.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { Document } from '@langchain/core/documents';
import { BM25Retriever } from '@langchain/community/retrievers/bm25';
import { FAISS_INDEX_PATH, INGEST_EXCLUDE_PATHS, INGEST_EXTRA_EXTENSIONS } from './config.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import { buildChunkDocuments } from './file-ingest.js';
import { KBError } from './errors.js';
import { enumerateIngestableKbFiles } from './kb-fs.js';
import { loadFile } from './loaders.js';
import { logger } from './logger.js';
import { toError } from './error-utils.js';

const SCHEMA_VERSION = 1;

interface SerializedDocument {
  pageContent: string;
  metadata: Record<string, unknown>;
}

interface FileEntry {
  sha256: string;
  chunks: SerializedDocument[];
}

interface LexicalIndexFile {
  version: number;
  kbName: string;
  writtenAt: string;
  files: Record<string, FileEntry>;
}

export interface RefreshSummary {
  added: number;
  updated: number;
  removed: number;
  failed: number;
  totalFiles: number;
  totalChunks: number;
}

export interface LexicalSearchResult {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

function lexicalRootDir(): string {
  return path.join(FAISS_INDEX_PATH, 'lexical');
}

function lexicalKbDir(kbName: string): string {
  return path.join(lexicalRootDir(), kbName);
}

function lexicalIndexFilePath(kbName: string): string {
  return path.join(lexicalKbDir(kbName), 'index.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Per-KB BM25 lexical index. Construct via `LexicalIndex.load(kbName, kbPath)`.
 *
 * Lifecycle:
 *
 *   const idx = await LexicalIndex.load(kbName, kbPath);
 *   await idx.refresh();    // walks files, rehashes, rebuilds changed entries
 *   await idx.save();       // persist
 *   const hits = await idx.query("INDEX_NOT_INITIALIZED", 10);
 *
 * `refresh` is the only mutator. It is idempotent over a steady-state KB and
 * O(changed-files) over a partially-modified one. A caller that does not
 * `refresh` before `query` will simply search whatever was on disk last.
 */
export class LexicalIndex {
  private constructor(
    public readonly kbName: string,
    public readonly kbPath: string,
    private entries: Map<string, FileEntry>,
  ) {}

  static async load(kbName: string, kbPath: string): Promise<LexicalIndex> {
    const filePath = lexicalIndexFilePath(kbName);
    if (!(await pathExists(filePath))) {
      return new LexicalIndex(kbName, kbPath, new Map());
    }

    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf-8');
    } catch (error) {
      throw new KBError(
        'CORRUPT_INDEX',
        `Lexical index for KB "${kbName}" exists but could not be read: ${toError(error).message}`,
        toError(error),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new KBError(
        'CORRUPT_INDEX',
        `Lexical index for KB "${kbName}" is not valid JSON; delete ${filePath} to force a rebuild on the next --refresh.`,
        toError(error),
      );
    }

    if (!isPlainObject(parsed) || (parsed as { version?: unknown }).version !== SCHEMA_VERSION) {
      throw new KBError(
        'CORRUPT_INDEX',
        `Lexical index for KB "${kbName}" has unsupported schema; delete ${filePath} to force a rebuild on the next --refresh.`,
      );
    }
    const file = parsed as unknown as LexicalIndexFile;
    if (!isPlainObject(file.files)) {
      throw new KBError(
        'CORRUPT_INDEX',
        `Lexical index for KB "${kbName}" is missing the "files" map; delete ${filePath} to force a rebuild on the next --refresh.`,
      );
    }

    const entries = new Map<string, FileEntry>();
    for (const [relPath, entry] of Object.entries(file.files)) {
      if (
        !isPlainObject(entry) ||
        typeof (entry as FileEntry).sha256 !== 'string' ||
        !Array.isArray((entry as FileEntry).chunks)
      ) {
        throw new KBError(
          'CORRUPT_INDEX',
          `Lexical index for KB "${kbName}" has malformed entry for ${relPath}; delete ${filePath} to force a rebuild on the next --refresh.`,
        );
      }
      entries.set(relPath, entry as FileEntry);
    }
    return new LexicalIndex(kbName, kbPath, entries);
  }

  /**
   * Walk the KB, hash each ingestable file, rebuild entries for any whose
   * SHA-256 has changed, drop entries for files no longer present.
   *
   * Returns counts so callers (e.g. `kb search --mode=lexical --refresh`)
   * can report progress. Files that fail to load throw a non-fatal log
   * line and are counted under `failed`; the index advances around them.
   * This mirrors the FAISS path's silent-skip-and-continue policy at
   * `FaissIndexManager.ts:574, :610`.
   */
  async refresh(): Promise<RefreshSummary> {
    const summary: RefreshSummary = {
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      totalFiles: 0,
      totalChunks: 0,
    };

    const enumeration = await enumerateIngestableKbFiles(
      path.dirname(this.kbPath),
      [this.kbName],
      {
        extraExtensions: INGEST_EXTRA_EXTENSIONS,
        excludePaths: INGEST_EXCLUDE_PATHS,
      },
    );
    const filePaths = enumeration[0]?.filePaths ?? [];
    const seen = new Set<string>();

    for (const absPath of filePaths) {
      const relPath = path.relative(this.kbPath, absPath).split(path.sep).join('/');
      seen.add(relPath);

      let sha: string;
      try {
        sha = await calculateSHA256(absPath);
      } catch (error) {
        logger.error(`Lexical index: SHA failure for ${absPath}:`, toError(error));
        summary.failed += 1;
        continue;
      }

      const existing = this.entries.get(relPath);
      if (existing && existing.sha256 === sha) {
        continue;
      }

      let content: string;
      try {
        content = await loadFile(absPath);
      } catch (error) {
        logger.error(`Lexical index: load failure for ${absPath}:`, toError(error));
        summary.failed += 1;
        continue;
      }

      let chunks: Document[];
      try {
        chunks = await buildChunkDocuments(absPath, content, this.kbName);
      } catch (error) {
        logger.error(`Lexical index: chunk failure for ${absPath}:`, toError(error));
        summary.failed += 1;
        continue;
      }

      const serialized: SerializedDocument[] = chunks.map((doc) => ({
        pageContent: doc.pageContent,
        metadata: doc.metadata,
      }));
      this.entries.set(relPath, { sha256: sha, chunks: serialized });
      if (existing) {
        summary.updated += 1;
      } else {
        summary.added += 1;
      }
    }

    for (const relPath of [...this.entries.keys()]) {
      if (!seen.has(relPath)) {
        this.entries.delete(relPath);
        summary.removed += 1;
      }
    }

    summary.totalFiles = this.entries.size;
    let chunkCount = 0;
    for (const entry of this.entries.values()) {
      chunkCount += entry.chunks.length;
    }
    summary.totalChunks = chunkCount;
    return summary;
  }

  async save(): Promise<void> {
    const dir = lexicalKbDir(this.kbName);
    await fsp.mkdir(dir, { recursive: true });
    const filePath = lexicalIndexFilePath(this.kbName);
    const tmpPath = `${filePath}.tmp`;

    const files: Record<string, FileEntry> = {};
    const sortedKeys = [...this.entries.keys()].sort();
    for (const key of sortedKeys) {
      files[key] = this.entries.get(key) as FileEntry;
    }

    const payload: LexicalIndexFile = {
      version: SCHEMA_VERSION,
      kbName: this.kbName,
      writtenAt: new Date().toISOString(),
      files,
    };
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await fsp.rename(tmpPath, filePath);
  }

  /**
   * BM25 top-k. Reconstructs a flat `Document[]` from the per-file entries
   * and instantiates a fresh `BM25Retriever`. The retriever recomputes
   * scores from scratch on every call (LangChain BM25 is non-incremental),
   * so cost scales O(N chunks × query terms). For stage 1 this is
   * acceptable; future optimization (precomputed inverted index) is
   * deliberately out of scope per #206 §"Out of scope for this RFC".
   *
   * Case folding. `BM25Retriever.preprocessFunc` lowercases the query but
   * NOT the documents (verified in
   * `node_modules/@langchain/community/dist/retrievers/bm25.js`), so a
   * case-mismatched exact-token query — which is the whole point of
   * shipping BM25 — never matches. We compensate by lowercasing the
   * pageContent we feed to BM25 while keeping the original chunk for
   * output. An `_orig_idx` metadata stamp threads the mapping. Tokenizer
   * tuning (stemming, camelCase splitting) is deferred per #206 risks.
   */
  async query(query: string, k: number): Promise<LexicalSearchResult[]> {
    const originals: SerializedDocument[] = [];
    const flat: Document[] = [];
    for (const entry of this.entries.values()) {
      for (const chunk of entry.chunks) {
        const idx = originals.length;
        originals.push(chunk);
        flat.push(new Document({
          pageContent: chunk.pageContent.toLowerCase(),
          metadata: { _orig_idx: idx },
        }));
      }
    }
    if (flat.length === 0 || k <= 0) {
      return [];
    }

    const retriever = BM25Retriever.fromDocuments(flat, { k, includeScore: true });
    const docs = await retriever.invoke(query);
    return docs.map((doc) => {
      const meta = (doc.metadata ?? {}) as Record<string, unknown> & { bm25Score?: number; _orig_idx?: number };
      const origIdx = typeof meta._orig_idx === 'number' ? meta._orig_idx : 0;
      const orig = originals[origIdx];
      return {
        pageContent: orig.pageContent,
        metadata: orig.metadata,
        score: typeof meta.bm25Score === 'number' ? meta.bm25Score : 0,
      };
    });
  }

  numFiles(): number {
    return this.entries.size;
  }

  numChunks(): number {
    let n = 0;
    for (const entry of this.entries.values()) n += entry.chunks.length;
    return n;
  }
}
