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
import type { Document } from '@langchain/core/documents';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { INGEST_EXCLUDE_PATHS, INGEST_EXTRA_EXTENSIONS } from './config/ingest.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import { embeddingText } from './contextual-preface.js';
import { buildChunkDocuments } from './file-ingest.js';
import { KBError } from './errors.js';
import { enumerateIngestableKbFiles } from './kb-fs.js';
import { loadFile } from './loaders.js';
import { logger } from './logger.js';
import { toError } from './error-utils.js';
import { LexicalBm25Ranker, type LexicalBm25Record } from './lexical-bm25.js';

// RFC 017 §3 — schema v2 splits BM25 scoring text from caller-output
// text. v1 (pre-RFC-017) stored `pageContent` as both. v2 adds an
// optional `searchText` field: when present, BM25 scores against it; the
// original `pageContent` is what the caller sees. v2 indexes are readable
// by v1 readers as long as they fall back to `pageContent` for BM25,
// which the v1 query path did anyway — so the format change is backwards
// compatible at the JSON level. The version bump is purely advisory.
const SCHEMA_VERSION = 2;
const SCHEMA_VERSIONS_READABLE = [1, 2] as const;

interface SerializedDocument {
  pageContent: string;
  metadata: Record<string, unknown>;
  /**
   * RFC 017 §3 — preface-prepended embedding-input text used for BM25
   * scoring. Absent when contextual retrieval is disabled (`pageContent`
   * is used directly). Never returned to callers — the query path always
   * outputs `pageContent` verbatim.
   */
  searchText?: string;
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

export type LexicalRankingUnit = 'chunk' | 'source';

export interface LexicalQueryOptions {
  /**
   * `chunk` ranks individual chunks and preserves the original debug surface.
   * `source` ranks a whole source file, then returns the best matching chunk
   * from each winning source. The source unit is useful for document-style
   * retrieval and for avoiding duplicate chunks from one file consuming top-k.
   */
  unit?: LexicalRankingUnit;
  /**
   * Candidate chunks to inspect when `unit=source` selects a representative
   * chunk. Defaults to `max(k * 4, k)`.
   */
  candidateK?: number;
}

type ChunkRecordItem = { relPath: string; chunk: SerializedDocument };
type SourceRecordItem = { relPath: string; firstChunk: SerializedDocument };

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
    private chunkRankerCache: LexicalBm25Ranker<ChunkRecordItem> | null = null,
    private sourceRankerCache: LexicalBm25Ranker<SourceRecordItem> | null = null,
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

    const rawVersion = (parsed as { version?: unknown }).version;
    if (!isPlainObject(parsed) || typeof rawVersion !== 'number' || !SCHEMA_VERSIONS_READABLE.includes(rawVersion as 1 | 2)) {
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

      // RFC 017 §3 — split BM25-scoring text from caller-output text. When
      // `metadata.contextual_preface` is present, `embeddingText` returns
      // the preface-prepended form for BM25 to score; otherwise it returns
      // `pageContent`. Only persist `searchText` when it actually differs
      // (no preface present means `searchText === pageContent`, which is
      // wasteful to serialize).
      const serialized: SerializedDocument[] = chunks.map((doc) => {
        const scoring = embeddingText(doc);
        const entry: SerializedDocument = {
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        };
        if (scoring !== doc.pageContent) {
          entry.searchText = scoring;
        }
        return entry;
      });
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
    this.chunkRankerCache = null;
    this.sourceRankerCache = null;
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
   * BM25 top-k over the persisted lexical index. `unit=chunk` ranks each
   * chunk independently. `unit=source` ranks each source file as a document
   * and returns one representative chunk per source, which avoids duplicate
   * chunks wasting the top-k budget for document-shaped retrieval.
   */
  async query(query: string, k: number, options: LexicalQueryOptions = {}): Promise<LexicalSearchResult[]> {
    if (k <= 0 || this.entries.size === 0) return [];
    const unit = options.unit ?? 'chunk';
    return unit === 'source'
      ? this.querySources(query, k, options.candidateK)
      : this.queryChunks(query, k);
  }

  numFiles(): number {
    return this.entries.size;
  }

  numChunks(): number {
    let n = 0;
    for (const entry of this.entries.values()) n += entry.chunks.length;
    return n;
  }

  private queryChunks(query: string, k: number): LexicalSearchResult[] {
    const ranked = this.chunkRanker().query(query, k);
    return ranked.map(({ item, score }) => ({
      pageContent: item.chunk.pageContent,
      metadata: item.chunk.metadata,
      score,
    }));
  }

  private querySources(query: string, k: number, candidateK: number | undefined): LexicalSearchResult[] {
    const rankedSources = this.sourceRanker().query(query, k);
    if (rankedSources.length === 0) return [];

    const chunkCandidateK = Math.max(candidateK ?? k * 4, k, this.numChunks());
    const rankedChunks = this.chunkRanker().query(query, chunkCandidateK);
    const bestChunkByRelPath = new Map<string, SerializedDocument>();
    for (const { item } of rankedChunks) {
      if (!bestChunkByRelPath.has(item.relPath)) {
        bestChunkByRelPath.set(item.relPath, item.chunk);
      }
    }

    return rankedSources.map(({ item, score }) => {
      const chunk = bestChunkByRelPath.get(item.relPath) ?? item.firstChunk;
      return {
        pageContent: chunk.pageContent,
        metadata: {
          ...chunk.metadata,
          lexicalRankingUnit: 'source',
          lexicalSourceScore: score,
        },
        score,
      };
    });
  }

  private chunkRanker(): LexicalBm25Ranker<ChunkRecordItem> {
    this.chunkRankerCache ??= LexicalBm25Ranker.fromRecords(this.chunkRecords());
    return this.chunkRankerCache;
  }

  private sourceRanker(): LexicalBm25Ranker<SourceRecordItem> {
    this.sourceRankerCache ??= LexicalBm25Ranker.fromRecords(this.sourceRecords());
    return this.sourceRankerCache;
  }

  private chunkRecords(): Array<LexicalBm25Record<ChunkRecordItem>> {
    const records: Array<LexicalBm25Record<ChunkRecordItem>> = [];
    for (const [relPath, entry] of this.entries) {
      for (const chunk of entry.chunks) {
        records.push({
          item: { relPath, chunk },
          title: titleFromMetadata(chunk.metadata) ?? path.basename(relPath, path.extname(relPath)),
          text: chunk.searchText ?? chunk.pageContent,
        });
      }
    }
    return records;
  }

  private sourceRecords(): Array<LexicalBm25Record<SourceRecordItem>> {
    const records: Array<LexicalBm25Record<SourceRecordItem>> = [];
    for (const [relPath, entry] of this.entries) {
      const firstChunk = entry.chunks[0];
      if (firstChunk === undefined) continue;
      records.push({
        item: { relPath, firstChunk },
        title: titleFromMetadata(firstChunk.metadata) ?? path.basename(relPath, path.extname(relPath)),
        text: entry.chunks.map((chunk) => chunk.searchText ?? chunk.pageContent).join('\n\n'),
      });
    }
    return records;
  }
}

function titleFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const frontmatter = metadata.frontmatter;
  if (!isPlainObject(frontmatter)) return undefined;
  const title = frontmatter.title;
  return typeof title === 'string' && title.trim() !== '' ? title : undefined;
}
