// FaissIndexManager.ts — RFC 013 M1+M2 (multi-model layout).
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { Document } from "@langchain/core/documents";
import { emitCanonicalLog, type CanonicalProcess } from './canonical-log.js';
import { createEmbeddingsClient, type EmbeddingsClient } from './embedding-provider.js';
import { handleFsOperationError, toError } from './error-utils.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import {
  buildChunkManifest,
  buildChunkDocuments,
  countStableChunkPrefix,
  readChunkManifest,
  type ChunkManifest,
  normalizeChunkTextForEmbedding,
  writeChunkManifests,
  writeSidecarHashes,
} from './file-ingest.js';
import { loadFile } from './loaders.js';
import {
  FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  resolveRefreshQuiesceMs,
} from './config/ingest.js';
import {
  backendForIndexType,
  resolveHnswIndexConfig,
  resolveIndexType,
  resolveIndexingBatchSize,
  resolveIndexingConcurrency,
  type HnswIndexConfig,
  type IndexBackend,
  type SearchIndexType,
} from './config/indexing.js';
import { casRootForIndexPath } from './docstore-cas.js';
import {
  activeFileExists,
  computeLegacyEnvModelSpec,
  modelDir,
  modelNameFilePath,
  writeIndexTypeAtomic,
} from './active-model.js';
import { deriveModelId, EmbeddingProvider } from './model-id.js';
import { logger } from './logger.js';
import { KBError } from './errors.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import {
  __resetBootstrapForTests as resetBootstrapLayoutForTests,
  bootstrapLayout as bootstrapIndexLayout,
} from './layout-bootstrap.js';
import { mapBounded, resolveFsConcurrency } from './bounded-concurrency.js';
import {
  createEmbeddingCanaryFingerprint,
  loadHnswIndexAtomic,
  loadFaissStoreAtomic,
  loadFaissStoreFromVersionDir,
  readIndexIntegrityManifest,
  resolveActiveIndexFilePath as resolveActiveIndexFilePathFromLayout,
  saveHnswIndexAtomic,
  saveFaissStoreAtomic,
} from './faiss-store-layout.js';
import {
  freshnessManifestPath,
  readFreshnessManifest,
  writeFreshnessManifest,
} from './freshness-manifest.js';
import {
  clearPendingSidecarCommitManifest,
  readPendingSidecarCommitManifest,
  writePendingSidecarCommitManifest,
} from './pending-sidecar-commit.js';
import {
  createSimilaritySearchPostFilter,
  type ScoredDocument,
  type SimilaritySearchFilters,
} from './search-filters.js';
import {
  buildChunkCitation,
  parseChunkReference,
  type ChunkReference,
} from './chunk-id.js';
import {
  METADATA_SIDECAR_FILENAME,
  buildSidecarRowFromDocument,
  deleteMetadataSidecar,
  isSidecarStale,
  readMetadataSidecar,
  recommendFastPathFetchK,
  toSidecarFilter,
  writeMetadataSidecar,
  type MetadataSidecar,
  type MetadataSidecarRow,
} from './metadata-sidecar.js';
import { queryEmbeddingCache, type QueryCacheLookupStatus, type QueryCacheTelemetry } from './query-cache.js';
import { withSidecarLock } from './write-lock.js';
import { FaissStoreAdapter, type EmbeddedDocumentsBatch } from './faiss-store-adapter.js';
import { HnswIndexAdapter } from './hnsw-index-adapter.js';
import type { SearchIndexAdapter } from './search-index-adapter.js';
import {
  recordIngestFailure,
  recordIngestSuccess,
  shouldRetryIngest,
} from './ingest-quarantine.js';
import { IngestSecretDetectedError } from './secret-scanner.js';
import {
  collapseRetrievalViewResults,
  isRetrievalViewDocument,
  shouldKeepForRetrievalViews,
  type RetrievalViewKind,
} from './retrieval-views.js';

export { MigrationRefusedError } from './layout-bootstrap.js';

/**
 * RFC 013 §4.7 — atomic write for `model_name.txt`. Per-model file:
 * `${PATH}/models/<id>/model_name.txt`. Tmp+rename is atomic on POSIX.
 */
async function writeModelNameAtomic(modelNameFile: string, modelName: string): Promise<void> {
  const tmp = `${modelNameFile}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, modelName, 'utf-8');
  await fsp.rename(tmp, modelNameFile);
}

function canonicalProcessFromArgv(): CanonicalProcess {
  return process.argv.some((entry) => /(?:^|[/\\])cli\.(?:js|ts|mjs)$/.test(entry)) ? 'cli' : 'mcp';
}

// ---------------------------------------------------------------------------
// RFC 014 — atomic FAISS save via versioned dirs + symlink swap.
//
// Layout (per model):
//   ${modelDir}/index               → symlink to index.vN
//   ${modelDir}/index.vN/{faiss.index, docstore.json}   (current)
//   ${modelDir}/index.vN-1/...      (kept for GC slack)
//   ${modelDir}/index.vN-2/...      (kept for GC slack)
//   ${modelDir}/faiss.index/        (legacy, untouched on upgrade)
//
// Save path: write into ${modelDir}/index.v(N+1) → atomic symlink swap
// (rename(2) of a symlink is atomic on POSIX) → GC versions older than N=3.
//
// Read path: lstat the symlink (NOT pathExists which follows symlinks);
// realpath ONCE at the caller; pass the resolved absolute path to
// FaissStore.load. Eliminates the F1 docid-mismatch race that arises
// because @langchain/community's FaissStore.load does Promise.all of two
// independent open(2) calls — each would re-resolve a symlink given the
// path, but an absolute resolved path has no symlink to re-resolve.
// ---------------------------------------------------------------------------

export const DEFAULT_REBUILD_PROGRESS_INTERVAL_FILES = 10;

/**
 * Issue #229 — progressive overfetch sequence for filtered similarity search.
 *
 * The langchain FaissStore wrapper silently drops filter arguments (see PR #73
 * + #53), so KB scope, extension, path-glob, and tag filters all run as
 * post-filters after FAISS returns. Pre-#229 the manager defended against
 * filter starvation by fetching `ntotal` whenever any filter was active — a
 * full-index pass on every scoped query, even when the first 20 hits already
 * satisfied the request.
 *
 * Progressive overfetch swaps the single full pass for a short ladder of
 * increasing windows. The caller iterates `fetchK` values in order, applies
 * the post-filter after each FAISS call, and stops once at least `k` filtered
 * hits exist or FAISS has returned the whole docstore. Worst case still ends
 * at `ntotal` and preserves the #71/#73 correctness guarantee; the common
 * case terminates at the first or second rung.
 *
 * Ladder = `[max(k, 20), 4k, 16k, ntotal]` with duplicates and rungs that
 * meet or exceed `ntotal` collapsed. The floor of 20 keeps very small `k`
 * callers (e.g. `k = 1`) from probing FAISS one item at a time when a single
 * filter would otherwise reject the top hit. The geometric 4× growth caps
 * the number of attempts at four for any realistic `ntotal`.
 */
export function progressiveFetchSizes(k: number, ntotal: number): number[] {
  if (ntotal <= 0) return [];
  const sizes: number[] = [];
  const candidates = [Math.max(k, 20), k * 4, k * 16];
  let prev = 0;
  for (const candidate of candidates) {
    if (candidate <= prev) continue;
    if (candidate >= ntotal) break;
    sizes.push(candidate);
    prev = candidate;
  }
  sizes.push(ntotal);
  return sizes;
}

class IndexingEmbeddingDeduper implements EmbeddingsInterface {
  private readonly vectorsByNormalizedText = new Map<string, number[]>();

  constructor(private readonly delegate: EmbeddingsInterface) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const normalizedTexts = texts.map(normalizeChunkTextForEmbedding);
    const missingTexts: string[] = [];
    const missingSet = new Set<string>();

    for (const normalizedText of normalizedTexts) {
      if (
        !this.vectorsByNormalizedText.has(normalizedText) &&
        !missingSet.has(normalizedText)
      ) {
        missingSet.add(normalizedText);
        missingTexts.push(normalizedText);
      }
    }

    if (missingTexts.length > 0) {
      const vectors = await this.delegate.embedDocuments(missingTexts);
      if (vectors.length !== missingTexts.length) {
        throw new Error(
          `Embedding provider returned ${vectors.length} vector(s) for ${missingTexts.length} document(s)`,
        );
      }
      for (let i = 0; i < missingTexts.length; i += 1) {
        this.vectorsByNormalizedText.set(missingTexts[i], vectors[i]);
      }
    }

    return normalizedTexts.map((normalizedText) => {
      const vector = this.vectorsByNormalizedText.get(normalizedText);
      if (vector === undefined) {
        throw new Error('Missing cached vector for normalized chunk text');
      }
      return vector;
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.delegate.embedQuery(text);
  }
}

function totalFileCount(
  entries: ReadonlyArray<{ filePaths: readonly string[] }>,
): number {
  return entries.reduce((sum, entry) => sum + entry.filePaths.length, 0);
}

export interface FaissIndexManagerOptions {
  provider: EmbeddingProvider;
  modelName: string;
  indexType?: SearchIndexType;
}

export interface IndexUpdateProgress {
  processedFiles: number;
  totalFiles: number;
  currentFile: string;
  modelId: string;
  phase?: 'scan' | 'load' | 'embed' | 'save' | 'sidecar' | 'manifest';
  phaseStatus?: 'started' | 'progress' | 'completed';
  filesScanned?: number;
  filesChanged?: number;
  filesSkipped?: number;
  chunksDiscovered?: number;
  processedChunks?: number;
  totalChunks?: number;
  batchIndex?: number;
  batchCount?: number;
  batchSize?: number;
  provider?: EmbeddingProvider;
  modelName?: string;
  elapsedMs?: number;
  phaseElapsedMs?: number;
  throughputChunksPerSecond?: number;
  saved?: boolean;
  sidecarsWritten?: number;
}

export interface UpdateIndexOptions {
  onProgress?: (progress: IndexUpdateProgress) => void | Promise<void>;
  progressIntervalFiles?: number;
  force?: boolean;
}

export interface InitializeOptions {
  readOnly?: boolean;
  strictReadOnly?: boolean;
}

export type IndexUpdateSummaryStatus = 'success' | 'partial' | 'failed' | 'never_run';

export interface IndexUpdateFailureSummary {
  relative_path: string | null;
  phase: 'enumeration' | 'load' | 'indexing' | 'save' | 'sidecar' | 'unknown';
  code: string | null;
  message: string;
}

export type IndexUpdateWarningCode =
  | 'KB_REFRESH_NOT_QUIESCENT'
  | 'KB_REFRESH_FILE_CHANGED_DURING_SCAN';

export interface IndexUpdateWarningSummary {
  relative_path: string | null;
  code: IndexUpdateWarningCode;
  message: string;
  mtime_age_ms?: number;
  quiesce_ms?: number;
}

export interface IndexUpdateSummary {
  status: IndexUpdateSummaryStatus;
  scope: 'global' | string | null;
  model_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  files_scanned: number;
  files_changed: number;
  files_unchanged: number;
  files_skipped: number;
  chunks_attempted: number;
  chunks_added: number;
  index_mutated: boolean;
  saved: boolean;
  sidecars_written: boolean;
  warning_count: number;
  warnings: IndexUpdateWarningSummary[];
  failure_count: number;
  failures: IndexUpdateFailureSummary[];
}

export interface SimilaritySearchTiming {
  embed_query_ms?: number;
  faiss_search_ms?: number;
  query_search_ms?: number;
  post_filter_ms?: number;
  post_filter_kept?: number;
  total_ms?: number;
  fetch_k?: number;
  query_cache?: QueryCacheLookupStatus | 'unavailable';
  query_cache_telemetry?: QueryCacheTelemetry;
  /**
   * Issue #283 — outcome of the metadata-sidecar predicate-pushdown
   * fast-path. `unused` means the active filter did not benefit from the
   * sidecar; `missing`/`stale` mean the sidecar did not exist or did not
   * match `ntotal` (post-filter ladder ran). `hit` means the fast-path
   * served the query without falling back. `miss_underflow` means we
   * tried the fast-path but the targeted fetchK did not yield enough
   * filtered hits and we fell through to the ladder.
   */
  sidecar_fast_path?: 'hit' | 'unused' | 'missing' | 'stale' | 'miss_underflow' | 'short_circuit';
  sidecar_candidates?: number;
}

export const MAX_NEIGHBOR_CONTEXT_WINDOW = 5;
export const MAX_NEIGHBOR_CONTEXT_CHUNKS = 50;

export interface NeighborContextOptions {
  before?: number;
  after?: number;
  maxContextChunks?: number;
}

export interface NeighborContextChunk extends Document {
  matchType: 'context';
  semanticMatch: false;
  contextDirection: 'before' | 'after';
  contextDistance: number;
}

export interface SearchResultDocument extends Document {
  score: number;
  matchType?: 'semantic';
  semanticMatch?: true;
  contextChunks?: NeighborContextChunk[];
  contextTruncated?: boolean;
}

export interface SimilaritySearchOptions {
  noCache?: boolean;
  retrievalViews?: RetrievalViewKind[];
}

const MAX_INDEX_UPDATE_FAILURES = 10;
const LAST_INDEX_UPDATE_SUMMARY_FILE = 'last-index-update.json';
const LAST_INDEX_UPDATE_SUMMARY_SCHEMA_VERSION = 'kb.last-index-update.v1';

export function createNeverRunIndexUpdateSummary(modelId: string | null = null): IndexUpdateSummary {
  return {
    status: 'never_run',
    scope: null,
    model_id: modelId,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    files_scanned: 0,
    files_changed: 0,
    files_unchanged: 0,
    files_skipped: 0,
    chunks_attempted: 0,
    chunks_added: 0,
    index_mutated: false,
    saved: false,
    sidecars_written: false,
    warning_count: 0,
    warnings: [],
    failure_count: 0,
    failures: [],
  };
}

function cloneIndexUpdateSummary(summary: IndexUpdateSummary): IndexUpdateSummary {
  return {
    ...summary,
    warning_count: summary.warning_count ?? 0,
    warnings: (summary.warnings ?? []).map((warning) => ({ ...warning })),
    failures: summary.failures.map((failure) => ({ ...failure })),
  };
}

function failureSummary(
  relativePath: string | null,
  phase: IndexUpdateFailureSummary['phase'],
  error: unknown,
): IndexUpdateFailureSummary {
  const err = toError(error);
  const fsError = error as NodeJS.ErrnoException | undefined;
  const code = fsError?.code;
  return {
    relative_path: relativePath,
    phase,
    code: typeof code === 'string' ? code : null,
    message: sanitizeFailureMessage(err.message, relativePath, fsError?.path),
  };
}

function sanitizeFailureMessage(
  message: string,
  relativePath: string | null,
  rawPath: string | undefined,
): string {
  if (!rawPath || !path.isAbsolute(rawPath)) {
    return message;
  }
  const replacement = relativePath ?? '<path>';
  return message.split(rawPath).join(replacement);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseSummaryStatus(value: unknown): IndexUpdateSummaryStatus | null {
  if (
    value === 'success' ||
    value === 'partial' ||
    value === 'failed' ||
    value === 'never_run'
  ) {
    return value;
  }
  return null;
}

function parseFailurePhase(value: unknown): IndexUpdateFailureSummary['phase'] {
  if (
    value === 'load' ||
    value === 'enumeration' ||
    value === 'indexing' ||
    value === 'save' ||
    value === 'sidecar' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function parsePersistedIndexUpdateSummary(value: unknown): IndexUpdateSummary | null {
  const candidate = isRecord(value) && isRecord(value.summary)
    ? value.summary
    : value;
  if (!isRecord(candidate)) return null;

  const status = parseSummaryStatus(candidate.status);
  if (status === null) return null;

  const modelId = stringOrNull(candidate.model_id);
  const base = createNeverRunIndexUpdateSummary(modelId);
  const failures = Array.isArray(candidate.failures)
    ? candidate.failures
        .filter(isRecord)
        .slice(0, MAX_INDEX_UPDATE_FAILURES)
        .map((failure): IndexUpdateFailureSummary => ({
          relative_path: stringOrNull(failure.relative_path),
          phase: parseFailurePhase(failure.phase),
          code: stringOrNull(failure.code),
          message: typeof failure.message === 'string' ? failure.message : '',
        }))
    : [];
  const warnings = Array.isArray(candidate.warnings)
    ? candidate.warnings
        .filter(isRecord)
        .map((warning): IndexUpdateWarningSummary | null => {
          const code = warning.code;
          if (
            code !== 'KB_REFRESH_NOT_QUIESCENT' &&
            code !== 'KB_REFRESH_FILE_CHANGED_DURING_SCAN'
          ) {
            return null;
          }
          const parsed: IndexUpdateWarningSummary = {
            relative_path: stringOrNull(warning.relative_path),
            code,
            message: typeof warning.message === 'string' ? warning.message : '',
          };
          const mtimeAgeMs = numberOrNull(warning.mtime_age_ms);
          const quiesceMs = numberOrNull(warning.quiesce_ms);
          if (mtimeAgeMs !== null) parsed.mtime_age_ms = mtimeAgeMs;
          if (quiesceMs !== null) parsed.quiesce_ms = quiesceMs;
          return parsed;
        })
        .filter((warning): warning is IndexUpdateWarningSummary => warning !== null)
    : [];

  return {
    ...base,
    status,
    scope: stringOrNull(candidate.scope),
    started_at: stringOrNull(candidate.started_at),
    finished_at: stringOrNull(candidate.finished_at),
    duration_ms: numberOrNull(candidate.duration_ms),
    files_scanned: numberOrDefault(candidate.files_scanned, base.files_scanned),
    files_changed: numberOrDefault(candidate.files_changed, base.files_changed),
    files_unchanged: numberOrDefault(candidate.files_unchanged, base.files_unchanged),
    files_skipped: numberOrDefault(candidate.files_skipped, base.files_skipped),
    chunks_attempted: numberOrDefault(candidate.chunks_attempted, base.chunks_attempted),
    chunks_added: numberOrDefault(candidate.chunks_added, base.chunks_added),
    index_mutated: booleanOrDefault(candidate.index_mutated, base.index_mutated),
    saved: booleanOrDefault(candidate.saved, base.saved),
    sidecars_written: booleanOrDefault(candidate.sidecars_written, base.sidecars_written),
    warning_count: numberOrDefault(candidate.warning_count, warnings.length),
    warnings,
    failure_count: numberOrDefault(candidate.failure_count, failures.length),
    failures,
  };
}

export class FaissIndexManager {
  private faissIndex: SearchIndexAdapter | null = null;
  // Issue #59 — populated by initialize() via dynamic import of the active
  // provider's @langchain module. Definite-assignment-asserted because the
  // class invariant is "every method that touches embeddings runs after
  // initialize()", which holds for every call site (KnowledgeBaseServer,
  // cli.ts, every test that exercises retrieval).
  private embeddings!: EmbeddingsClient;
  // RFC 014 — monotonic counter for unique tmp-symlink names within this
  // process. Incremented on every atomicSave; combined with PID it guarantees
  // no collision between concurrent saves on the same modelDir (which the
  // per-model write lock already prevents, but the counter is cheap).
  private swapCounter = 0;
  readonly modelName: string;
  readonly embeddingProvider: EmbeddingProvider;
  readonly modelId: string;
  readonly modelDir: string;
  readonly modelNameFile: string;
  private readonly indexingBatchSize: number;
  private readonly indexingConcurrency: number;
  private readonly indexType: SearchIndexType;
  private readonly indexBackend: IndexBackend;
  private readonly hnswConfig: HnswIndexConfig | null;
  private lastIndexUpdateSummary: IndexUpdateSummary;
  // Issue #283 — cached metadata sidecar so we don't re-parse the JSONL
  // file on every query. Invalidated whenever updateIndex rewrites it,
  // and re-checked for staleness on every search via `isSidecarStale`.
  private metadataSidecarCache: { sidecar: MetadataSidecar; loadedAt: number } | null = null;
  private metadataSidecarMissingLogged = false;
  private metadataSidecarAllowedForLoadedStore = true;

  /**
   * RFC 013 §4.9 file table — preferred form: `new FaissIndexManager({provider, modelName})`
   * (round-1 boundary F2 — explicit construction lets the manager instantiate
   * the right embeddings client for any model). Path is derived inside the
   * manager, scoped to `${PATH}/models/<id>/`.
   *
   * Legacy form: `new FaissIndexManager()` resolves provider+model from env
   * (`EMBEDDING_PROVIDER` + `OLLAMA_MODEL`/`OPENAI_MODEL_NAME`/`HUGGINGFACE_MODEL_NAME`).
   * Preserved for backward compatibility with 0.2.x callers and existing tests
   * that pre-set env. New multi-model code paths (`kb models add`, MCP per-call
   * model selection) use the explicit form.
   */
  constructor(opts?: FaissIndexManagerOptions) {
    const resolved = opts !== undefined
      ? {
          provider: opts.provider,
          modelName: opts.modelName,
          modelId: deriveModelId(opts.provider, opts.modelName),
        }
      : computeLegacyEnvModelSpec();
    this.embeddingProvider = resolved.provider;
    this.modelName = resolved.modelName;
    this.modelId = resolved.modelId;
    this.modelDir = modelDir(this.modelId);
    this.modelNameFile = modelNameFilePath(this.modelId);
    this.indexingBatchSize = resolveIndexingBatchSize(this.embeddingProvider);
    this.indexingConcurrency = resolveIndexingConcurrency(this.embeddingProvider);
    this.indexType = opts?.indexType ?? resolveIndexType();
    this.indexBackend = backendForIndexType(this.indexType);
    this.hnswConfig = this.indexType === 'hnsw' ? resolveHnswIndexConfig() : null;
    this.lastIndexUpdateSummary = createNeverRunIndexUpdateSummary(this.modelId);

    // Issue #59 — embeddings are constructed lazily inside initialize() so
    // the unused providers' @langchain modules never load. API-key validation
    // moves with them; the throw still fires before any disk work.

    logger.info(
      `FaissIndexManager bound to ${this.modelDir} (provider=${this.embeddingProvider}, ` +
        `model=${this.modelName}, id=${this.modelId}, index=${this.indexType})`,
    );
  }

  get hasLoadedIndex(): boolean {
    return this.faissIndex !== null;
  }

  getLastIndexUpdateSummary(): IndexUpdateSummary {
    return cloneIndexUpdateSummary(this.lastIndexUpdateSummary);
  }

  static async readPersistedIndexUpdateSummary(
    modelId: string | null,
  ): Promise<IndexUpdateSummary | null> {
    if (modelId === null) return null;
    const summaryPath = path.join(modelDir(modelId), LAST_INDEX_UPDATE_SUMMARY_FILE);
    let raw: string;
    try {
      raw = await fsp.readFile(summaryPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      logger.warn(
        `Could not read persisted index update summary for ${modelId}: ${toError(err).message}`,
      );
      return null;
    }

    try {
      return parsePersistedIndexUpdateSummary(JSON.parse(raw));
    } catch (err) {
      logger.warn(
        `Ignoring malformed persisted index update summary for ${modelId}: ${toError(err).message}`,
      );
      return null;
    }
  }

  private async persistIndexUpdateSummary(summary: IndexUpdateSummary): Promise<void> {
    await fsp.mkdir(this.modelDir, { recursive: true });
    const summaryPath = path.join(this.modelDir, LAST_INDEX_UPDATE_SUMMARY_FILE);
    const tmpPath = path.join(
      this.modelDir,
      `.${LAST_INDEX_UPDATE_SUMMARY_FILE}.${process.pid}.${process.hrtime.bigint()}.tmp`,
    );
    const payload = {
      schema_version: LAST_INDEX_UPDATE_SUMMARY_SCHEMA_VERSION,
      summary: cloneIndexUpdateSummary(summary),
    };
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
      await fsp.rename(tmpPath, summaryPath);
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** RFC 013 §4.8 — process-global, idempotent layout bootstrap. */
  static async bootstrapLayout(): Promise<void> {
    await bootstrapIndexLayout();
  }

  /* @internal */
  /** Test-only: reset the bootstrap cache between tests. */
  static __resetBootstrapForTests(): void {
    resetBootstrapLayoutForTests();
  }

  /**
   * RFC 013 §4.8 — per-instance, load-only. NO migration (that's bootstrapLayout).
   * NO cross-process advisory. Cheap, called per `kb search` and per MCP
   * `handleRetrieveKnowledge`.
   *
   * RFC 012 §4.5 — `readOnly: true` skips the `model_name.txt` write so a CLI
   * can load the index without contending with a running MCP server.
   *
   * `strictReadOnly: true` is for audit commands that must not create or
   * repair index layout. It implies readOnly behavior, refuses a missing model
   * directory, and leaves corrupt index paths untouched.
   */
  async initialize(opts: InitializeOptions = {}): Promise<void> {
    try {
      const readOnly = opts.readOnly === true || opts.strictReadOnly === true;
      // Issue #59 — lazy provider import. Idempotent: a second initialize()
      // (e.g. tests that re-call after corrupt-recovery) reuses the existing
      // embeddings client. Throws here on missing API keys, matching the
      // pre-#59 constructor's error shape.
      if (!this.embeddings) {
        this.embeddings = await createEmbeddingsClient({
          provider: this.embeddingProvider,
          modelName: this.modelName,
          // Issue #210 — wrap the active provider with the runtime
          // telemetry collector. Keyed by `modelId` so each
          // (provider, model_name) gets its own histogram, matching
          // the `kb_stats.provider_calls` payload shape.
          modelId: this.modelId,
        });
      }
      // Ensure this model's directory exists. mkdir-p is cheap; first-run
      // for a fresh install creates `${PATH}/models/<id>/`.
      if (!(await pathExists(this.modelDir))) {
        if (opts.strictReadOnly === true) {
          throw new Error(
            `FAISS model directory missing for "${this.modelId}"; ` +
              `read-only load will not create ${this.modelDir}`,
          );
        }
        try {
          await fsp.mkdir(this.modelDir, { recursive: true });
        } catch (error) {
          handleFsOperationError('create FAISS model directory', this.modelDir, error);
        }
      }
      if (!readOnly) {
        await this.recoverPendingSidecarCommit();
      }
      // RFC 013: no model-switch wipe at initialize time. Each model has its
      // own dir; a different provider+model goes to a different `models/<id>/`.
      // RFC 014: load via the new versioned layout if present, fall back to
      // the legacy faiss.index/ directory otherwise. loadAtomic handles its
      // own corruption recovery — only the FAILED layout is removed, never
      // the other one (preserves legacy as rollback safety even when the
      // versioned layout is corrupt, and vice versa).
      this.faissIndex = await this.loadAtomic({
        repairCorrupt: opts.strictReadOnly !== true,
      });
      this.metadataSidecarAllowedForLoadedStore = true;
      this.metadataSidecarCache = null;
      this.metadataSidecarMissingLogged = false;

      // Issue #90 — sidecar invalidation when this model's FAISS store is gone.
      //
      // Per-KB hash sidecars at `<kb>/.index/<file>` cache the SHA256 of the
      // last embedded version. updateIndex skips re-embedding when the
      // current file hash matches the sidecar hash. If the FAISS store for
      // this model has been removed but sidecars survive (manual rm of
      // $FAISS_INDEX_PATH, the workaround for #85, partial backup restore,
      // or a crash mid-rebuild), every file with a matching sidecar is
      // skipped silently — vectors are gone but the cache says "indexed".
      // retrieve_knowledge then returns nothing.
      //
      // The existing fallback rebuild branch in updateIndex only fires when
      // `this.faissIndex === null` AT THAT MOMENT. Once one KB has been
      // re-indexed (faissIndex !== null) every later updateIndex(otherKb)
      // trusts its sidecars and skips silently — exactly the partial-drift
      // case the reporter hit.
      //
      // Fix: at initialize, if this model's store is missing, treat any
      // pre-existing sidecars as untrustworthy and purge them. The next
      // updateIndex sees no sidecars and re-embeds every file from scratch.
      //
      // Multi-model trade-off: when a second model is registered and its
      // store doesn't exist yet, this purges sidecars that were valid for
      // the existing model. The other model's vectors stay intact (its
      // store isn't touched), so `retrieve_knowledge` against it still
      // returns results; the next `updateIndex` against it re-embeds every
      // file once. A single source of truth (RFC 013 option 3 — hash
      // inside docstore.json metadata) eliminates the trade-off; the
      // lighter purge is preferable to silent empty results until then.
      //
      // Skipped under readOnly:true (no mutation allowed in that mode).
      if (this.faissIndex === null && !readOnly) {
        await this.purgeStaleSidecars('store_missing');
      }

      // Save the current model name for this model's dir. Skipped under
      // readOnly:true (RFC 012 §4.5).
      if (!readOnly) {
        try {
          await writeModelNameAtomic(this.modelNameFile, this.modelName);
          await writeIndexTypeAtomic(this.modelId, this.indexType);
        } catch (error) {
          handleFsOperationError('persist embedding model metadata in', this.modelNameFile, error);
        }
      }
    } catch (error: unknown) {
      const err = toError(error) as Error & { __alreadyLogged?: boolean };
      if (!err.__alreadyLogged) {
        logger.error('Error initializing FAISS index:', err);
        if (err.stack) {
          logger.error(err.stack);
        }
      }
      throw err;
    }
  }

  /**
   * Issue #90 — purge per-KB hash sidecars at every KB under
   * KNOWLEDGE_BASES_ROOT_DIR. Called from initialize when this model's
   * FAISS store is missing on disk; the sidecars would otherwise mask the
   * gone-vectors and cause silently-empty retrievals.
   *
   * Best-effort per KB: a single KB's permission error is logged and
   * skipped, never propagated — the alternative (failing startup over a
   * stale-cache cleanup) is worse than carrying one stale KB into the
   * next updateIndex, which will at worst log a similar error itself.
   *
   * Concurrency: holds `withSidecarLock` so a concurrent `updateIndex`
   * sidecar write batch (per-model lock only) can't race the rmrf and
   * see ENOENT mid-rename. (Codex review P1.)
   *
   * Symlink containment: each KB entry is `lstat`-checked; symlinked KB
   * entries are skipped with a WARN. `listKnowledgeBases` filters
   * dot-prefixes only, so an unfiltered symlink could resolve outside
   * `KNOWLEDGE_BASES_ROOT_DIR` and a recursive rm would then delete an
   * external `.index/` directory. (Codex review P2.) The user-visible
   * cost is that a symlinked KB doesn't get auto-recovery from the #90
   * silent-empty-results bug; the documented manual workaround
   * (`find ~/knowledge_bases -type d -name .index -exec rm -rf {} +`)
   * still works for those KBs since `find` does not follow symlinks
   * by default.
   */
  private async purgeStaleSidecars(
    reason: 'store_missing' | 'ingest_filter_changed' | 'pending_sidecar_commit',
  ): Promise<void> {
    await withSidecarLock(() => this.purgeStaleSidecarsLocked(reason));
  }

  private async purgeStaleSidecarsLocked(
    reason: 'store_missing' | 'ingest_filter_changed' | 'pending_sidecar_commit',
  ): Promise<void> {
    let kbs: string[];
    try {
      kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      logger.warn(
        `Issue #90 sidecar purge: could not list KBs at ${KNOWLEDGE_BASES_ROOT_DIR}: ${(err as Error).message}`,
      );
      return;
    }

    const purged: string[] = [];
    const skippedSymlinks: string[] = [];
    for (const kb of kbs) {
      const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, kb);

      // Codex review P2 — reject symlinked KB entries before recursive rm.
      // lstat (NOT stat) so we observe the symlink itself, not its target.
      let kbStat: Awaited<ReturnType<typeof fsp.lstat>>;
      try {
        kbStat = await fsp.lstat(kbPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        logger.warn(
          `Issue #90 sidecar purge: lstat failed for ${kbPath}: ${(err as Error).message}`,
        );
        continue;
      }
      if (kbStat.isSymbolicLink()) {
        skippedSymlinks.push(kb);
        continue;
      }
      if (!kbStat.isDirectory()) continue;

      const indexDir = path.join(kbPath, '.index');
      if (!(await pathExists(indexDir))) continue;
      try {
        await fsp.rm(indexDir, { recursive: true, force: true });
        purged.push(kb);
      } catch (err) {
        logger.warn(
          `Issue #90 sidecar purge: failed to remove ${indexDir}: ${(err as Error).message}`,
        );
      }
    }

    if (purged.length > 0 && reason === 'store_missing') {
      logger.warn(
        `Issue #90: FAISS store for model ${this.modelId} not found on disk but ` +
          `per-KB hash sidecars existed. Purged stale sidecars for ${purged.length} ` +
          `knowledge base(s) [${purged.join(', ')}] so the next updateIndex re-embeds. ` +
          `Common causes: manual removal of $FAISS_INDEX_PATH, partial backup restore, ` +
          `crash mid-rebuild, or model switch with the prior model's store moved aside.`,
      );
    } else if (purged.length > 0 && reason === 'pending_sidecar_commit') {
      logger.warn(
        `Pending sidecar commit recovery for model ${this.modelId} purged stale ` +
          `sidecars for ${purged.length} knowledge base(s) [${purged.join(', ')}] ` +
          `because the previous process crashed before the FAISS save outcome was confirmed.`,
      );
    } else if (purged.length > 0) {
      logger.warn(
        `Ingest filter for model ${this.modelId} changed since the last successful index ` +
          `save. Purged stale sidecars for ${purged.length} knowledge base(s) ` +
          `[${purged.join(', ')}] so the next updateIndex rebuilds only currently ` +
          `ingestable files.`,
      );
    }
    // Issue #283 — drop the metadata sidecar too; it indexes the same
    // (now absent) docstore and would otherwise return stale candidate
    // ids to the predicate-pushdown fast-path.
    await deleteMetadataSidecar(this.metadataSidecarPath());
    this.metadataSidecarCache = null;
    this.metadataSidecarMissingLogged = false;
    if (skippedSymlinks.length > 0) {
      logger.warn(
        `Issue #90 sidecar purge: skipped ${skippedSymlinks.length} symlinked KB entry(ies) ` +
          `[${skippedSymlinks.join(', ')}] to avoid path-escape rmrf via $KNOWLEDGE_BASES_ROOT_DIR. ` +
          `If those KBs need their sidecars cleared, run \`find <kb-target> -type d -name .index -exec rm -rf {} +\` manually.`,
      );
    }
  }

  private async purgePersistedIndexStore(
    reason: 'force_reindex' | 'ingest_filter_changed' | 'pending_sidecar_commit',
  ): Promise<void> {
    const removed: string[] = [];
    let entries: Array<{ name: string }>;
    try {
      entries = await fsp.readdir(this.modelDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      logger.warn(
        `Could not list persisted index store for ${this.modelId} at ${this.modelDir}: ` +
          `${(err as Error).message}`,
      );
      return;
    }

    for (const entry of entries) {
      if (
        entry.name !== 'index' &&
        entry.name !== 'faiss.index' &&
        !/^index\.v\d+$/.test(entry.name)
      ) {
        continue;
      }
      const target = path.join(this.modelDir, entry.name);
      try {
        await fsp.rm(target, { recursive: true, force: true });
        removed.push(entry.name);
      } catch (err) {
        logger.warn(
          `Could not remove stale persisted index entry ${target}: ${(err as Error).message}`,
        );
      }
    }

    try {
      await fsp.rm(freshnessManifestPath(this.modelDir), { force: true });
    } catch (err) {
      logger.warn(
        `Could not remove stale freshness manifest for ${this.modelId}: ${(err as Error).message}`,
      );
    }

    if (removed.length > 0) {
      logger.warn(
        `Removed stale persisted FAISS index for model ${this.modelId} ` +
          `(${reason}; entries=${removed.join(', ')}).`,
      );
    }
  }

  private async recoverPendingSidecarCommit(): Promise<void> {
    const pending = await readPendingSidecarCommitManifest(this.modelDir);
    if (pending === null) return;

    if (pending.phase === 'save-started') {
      logger.warn(
        `Pending sidecar commit for model ${this.modelId} was interrupted before ` +
          `the FAISS save was confirmed. Removing the persisted store and stale ` +
          `sidecars so the next updateIndex rebuilds instead of risking duplicate vectors.`,
      );
      await this.purgePersistedIndexStore('pending_sidecar_commit');
      await this.purgeStaleSidecars('pending_sidecar_commit');
      await clearPendingSidecarCommitManifest(this.modelDir);
      return;
    }

    const activeIndexFilePath = await this.resolveActiveIndexFilePath();
    if (activeIndexFilePath === null) {
      throw new Error(
        `Pending sidecar commit for model ${this.modelId} is marked save-complete, ` +
          `but no active FAISS index file exists under ${this.modelDir}. Refusing ` +
          `to write hash sidecars for vectors that cannot be verified on disk.`,
      );
    }

    logger.warn(
      `Recovering pending sidecar commit for model ${this.modelId}: ` +
        `${pending.pending_hash_writes.length} hash sidecar(s), ` +
        `${pending.pending_chunk_manifest_writes.length} chunk manifest(s).`,
    );
    await writeSidecarHashes(pending.pending_hash_writes);
    await writeChunkManifests(pending.pending_chunk_manifest_writes);
    await clearPendingSidecarCommitManifest(this.modelDir);
  }

  /**
   * Issue #283 — absolute path of this model's predicate-pushdown sidecar.
   * Lives next to `last-index-update.json` and `model_name.txt` under the
   * per-model directory so a model swap can never confuse two sidecars.
   */
  private metadataSidecarPath(): string {
    return path.join(this.modelDir, METADATA_SIDECAR_FILENAME);
  }

  /**
   * Issue #283 — rebuild the sidecar from the current in-memory docstore
   * after a successful index save. Held under `withSidecarLock` so a
   * concurrent `purgeStaleSidecars` cross-model can't rmrf the directory
   * (the sidecar lives under `<modelDir>`, not under `<kb>/.index/`, but
   * the lock keeps both write paths in a single serial domain).
   */
  private async refreshMetadataSidecar(): Promise<void> {
    if (!this.faissIndex) return;
    const entries = this.faissIndex.docstoreEntries();
    const rows: MetadataSidecarRow[] = [];
    for (const [docstoreId, document] of entries) {
      const row = buildSidecarRowFromDocument(docstoreId, document);
      if (row !== null) rows.push(row);
    }
    const sidecarPath = this.metadataSidecarPath();
    await withSidecarLock(() =>
      writeMetadataSidecar({ sidecarPath, modelId: this.modelId, rows }),
    );
    this.metadataSidecarAllowedForLoadedStore = true;
    this.metadataSidecarCache = null;
    this.metadataSidecarMissingLogged = false;
  }

  /**
   * Issue #283 — read-time sidecar accessor. Caches the parsed sidecar
   * for this process and re-validates on every call against the live
   * `ntotal`. Returns null whenever the sidecar is missing, stale, or
   * corrupt — the caller must then fall through to the post-filter
   * ladder for correctness. The first miss in a process logs ONE
   * canonical warn to keep operator logs clean under repeated queries.
   */
  private async loadMetadataSidecar(): Promise<MetadataSidecar | null> {
    if (!this.faissIndex) return null;
    if (!this.metadataSidecarAllowedForLoadedStore) return null;
    const ntotal = this.faissIndex.totalVectors();
    if (this.metadataSidecarCache !== null) {
      if (!isSidecarStale(this.metadataSidecarCache.sidecar, ntotal)) {
        return this.metadataSidecarCache.sidecar;
      }
      this.metadataSidecarCache = null;
    }
    const sidecarPath = this.metadataSidecarPath();
    const sidecar = await readMetadataSidecar({ sidecarPath, modelId: this.modelId });
    if (sidecar === null) {
      if (!this.metadataSidecarMissingLogged) {
        logger.warn(
          `Issue #283 metadata sidecar absent or unreadable for model ${this.modelId}; ` +
            `metadata-filtered queries will use the post-filter overfetch ladder. ` +
            `Run \`npm run build && node build/index.js\` (or any updateIndex) to regenerate.`,
        );
        this.metadataSidecarMissingLogged = true;
      }
      return null;
    }
    if (isSidecarStale(sidecar, ntotal)) {
      logger.warn(
        `Issue #283 metadata sidecar for ${this.modelId} reports ${sidecar.totalChunks} chunks ` +
          `but the live FAISS docstore has ${ntotal}; falling back to post-filter overfetch.`,
      );
      this.metadataSidecarCache = null;
      return null;
    }
    this.metadataSidecarCache = { sidecar, loadedAt: Date.now() };
    this.metadataSidecarMissingLogged = false;
    return sidecar;
  }

  /**
   * Test seam — drops the in-memory sidecar cache so a test that mutates
   * the on-disk JSONL directly (without going through `refreshMetadataSidecar`)
   * sees the new bytes on the next search.
   */
  /** @internal */
  __resetMetadataSidecarCacheForTests(): void {
    this.metadataSidecarCache = null;
    this.metadataSidecarMissingLogged = false;
  }

  /**
   * RFC 014 — load the FAISS store via the new versioned layout when present,
   * fall back to the legacy `faiss.index/` directory otherwise. Returns null
   * if neither layout has any data (fresh install).
   *
   * The reader-side fix for F1 (docid mismatch under concurrent symlink
   * swap): we lstat the symlink (NOT pathExists, which follows symlinks and
   * would silently return false for a dangling symlink), realpath ONCE here,
   * and pass the resolved absolute path to FaissStore.load. FaissStore.load
   * then does its internal Promise.all(open(faiss.index), open(docstore.json))
   * against an absolute path with no symlink in it — both opens hit the same
   * pinned version even if a writer atomically swaps the symlink in between.
   *
   * Side effect: emits a one-time `logger.warn` when both versioned and
   * legacy layouts coexist (the downgrade hazard). The hazard signal is
   * derived directly from on-disk state by `kb models list` and
   * `list_models` (active-model.ts:detectDowngradeHazard), so no marker
   * file is required — the filesystem is the single source of truth.
   */
  private async loadAtomic(opts: { repairCorrupt?: boolean } = {}): Promise<SearchIndexAdapter | null> {
    if (this.indexBackend === 'hnsw') {
      if (this.hnswConfig === null) {
        throw new Error('HNSW index configuration was not initialized');
      }
      return await loadHnswIndexAtomic({
        modelDir: this.modelDir,
        modelId: this.modelId,
        config: this.hnswConfig,
        handleFsOperationError,
        repairCorrupt: opts.repairCorrupt,
      });
    }
    const store = await loadFaissStoreAtomic({
      modelDir: this.modelDir,
      modelId: this.modelId,
      embeddings: this.embeddings,
      handleFsOperationError,
      expectedIndexType: this.indexType === 'sq8' ? 'sq8' : 'flat',
      repairCorrupt: opts.repairCorrupt,
    });
    return store === null ? null : FaissStoreAdapter.fromStore(store);
  }

  /**
   * Reload the last persisted FAISS store into memory, discarding any
   * in-memory additions from a failed updateIndex run. Callers that pair this
   * with a write mutation should already hold this manager's write lock.
   */
  async reloadPersistedIndex(): Promise<void> {
    this.faissIndex = await this.loadAtomic();
    this.metadataSidecarAllowedForLoadedStore = true;
    this.metadataSidecarCache = null;
    this.metadataSidecarMissingLogged = false;
  }

  /**
   * RFC 017 M0c — load a specific `index.vN/` directory directly,
   * bypassing the `index` symlink. Used by `kb eval --compare-index`
   * to evaluate the same fixture against two different versions of the
   * persisted store (typically before/after a contextual-retrieval
   * reindex). The caller passes a directory containing `faiss.index`
   * and `docstore.json`; we replace `this.faissIndex` with an adapter
   * around the loaded store.
   *
   * Read-only — this method does NOT acquire the per-model write lock.
   * It is the caller's responsibility to ensure no concurrent writer is
   * mutating the version dir during the load.
   */
  async loadFromVersionDir(versionDir: string): Promise<void> {
    if (!this.embeddings) {
      throw new Error('FaissIndexManager.loadFromVersionDir requires initialize() first');
    }
    const manifest = await readIndexIntegrityManifest(versionDir);
    if ((manifest?.backend ?? 'faiss') === 'hnsw') {
      if (manifest?.hnsw === undefined) {
        throw new Error(`HNSW version directory ${versionDir} is missing manifest metadata`);
      }
      this.faissIndex = await HnswIndexAdapter.load(
        versionDir,
        this.hnswConfig ?? resolveHnswIndexConfig(),
        manifest.hnsw.dimensions,
      );
      this.metadataSidecarAllowedForLoadedStore = false;
      this.metadataSidecarCache = null;
      this.metadataSidecarMissingLogged = false;
      return;
    }
    const store = await loadFaissStoreFromVersionDir({
      versionDir,
      embeddings: this.embeddings,
    });
    this.faissIndex = FaissStoreAdapter.fromStore(store);
    // Metadata sidecars are keyed to the active model directory, not to an
    // arbitrary historical index.vN directory. Disable the fast-path after a
    // direct version load so scoped diff/eval searches fall back to
    // post-filtering the loaded store instead of consulting a sidecar from
    // the current active index.
    this.metadataSidecarAllowedForLoadedStore = false;
    this.metadataSidecarCache = null;
    this.metadataSidecarMissingLogged = false;
  }

  /**
   * RFC 014 — atomic save via versioned dirs + symlink swap.
   *
   * PRECONDITION: caller MUST hold withWriteLock(this.modelDir). Verified
   * call sites: KnowledgeBaseServer.ts:216,374 and cli.ts:436,646. Any
   * future caller that bypasses updateIndex must wrap in withWriteLock.
   * In NODE_ENV=test we assert the lock is held via proper-lockfile.check().
   */
  private async atomicSave(opts: { onCommitted?: () => Promise<void> } = {}): Promise<void> {
    if (!this.faissIndex) throw new Error('atomicSave called with null faissIndex');

    // PRECONDITION: caller MUST hold withWriteLock(this.modelDir). The four
    // verified call sites are KnowledgeBaseServer.ts:216,374 and
    // cli.ts:436,646. A runtime check via proper-lockfile.check() was
    // considered (RFC 014 §Risks) but proved to false-negative in tests
    // (proper-lockfile distinguishes lockfilePath args inconsistently across
    // call patterns). Documented contract + grep-able call sites is the
    // safer enforcement; future violations are caught by reviewers, not by
    // runtime assertion that itself misfires.

    const embeddingsForCanary = this.embeddings as Partial<Pick<EmbeddingsClient, 'embedDocuments'>> | undefined;
    const embeddingCanary = typeof embeddingsForCanary?.embedDocuments === 'function'
      ? await createEmbeddingCanaryFingerprint({ embedDocuments: embeddingsForCanary.embedDocuments })
      : null;
    this.swapCounter += 1;
    if (this.indexBackend === 'hnsw') {
      if (!(this.faissIndex instanceof HnswIndexAdapter) || this.hnswConfig === null) {
        throw new Error('atomicSave called with a non-HNSW adapter for HNSW index type');
      }
      await saveHnswIndexAtomic({
        adapter: this.faissIndex,
        modelDir: this.modelDir,
        modelId: this.modelId,
        swapCounter: this.swapCounter,
        config: this.hnswConfig,
        embeddingCanary,
        onCommitted: opts.onCommitted,
      });
      return;
    }
    await saveFaissStoreAtomic({
      store: this.faissStoreForPersistence(),
      modelDir: this.modelDir,
      modelId: this.modelId,
      swapCounter: this.swapCounter,
      indexType: this.indexType === 'sq8' ? 'sq8' : 'flat',
      embeddingCanary,
      casRoot: casRootForIndexPath(FAISS_INDEX_PATH),
      onCommitted: opts.onCommitted,
    });
  }

  private faissStoreForPersistence(): ReturnType<FaissStoreAdapter['getStoreForPersistence']> {
    const candidate = this.faissIndex as
      | FaissStoreAdapter
      | HnswIndexAdapter
      | ReturnType<FaissStoreAdapter['getStoreForPersistence']>
      | null;
    if (candidate instanceof HnswIndexAdapter) {
      throw new Error('atomicSave called with a HNSW adapter for FAISS index type');
    }
    if (candidate instanceof FaissStoreAdapter) {
      return candidate.getStoreForPersistence();
    }
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as { save?: unknown }).save === 'function'
    ) {
      return candidate as ReturnType<FaissStoreAdapter['getStoreForPersistence']>;
    }
    throw new Error('atomicSave called with a non-FAISS adapter for FAISS index type');
  }

  private async addDocumentsToIndex(
    documentsToAdd: Document[],
    opts: {
      onProgress?: (progress: IndexUpdateProgress) => void | Promise<void>;
      processedFiles: () => number;
      totalFiles: number;
      updateStartedAtMs: number;
    } | null = null,
  ): Promise<boolean> {
    if (documentsToAdd.length === 0) {
      return false;
    }

    const batchCount = Math.ceil(documentsToAdd.length / this.indexingBatchSize);
    const embedStartedAtMs = Date.now();
    let processedChunks = 0;
    // Scope duplicate-compaction to this indexing operation. FAISS still
    // receives every document; only provider embedDocuments calls are deduped.
    // With opt-in cross-batch pipelining, identical text in two concurrently
    // embedding batches may still race and call the provider twice. Keeping the
    // cache local preserves bounded memory and deterministic FAISS insertion.
    const indexingEmbeddings = new IndexingEmbeddingDeduper(this.embeddings);
    const batches: Document[][] = [];
    for (let offset = 0; offset < documentsToAdd.length; offset += this.indexingBatchSize) {
      batches.push(documentsToAdd.slice(offset, offset + this.indexingBatchSize));
    }

    const emitEmbeddingProgress = async (
      batch: readonly Document[],
      batchIndex: number,
    ): Promise<void> => {
      processedChunks += batch.length;
      if (!opts?.onProgress) return;

      const phaseElapsedMs = Date.now() - embedStartedAtMs;
      const throughputChunksPerSecond = phaseElapsedMs > 0
        ? processedChunks / (phaseElapsedMs / 1000)
        : null;
      const lastSource = batch[batch.length - 1]?.metadata?.source;
      await opts.onProgress({
        processedFiles: opts.processedFiles(),
        totalFiles: opts.totalFiles,
        currentFile: typeof lastSource === 'string' ? lastSource : '',
        modelId: this.modelId,
        phase: 'embed',
        phaseStatus: 'progress',
        processedChunks,
        totalChunks: documentsToAdd.length,
        batchIndex,
        batchCount,
        batchSize: batch.length,
        provider: this.embeddingProvider,
        modelName: this.modelName,
        elapsedMs: Date.now() - opts.updateStartedAtMs,
        phaseElapsedMs,
        throughputChunksPerSecond: throughputChunksPerSecond ?? undefined,
      });
    };

    const insertEmbeddedBatch = async (
      embedded: EmbeddedDocumentsBatch,
      batchIndex: number,
    ): Promise<void> => {
      if (this.faissIndex === null) {
        logger.info(`Creating new ${this.indexBackend.toUpperCase()} index from ${embedded.documents.length} text(s)...`);
        this.faissIndex = this.indexBackend === 'hnsw'
          ? await HnswIndexAdapter.fromEmbeddedDocuments(
              embedded,
              this.hnswConfig ?? resolveHnswIndexConfig(),
            )
          : await FaissStoreAdapter.fromEmbeddedDocuments(
              embedded,
              this.embeddings,
              { indexType: this.indexType === 'sq8' ? 'sq8' : 'flat' },
            );
      } else {
        await this.faissIndex.addEmbeddedDocuments(embedded);
      }
      await emitEmbeddingProgress(embedded.documents, batchIndex);
    };

    if (this.indexingConcurrency <= 1) {
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        const embedded = await FaissStoreAdapter.embedDocumentsForIndexing(batch, indexingEmbeddings);
        await insertEmbeddedBatch(embedded, i + 1);
      }
      return true;
    }

    type EmbeddedBatchResult =
      | { ok: true; embedded: EmbeddedDocumentsBatch }
      | { ok: false; error: unknown };
    const inFlight = new Map<number, Promise<EmbeddedBatchResult>>();
    let nextBatchToLaunch = 0;
    const launchMoreEmbeddingBatches = (): void => {
      while (
        nextBatchToLaunch < batches.length &&
        inFlight.size < this.indexingConcurrency
      ) {
        const launchIndex = nextBatchToLaunch;
        const batch = batches[launchIndex];
        inFlight.set(
          launchIndex,
          FaissStoreAdapter.embedDocumentsForIndexing(batch, indexingEmbeddings)
            .then((embedded) => ({ ok: true, embedded }) as const)
            .catch((error: unknown) => ({ ok: false, error }) as const),
        );
        nextBatchToLaunch += 1;
      }
    };

    launchMoreEmbeddingBatches();
    for (let i = 0; i < batches.length; i += 1) {
      const resultPromise = inFlight.get(i);
      if (resultPromise === undefined) {
        throw new Error(`Missing in-flight embedding batch ${i + 1}`);
      }
      const result = await resultPromise;
      inFlight.delete(i);
      if (!result.ok) {
        throw result.error;
      }
      launchMoreEmbeddingBatches();
      await insertEmbeddedBatch(result.embedded, i + 1);
    }
    return true;
  }

  /**
   * Updates the FAISS index.
   * If `specificKnowledgeBase` is provided, only files from that knowledge base will be checked and updated.
   * If no update occurs (and the FAISS index remains uninitialized) but there are documents,
   * then the index is built from all available files.
   */
  async updateIndex(
    specificKnowledgeBase?: string,
    opts: UpdateIndexOptions = {},
  ): Promise<void> {
    logger.debug('Updating FAISS index...');
    const startedAtMs = Date.now();
    const runSummary: IndexUpdateSummary = {
      ...createNeverRunIndexUpdateSummary(this.modelId),
      status: 'success',
      scope: specificKnowledgeBase ?? 'global',
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: null,
      duration_ms: null,
    };
    const recordFailure = (
      relativePath: string | null,
      phase: IndexUpdateFailureSummary['phase'],
      error: unknown,
    ): void => {
      runSummary.failure_count += 1;
      if (runSummary.failures.length < MAX_INDEX_UPDATE_FAILURES) {
        runSummary.failures.push(failureSummary(relativePath, phase, error));
      }
    };
    const recordWarning = (warning: IndexUpdateWarningSummary): void => {
      runSummary.warning_count += 1;
      if (runSummary.warnings.length < MAX_INDEX_UPDATE_FAILURES) {
        runSummary.warnings.push(warning);
      }
    };
    const recordQuarantineFailure = async (
      kbPath: string,
      relativePath: string,
      sourceHash: string | null,
      error: unknown,
    ): Promise<void> => {
      if (error instanceof IngestSecretDetectedError) {
        emitCanonicalLog({
          process: canonicalProcessFromArgv(),
          event: 'secret_detected',
          level: 'warn',
          kb_scope: path.basename(kbPath),
          top_sources: [relativePath],
          took_ms: 0,
          error: { code: error.code, category: 'input' },
          secret_scan: {
            categories: error.categories,
            chunk_indexes: error.chunkIndexes,
            locations: error.locations,
          },
        });
      }
      try {
        await recordIngestFailure({
          kbPath,
          relativePath,
          sourceHash,
          error,
        });
      } catch (quarantineError: unknown) {
        logger.warn(
          `Could not update ingest quarantine for ${path.join(kbPath, relativePath)}: ` +
            toError(quarantineError).message,
        );
      }
    };
    const recordQuarantineSuccess = async (
      kbPath: string,
      relativePath: string,
    ): Promise<void> => {
      try {
        await recordIngestSuccess(kbPath, relativePath);
      } catch (quarantineError: unknown) {
        logger.warn(
          `Could not clear ingest quarantine for ${path.join(kbPath, relativePath)}: ` +
            toError(quarantineError).message,
        );
      }
    };
    try {
      const forceReindex = opts.force === true;
      let hadActiveIndexBeforeForce = false;
      // FAISS has no per-vector delete API and we keep one global store
      // across all KBs. So a forced rebuild MUST null the in-memory index
      // AND walk every KB. A scoped force ("rebuild just KB alpha") would
      // either:
      //   (a) keep the existing store and append fresh embeddings, leaving
      //       orphaned vectors from deleted files alive AND duplicating
      //       every still-present file, or
      //   (b) build a fresh store containing only the scoped KB's vectors,
      //       silently dropping every other KB.
      // Both are wrong. Treat scope as advisory under force: log the
      // upgrade and rebuild globally.
      let scopedKnowledgeBase = specificKnowledgeBase;
      let shouldPurgePersistedIndexIfEmpty = false;
      if (forceReindex) {
        hadActiveIndexBeforeForce = (await this.resolveActiveIndexFilePath()) !== null;
        this.faissIndex = null;
        shouldPurgePersistedIndexIfEmpty = true;
        if (scopedKnowledgeBase !== undefined) {
          logger.info(
            `Forced reindex of "${scopedKnowledgeBase}" upgraded to a global rebuild ` +
              `(FAISS deletion is unsupported; scoped rebuild would either duplicate ` +
              `vectors or drop other KBs).`,
          );
          scopedKnowledgeBase = undefined;
        }
      }

      if (!forceReindex && this.faissIndex !== null) {
        const activeIndexFilePath = await this.resolveActiveIndexFilePath();
        if (activeIndexFilePath !== null) {
          const indexStat = await fsp.stat(activeIndexFilePath);
          const freshnessManifest = await readFreshnessManifest({
            modelId: this.modelId,
            modelDir: this.modelDir,
            indexMtimeMs: indexStat.mtimeMs,
          });
          if (freshnessManifest === null) {
            this.faissIndex = null;
            shouldPurgePersistedIndexIfEmpty = true;
            if (scopedKnowledgeBase !== undefined) {
              logger.info(
                `Ingest filter changed for "${scopedKnowledgeBase}"; upgrading scoped ` +
                  `refresh to a global rebuild because FAISS vector deletion is unsupported.`,
              );
              scopedKnowledgeBase = undefined;
            }
            logger.info(
              `Freshness manifest for model ${this.modelId} is missing or stale; ` +
                `rebuilding the full FAISS index to avoid stale vectors from files that ` +
                `are no longer ingestable.`,
            );
            await this.purgeStaleSidecars('ingest_filter_changed');
          }
        }
      }
      runSummary.scope = scopedKnowledgeBase ?? 'global';

      let knowledgeBases: string[] = [];
      if (scopedKnowledgeBase) {
        knowledgeBases.push(scopedKnowledgeBase);
      } else {
        knowledgeBases = await fsp.readdir(KNOWLEDGE_BASES_ROOT_DIR);
      }

      let anyFileProcessed = false;
      let indexMutated = false;
      let processedFiles = 0;
      let lastProgressFileCount = 0;
      const rebuildFromEmptyIndex = this.faissIndex === null;
      const progressIntervalFiles = Math.max(
        1,
        Math.floor(opts.progressIntervalFiles ?? DEFAULT_REBUILD_PROGRESS_INTERVAL_FILES),
      );
      const pendingHashWrites: { path: string; hash: string }[] = [];
      const pendingChunkManifestWrites: { path: string; manifest: ChunkManifest }[] = [];
      const loaderFailurePaths = new Set<string>();
      const deferredNonQuiescentPaths = new Set<string>();
      const refreshQuiesceMs = resolveRefreshQuiesceMs();
      let skipFallbackBuild = false;
      const changedDuringScanWarning = (relativePath: string): IndexUpdateWarningSummary => ({
        relative_path: relativePath,
        code: 'KB_REFRESH_FILE_CHANGED_DURING_SCAN',
        message:
          `Skipping ${relativePath} because its size, mtime, or hash changed ` +
          `while refresh was scanning it; a later refresh will retry it.`,
        quiesce_ms: refreshQuiesceMs,
      });
      const recordDeferredNonQuiescentPath = (
        filePath: string,
        warning: IndexUpdateWarningSummary,
      ): void => {
        if (deferredNonQuiescentPaths.has(filePath)) {
          return;
        }
        deferredNonQuiescentPaths.add(filePath);
        runSummary.files_skipped += 1;
        recordWarning(warning);
        logger.warn(warning.message);
      };
      const stillMatchesScan = async (scan: {
        filePath: string;
        relativePath: string;
        fileHash: string;
        fileSize: number;
        mtimeMs: number;
      }): Promise<IndexUpdateWarningSummary | null> => {
        if (refreshQuiesceMs <= 0) {
          return null;
        }
        try {
          const afterLoadStat = await fsp.stat(scan.filePath);
          if (afterLoadStat.size !== scan.fileSize || afterLoadStat.mtimeMs !== scan.mtimeMs) {
            return changedDuringScanWarning(scan.relativePath);
          }
          const afterLoadHash = await calculateSHA256(scan.filePath);
          if (afterLoadHash !== scan.fileHash) {
            return changedDuringScanWarning(scan.relativePath);
          }
          return null;
        } catch {
          return changedDuringScanWarning(scan.relativePath);
        }
      };

      // First enumerate every candidate path so progress notifications can
      // report a stable denominator before embedding begins. `knowledgeBases`
      // can come from a raw `fsp.readdir` above and may include dot folders
      // (`.faiss`, `.reindex-trigger`); filter them here since the shared
      // helper does not.
      const ingestableKbNames = knowledgeBases.filter((knowledgeBaseName) => {
        if (knowledgeBaseName.startsWith('.')) {
          logger.debug(`Skipping dot folder: ${knowledgeBaseName}`);
          return false;
        }
        return true;
      });
      const enumerations = await enumerateIngestableKbFiles(
        KNOWLEDGE_BASES_ROOT_DIR,
        ingestableKbNames,
        {
          extraExtensions: INGEST_EXTRA_EXTENSIONS,
          excludePaths: INGEST_EXCLUDE_PATHS,
        },
      );
      for (const entry of enumerations) {
        if (entry.diagnostics.failure_count === 0) continue;
        runSummary.failure_count += entry.diagnostics.failure_count;
        for (const failure of entry.diagnostics.failures) {
          if (runSummary.failures.length >= MAX_INDEX_UPDATE_FAILURES) break;
          const relativePath = path.relative(KNOWLEDGE_BASES_ROOT_DIR, failure.path);
          runSummary.failures.push({
            relative_path: relativePath,
            phase: 'enumeration',
            code: failure.code,
            message: sanitizeFailureMessage(failure.message, relativePath, failure.path),
          });
        }
      }
      const knowledgeBaseFiles = enumerations.map((entry) => ({
        knowledgeBaseName: entry.kbName,
        knowledgeBasePath: entry.kbPath,
        filePaths: entry.filePaths,
      }));

      const totalFiles = totalFileCount(knowledgeBaseFiles);
      const emitProgress = async (
        progress: Omit<IndexUpdateProgress, 'modelId' | 'provider' | 'modelName' | 'elapsedMs'>,
      ): Promise<void> => {
        if (!opts.onProgress) return;
        await opts.onProgress({
          ...progress,
          modelId: this.modelId,
          provider: this.embeddingProvider,
          modelName: this.modelName,
          elapsedMs: Date.now() - startedAtMs,
        });
      };
      let scannedFilesForProgress = 0;
      let lastScanProgressFileCount = 0;
      const reportScanProgress = async (currentFile: string): Promise<void> => {
        if (!opts.onProgress || scannedFilesForProgress === lastScanProgressFileCount) {
          return;
        }
        if (
          scannedFilesForProgress % progressIntervalFiles !== 0 &&
          scannedFilesForProgress !== totalFiles
        ) {
          return;
        }
        lastScanProgressFileCount = scannedFilesForProgress;
        await emitProgress({
          processedFiles,
          totalFiles,
          currentFile,
          phase: 'scan',
          phaseStatus: 'progress',
          filesScanned: scannedFilesForProgress,
        });
      };
      let lastLoadProgressFileCount = 0;
      const reportLoadProgress = async (currentFile: string): Promise<void> => {
        if (!opts.onProgress || runSummary.files_scanned === lastLoadProgressFileCount) {
          return;
        }
        if (
          runSummary.files_scanned % progressIntervalFiles !== 0 &&
          runSummary.files_scanned !== totalFiles
        ) {
          return;
        }
        lastLoadProgressFileCount = runSummary.files_scanned;
        await emitProgress({
          processedFiles,
          totalFiles,
          currentFile,
          phase: 'load',
          phaseStatus: 'progress',
          filesScanned: runSummary.files_scanned,
          filesChanged: runSummary.files_changed,
          filesSkipped: runSummary.files_skipped,
          chunksDiscovered: runSummary.chunks_attempted,
        });
      };
      const reportProgress = async (currentFile: string): Promise<void> => {
        if (!opts.onProgress || processedFiles === lastProgressFileCount) {
          return;
        }
        if (
          processedFiles % progressIntervalFiles !== 0 &&
          processedFiles !== totalFiles
        ) {
          return;
        }
        lastProgressFileCount = processedFiles;
        await opts.onProgress({
          processedFiles,
          totalFiles,
          currentFile,
          modelId: this.modelId,
          provider: this.embeddingProvider,
          modelName: this.modelName,
          elapsedMs: Date.now() - startedAtMs,
        });
      };

      // Process each knowledge base directory.
      const changedFileDocuments: Array<{
        knowledgeBasePath: string;
        relativePath: string;
        filePath: string;
        indexFilePath: string;
        chunkManifestPath: string;
        fileHash: string;
        documents: Document[];
        manifest: ChunkManifest;
      }> = [];
      const metadataOnlyFileUpdates: Array<{
        knowledgeBasePath: string;
        relativePath: string;
        filePath: string;
        indexFilePath: string;
        chunkManifestPath: string;
        fileHash: string;
        manifest: ChunkManifest;
      }> = [];
      const indexableScans: Array<{
        knowledgeBaseName: string;
        knowledgeBasePath: string;
        filePath: string;
        relativePath: string;
        indexFilePath: string;
        chunkManifestPath: string;
        fileHash: string;
        fileSize: number;
        mtimeMs: number;
      }> = [];
      let requiresFullRebuild = false;
      const successfulIndexedFiles: Array<{ knowledgeBasePath: string; relativePath: string }> = [];
      const fsConcurrency = resolveFsConcurrency();
      const fileScanJobs = knowledgeBaseFiles.flatMap(
        ({ knowledgeBaseName, knowledgeBasePath, filePaths }) => filePaths.map((filePath) => {
          const relativePath = path.relative(knowledgeBasePath, filePath);
          const indexFilePath = path.join(
            knowledgeBasePath,
            '.index',
            path.dirname(relativePath),
            path.basename(filePath),
          );
          return {
            knowledgeBaseName,
            knowledgeBasePath,
            filePath,
            relativePath,
            indexFilePath,
            chunkManifestPath: `${indexFilePath}.chunks.json`,
          };
        }),
      );
      const fileScanResults = await mapBounded(
        fileScanJobs,
        fsConcurrency,
        async (job) => {
          try {
            const beforeStat = await fsp.stat(job.filePath);
            let stableStat = beforeStat;
            if (refreshQuiesceMs > 0) {
              const mtimeAgeMs = Math.max(0, Date.now() - beforeStat.mtimeMs);
              if (mtimeAgeMs < refreshQuiesceMs) {
                return {
                  ...job,
                  success: false as const,
                  deferred: true as const,
                  error: new Error('refresh file is not quiescent'),
                  warning: {
                    relative_path: job.relativePath,
                    code: 'KB_REFRESH_NOT_QUIESCENT' as const,
                    message:
                      `Skipping ${job.relativePath} because its mtime age ` +
                      `${Math.floor(mtimeAgeMs)}ms is below KB_REFRESH_QUIESCE_MS=${refreshQuiesceMs}; ` +
                      `a later refresh will retry it.`,
                    mtime_age_ms: Math.floor(mtimeAgeMs),
                    quiesce_ms: refreshQuiesceMs,
                  },
                };
              }
            }
            const fileHash = await calculateSHA256(job.filePath);
            if (refreshQuiesceMs > 0) {
              const afterStat = await fsp.stat(job.filePath);
              if (
                beforeStat.size !== afterStat.size ||
                beforeStat.mtimeMs !== afterStat.mtimeMs
              ) {
                return {
                  ...job,
                  success: false as const,
                  deferred: true as const,
                  error: new Error('refresh file changed during scan'),
                  warning: {
                    relative_path: job.relativePath,
                    code: 'KB_REFRESH_FILE_CHANGED_DURING_SCAN' as const,
                    message:
                      `Skipping ${job.relativePath} because its size or mtime changed ` +
                      `while refresh was scanning it; a later refresh will retry it.`,
                    quiesce_ms: refreshQuiesceMs,
                  },
                };
              }
              stableStat = afterStat;
            }
            let storedHash: string | null = null;
            try {
              const buffer = await fsp.readFile(job.indexFilePath);
              storedHash = buffer.toString('utf-8');
            } catch {
              // The hash file may not exist yet; that's fine.
            }
            return {
              ...job,
              success: true as const,
              fileHash,
              storedHash,
              fileSize: stableStat.size,
              mtimeMs: stableStat.mtimeMs,
            };
          } catch (error: unknown) {
            return { ...job, success: false as const, error };
          } finally {
            scannedFilesForProgress += 1;
            await reportScanProgress(job.filePath);
          }
        },
      );
      for (const scan of fileScanResults) {
        anyFileProcessed = true;
        runSummary.files_scanned += 1;

        if (!scan.success) {
          if ('deferred' in scan && scan.deferred) {
            recordDeferredNonQuiescentPath(scan.filePath, scan.warning);
            await reportLoadProgress(scan.filePath);
            continue;
          }
          logger.warn(`Quarantining unreadable file ${scan.filePath}:`, toError(scan.error));
          runSummary.files_skipped += 1;
          loaderFailurePaths.add(scan.filePath);
          recordFailure(scan.relativePath, 'load', scan.error);
          await recordQuarantineFailure(
            scan.knowledgeBasePath,
            scan.relativePath,
            null,
            scan.error,
          );
          await reportLoadProgress(scan.filePath);
          continue;
        }

        const retryDecision = await shouldRetryIngest(
          scan.knowledgeBasePath,
          scan.relativePath,
          { sourceHash: scan.fileHash },
        );
        if (!retryDecision.retry) {
          runSummary.files_skipped += 1;
          logger.warn(
            `Skipping quarantined file ${scan.filePath} ` +
              `(${retryDecision.reason}; next_retry_at=${retryDecision.record?.next_retry_at ?? '<unknown>'})`,
          );
          await reportLoadProgress(scan.filePath);
          continue;
        }
        indexableScans.push({
          knowledgeBaseName: scan.knowledgeBaseName,
          knowledgeBasePath: scan.knowledgeBasePath,
          filePath: scan.filePath,
          relativePath: scan.relativePath,
          indexFilePath: scan.indexFilePath,
          chunkManifestPath: scan.chunkManifestPath,
          fileHash: scan.fileHash,
          fileSize: scan.fileSize,
          mtimeMs: scan.mtimeMs,
        });

        // If the file is new/changed, or the index itself is absent,
        // process it. The missing-index case must ignore matching sidecars:
        // otherwise a rebuild can silently omit files whose hashes were
        // already current.
        if (rebuildFromEmptyIndex || forceReindex || scan.fileHash !== scan.storedHash) {
          runSummary.files_changed += 1;
          logger.info(
            forceReindex
              ? `Force rebuild: re-embedding all chunks from ${scan.filePath} ` +
                `(existing index will be replaced)...`
              : rebuildFromEmptyIndex
                ? `FAISS index is empty. Rebuilding from ${scan.filePath}...`
              : `File ${scan.filePath} has changed. Updating index...`,
          );
          // Issue #46 — extension-routed loader. `.pdf` runs through
          // pdf-parse, `.html`/`.htm` through html-to-text, anything else
          // (including operator-supplied INGEST_EXTRA_EXTENSIONS like
          // `.json` or `.csv`) reads as UTF-8.
          let content = '';
          try {
            content = await loadFile(scan.filePath);
          } catch (error: unknown) {
            logger.warn(`Quarantining load failure for ${scan.filePath}:`, toError(error));
            runSummary.files_skipped += 1;
            loaderFailurePaths.add(scan.filePath);
            recordFailure(scan.relativePath, 'load', error);
            await recordQuarantineFailure(
              scan.knowledgeBasePath,
              scan.relativePath,
              scan.fileHash,
              error,
            );
            await reportLoadProgress(scan.filePath);
            continue;
          }
          const loadWarning = await stillMatchesScan(scan);
          if (loadWarning !== null) {
            recordDeferredNonQuiescentPath(scan.filePath, loadWarning);
            await reportLoadProgress(scan.filePath);
            continue;
          }

          let documentsToAdd: Document[];
          try {
            documentsToAdd = await buildChunkDocuments(
              scan.filePath,
              content,
              scan.knowledgeBaseName,
            );
          } catch (error: unknown) {
            logger.warn(`Quarantining chunking failure for ${scan.filePath}:`, toError(error));
            runSummary.files_skipped += 1;
            loaderFailurePaths.add(scan.filePath);
            recordFailure(scan.relativePath, 'indexing', error);
            await recordQuarantineFailure(
              scan.knowledgeBasePath,
              scan.relativePath,
              scan.fileHash,
              error,
            );
            await reportLoadProgress(scan.filePath);
            continue;
          }
          runSummary.chunks_attempted += documentsToAdd.length;

          if (documentsToAdd.length > 0) {
            const nextManifest = buildChunkManifest(documentsToAdd, scan.fileHash);
            let documentsForIndex = documentsToAdd;
            if (!rebuildFromEmptyIndex && !forceReindex) {
              const previousManifest = await readChunkManifest(scan.chunkManifestPath);
              if (previousManifest === null) {
                requiresFullRebuild = true;
                logger.info(
                  `Chunk manifest missing for changed file ${scan.filePath}; ` +
                    `falling back to a full rebuild to avoid stale vectors.`,
                );
              } else {
                const stablePrefix = countStableChunkPrefix(previousManifest, nextManifest);
                if (
                  stablePrefix === previousManifest.chunks.length &&
                  nextManifest.chunks.length >= previousManifest.chunks.length
                ) {
                  documentsForIndex = documentsToAdd.slice(stablePrefix);
                } else {
                  requiresFullRebuild = true;
                  logger.info(
                    `Chunk manifest for ${scan.filePath} changed outside a stable append; ` +
                      `falling back to a full rebuild because FAISS vector deletion is unsupported.`,
                  );
                }
              }
            }

            if (!requiresFullRebuild) {
              if (documentsForIndex.length > 0) {
                changedFileDocuments.push({
                  knowledgeBasePath: scan.knowledgeBasePath,
                  relativePath: scan.relativePath,
                  filePath: scan.filePath,
                  indexFilePath: scan.indexFilePath,
                  chunkManifestPath: scan.chunkManifestPath,
                  fileHash: scan.fileHash,
                  documents: documentsForIndex,
                  manifest: nextManifest,
                });
              } else {
                metadataOnlyFileUpdates.push({
                  knowledgeBasePath: scan.knowledgeBasePath,
                  relativePath: scan.relativePath,
                  filePath: scan.filePath,
                  indexFilePath: scan.indexFilePath,
                  chunkManifestPath: scan.chunkManifestPath,
                  fileHash: scan.fileHash,
                  manifest: nextManifest,
                });
              }
            }
          } else {
            if (!rebuildFromEmptyIndex && !forceReindex) {
              const previousManifest = await readChunkManifest(scan.chunkManifestPath);
              if (previousManifest !== null && previousManifest.chunks.length > 0) {
                requiresFullRebuild = true;
                logger.info(
                  `Changed file ${scan.filePath} now emits no chunks; ` +
                    `falling back to a full rebuild to remove stale vectors.`,
                );
              }
            }
            logger.debug(`No documents generated from ${scan.filePath}. Skipping index update.`);
          }
        } else {
          await recordQuarantineSuccess(scan.knowledgeBasePath, scan.relativePath);
          runSummary.files_unchanged += 1;
          logger.debug(`File ${scan.filePath} unchanged, skipping.`);
        }
        await reportLoadProgress(scan.filePath);
      }
      if (
        forceReindex &&
        hadActiveIndexBeforeForce &&
        deferredNonQuiescentPaths.size > 0
      ) {
        await this.reloadPersistedIndex();
        shouldPurgePersistedIndexIfEmpty = false;
        skipFallbackBuild = true;
        requiresFullRebuild = false;
        changedFileDocuments.length = 0;
        metadataOnlyFileUpdates.length = 0;
        runSummary.chunks_attempted = 0;
        logger.warn(
          'Skipping forced FAISS rebuild because at least one file is not quiescent; ' +
            'the existing persisted index remains active and a later refresh will retry.',
        );
      } else if (
        requiresFullRebuild &&
        this.faissIndex !== null &&
        deferredNonQuiescentPaths.size > 0
      ) {
        requiresFullRebuild = false;
        changedFileDocuments.length = 0;
        metadataOnlyFileUpdates.length = 0;
        runSummary.chunks_attempted = 0;
        logger.warn(
          'Deferring full FAISS rebuild because at least one file is not quiescent; ' +
            'the existing index remains active and a later refresh will retry.',
        );
      }
      if (requiresFullRebuild) {
        const hadIndexBeforeFullRebuild = this.faissIndex !== null;
        const deferredCountBeforeFullRebuild = deferredNonQuiescentPaths.size;
        this.faissIndex = null;
        changedFileDocuments.length = 0;
        metadataOnlyFileUpdates.length = 0;
        runSummary.chunks_attempted = 0;
        logger.info(
          'Rebuilding the full FAISS index because at least one changed file ' +
            'could not be updated incrementally without leaving stale vectors.',
        );
        for (const scan of indexableScans) {
          let content = '';
          try {
            content = await loadFile(scan.filePath);
          } catch (error: unknown) {
            logger.warn(`Quarantining rebuild load failure for ${scan.filePath}:`, toError(error));
            runSummary.files_skipped += 1;
            loaderFailurePaths.add(scan.filePath);
            recordFailure(scan.relativePath, 'load', error);
            await recordQuarantineFailure(
              scan.knowledgeBasePath,
              scan.relativePath,
              scan.fileHash,
              error,
            );
            continue;
          }
          const loadWarning = await stillMatchesScan(scan);
          if (loadWarning !== null) {
            recordDeferredNonQuiescentPath(scan.filePath, loadWarning);
            continue;
          }

          let documents: Document[];
          try {
            documents = await buildChunkDocuments(
              scan.filePath,
              content,
              scan.knowledgeBaseName,
            );
          } catch (error: unknown) {
            logger.warn(`Quarantining rebuild chunking failure for ${scan.filePath}:`, toError(error));
            runSummary.files_skipped += 1;
            loaderFailurePaths.add(scan.filePath);
            recordFailure(scan.relativePath, 'indexing', error);
            await recordQuarantineFailure(
              scan.knowledgeBasePath,
              scan.relativePath,
              scan.fileHash,
              error,
            );
            continue;
          }

          runSummary.chunks_attempted += documents.length;
          if (documents.length === 0) {
            logger.debug(`No documents generated from ${scan.filePath}. Skipping rebuild entry.`);
            continue;
          }

          changedFileDocuments.push({
            knowledgeBasePath: scan.knowledgeBasePath,
            relativePath: scan.relativePath,
            filePath: scan.filePath,
            indexFilePath: scan.indexFilePath,
            chunkManifestPath: scan.chunkManifestPath,
            fileHash: scan.fileHash,
            documents,
            manifest: buildChunkManifest(documents, scan.fileHash),
          });
        }
        if (
          hadIndexBeforeFullRebuild &&
          deferredNonQuiescentPaths.size > deferredCountBeforeFullRebuild
        ) {
          await this.reloadPersistedIndex();
          changedFileDocuments.length = 0;
          metadataOnlyFileUpdates.length = 0;
          runSummary.chunks_attempted = 0;
          logger.warn(
            'Discarding in-progress full FAISS rebuild because a file changed during scan; ' +
              'the existing persisted index remains active and a later refresh will retry.',
          );
        }
      }
      const documentsToAdd = changedFileDocuments.flatMap((entry) => entry.documents);
      let addedChangedDocuments = false;
      try {
        addedChangedDocuments = await this.addDocumentsToIndex(documentsToAdd, {
          onProgress: opts.onProgress,
          processedFiles: () => processedFiles,
          totalFiles,
          updateStartedAtMs: startedAtMs,
        });
      } catch (error: unknown) {
        for (const entry of changedFileDocuments) {
          recordFailure(entry.relativePath, 'indexing', error);
          await recordQuarantineFailure(
            entry.knowledgeBasePath,
            entry.relativePath,
            entry.fileHash,
            error,
          );
        }
        throw error;
      }
      if (addedChangedDocuments) {
        indexMutated = true;
        runSummary.index_mutated = true;
        runSummary.chunks_added += documentsToAdd.length;
        for (const entry of changedFileDocuments) {
          pendingHashWrites.push({ path: entry.indexFilePath, hash: entry.fileHash });
          pendingChunkManifestWrites.push({
            path: entry.chunkManifestPath,
            manifest: entry.manifest,
          });
          successfulIndexedFiles.push({
            knowledgeBasePath: entry.knowledgeBasePath,
            relativePath: entry.relativePath,
          });
          logger.debug(`Index updated in-memory for ${entry.filePath}.`);
          processedFiles += 1;
          await reportProgress(entry.filePath);
        }
      }
      for (const entry of metadataOnlyFileUpdates) {
        pendingHashWrites.push({ path: entry.indexFilePath, hash: entry.fileHash });
        pendingChunkManifestWrites.push({
          path: entry.chunkManifestPath,
          manifest: entry.manifest,
        });
        successfulIndexedFiles.push({
          knowledgeBasePath: entry.knowledgeBasePath,
          relativePath: entry.relativePath,
        });
      }

      // If at least one file was processed but no changes triggered index creation,
      // then attempt to build the FAISS index from all available documents.
      if (this.faissIndex === null && anyFileProcessed && !skipFallbackBuild) {
        logger.info('No updates detected but FAISS index is not initialized. Building index from all available documents...');
        const fallbackDocuments: Array<{
          knowledgeBasePath: string;
          relativePath: string;
          filePath: string;
          indexFilePath: string;
          chunkManifestPath: string;
          fileHash: string | null;
          documents: Document[];
          manifest: ChunkManifest;
        }> = [];
        for (const { knowledgeBaseName, knowledgeBasePath, filePaths } of knowledgeBaseFiles) {
          for (const filePath of filePaths) {
            if (deferredNonQuiescentPaths.has(filePath)) {
              continue;
            }
            const relativePath = path.relative(knowledgeBasePath, filePath);
            let fileHash: string | null = null;
            try {
              fileHash = await calculateSHA256(filePath);
            } catch {
              // The first pass already records read failures. Avoid double-counting here.
            }
            const retryDecision = await shouldRetryIngest(
              knowledgeBasePath,
              relativePath,
              { sourceHash: fileHash },
            );
            if (!retryDecision.retry) {
              continue;
            }
            // Issue #46 — same extension-routed loader as the per-file path.
            let content = '';
            try {
              content = await loadFile(filePath);
            } catch (error: unknown) {
              logger.warn(`Quarantining fallback load failure for ${filePath}:`, toError(error));
              if (!loaderFailurePaths.has(filePath)) {
                runSummary.files_skipped += 1;
                recordFailure(relativePath, 'load', error);
                await recordQuarantineFailure(
                  knowledgeBasePath,
                  relativePath,
                  fileHash,
                  error,
                );
              }
              continue;
            }
            if (refreshQuiesceMs > 0 && fileHash !== null) {
              try {
                const afterLoadHash = await calculateSHA256(filePath);
                if (afterLoadHash !== fileHash) {
                  recordDeferredNonQuiescentPath(filePath, changedDuringScanWarning(relativePath));
                  continue;
                }
              } catch {
                recordDeferredNonQuiescentPath(filePath, changedDuringScanWarning(relativePath));
                continue;
              }
            }
            let documents: Document[];
            try {
              documents = await buildChunkDocuments(
                filePath,
                content,
                knowledgeBaseName,
              );
            } catch (error: unknown) {
              if (!loaderFailurePaths.has(filePath)) {
                runSummary.files_skipped += 1;
                recordFailure(relativePath, 'indexing', error);
                await recordQuarantineFailure(
                  knowledgeBasePath,
                  relativePath,
                  fileHash,
                  error,
                );
              }
              continue;
            }
            runSummary.chunks_attempted += documents.length;
            if (documents.length > 0) {
              const indexFilePath = path.join(
                knowledgeBasePath,
                '.index',
                path.dirname(relativePath),
                path.basename(filePath),
              );
              fallbackDocuments.push({
                knowledgeBasePath,
                relativePath,
                filePath,
                indexFilePath,
                chunkManifestPath: `${indexFilePath}.chunks.json`,
                fileHash,
                documents,
                manifest: buildChunkManifest(documents, fileHash ?? '0'.repeat(64)),
              });
            }
          }
        }
        let addedFallbackDocuments = false;
        try {
          addedFallbackDocuments = await this.addDocumentsToIndex(
            fallbackDocuments.flatMap((entry) => entry.documents),
            {
              onProgress: opts.onProgress,
              processedFiles: () => processedFiles,
              totalFiles,
              updateStartedAtMs: startedAtMs,
            },
          );
        } catch (error: unknown) {
          for (const entry of fallbackDocuments) {
            recordFailure(entry.relativePath, 'indexing', error);
            await recordQuarantineFailure(
              entry.knowledgeBasePath,
              entry.relativePath,
              entry.fileHash,
              error,
            );
          }
          throw error;
        }
        if (addedFallbackDocuments) {
          indexMutated = true;
          runSummary.index_mutated = true;
          runSummary.chunks_added += fallbackDocuments.reduce(
            (sum, entry) => sum + entry.documents.length,
            0,
          );
          for (const entry of fallbackDocuments) {
            if (entry.fileHash !== null) {
              pendingHashWrites.push({ path: entry.indexFilePath, hash: entry.fileHash });
              pendingChunkManifestWrites.push({
                path: entry.chunkManifestPath,
                manifest: entry.manifest,
              });
            }
            successfulIndexedFiles.push({
              knowledgeBasePath: entry.knowledgeBasePath,
              relativePath: entry.relativePath,
            });
            processedFiles += 1;
            await reportProgress(entry.filePath);
          }
        }
      }

      if (
        (indexMutated && this.faissIndex !== null) ||
        pendingHashWrites.length > 0 ||
        pendingChunkManifestWrites.length > 0
      ) {
        // RFC 014 — atomicSave writes to a versioned `index.vN/` and swaps
        // the `index` symlink atomically. The legacy `faiss.index/` directory
        // (if present from a pre-RFC-014 install) is intentionally NOT
        // updated; first save under v014 effectively migrates the model to
        // versioned layout.
        const shouldPersistPendingSidecarCommit =
          indexMutated &&
          (pendingHashWrites.length > 0 || pendingChunkManifestWrites.length > 0);
        if (indexMutated) {
          let faissStoreCommitted = false;
          try {
            const saveStartedAtMs = Date.now();
            await emitProgress({
              processedFiles,
              totalFiles,
              currentFile: '',
              phase: 'save',
              phaseStatus: 'started',
            });
            if (shouldPersistPendingSidecarCommit) {
              await writePendingSidecarCommitManifest({
                modelDir: this.modelDir,
                phase: 'save-started',
                pendingHashWrites,
                pendingChunkManifestWrites,
              });
            }
            await this.atomicSave({
              onCommitted: shouldPersistPendingSidecarCommit
                ? async () => {
                    faissStoreCommitted = true;
                    await writePendingSidecarCommitManifest({
                      modelDir: this.modelDir,
                      phase: 'save-complete',
                      pendingHashWrites,
                      pendingChunkManifestWrites,
                    });
                  }
                : undefined,
            });
            runSummary.saved = true;
            await emitProgress({
              processedFiles,
              totalFiles,
              currentFile: '',
              phase: 'save',
              phaseStatus: 'completed',
              phaseElapsedMs: Date.now() - saveStartedAtMs,
              saved: true,
            });
          } catch (saveError: unknown) {
            recordFailure(null, 'save', saveError);
            handleFsOperationError(
              'save FAISS index for model',
              this.modelId,
              saveError,
            );
          } finally {
            if (!faissStoreCommitted && shouldPersistPendingSidecarCommit) {
              await clearPendingSidecarCommitManifest(this.modelDir).catch(() => undefined);
            }
          }
        }
        // Sidecars are written only after any needed index save has
        // completed. Metadata-only updates (same chunks, different file
        // bytes) do not need a FAISS save, but can still advance sidecars.
        // `writeSidecarHashes` runs the batch under `withSidecarLock` so a
        // concurrent model's `purgeStaleSidecars` cannot rmrf
        // `<kb>/.index/` between our pre-loop `mkdir` and `rename` (issue
        // #90 follow-up). For index-mutating updates, pending-manifest.json
        // remains on disk until every sidecar write completes so initialize()
        // can finish the sidecar commit after a process crash.
        try {
          const sidecarStartedAtMs = Date.now();
          await emitProgress({
            processedFiles,
            totalFiles,
            currentFile: '',
            phase: 'sidecar',
            phaseStatus: 'started',
            sidecarsWritten: pendingHashWrites.length + pendingChunkManifestWrites.length,
          });
          await writeSidecarHashes(pendingHashWrites);
          await writeChunkManifests(pendingChunkManifestWrites);
          if (indexMutated && this.faissIndex !== null) {
            // Issue #283 — keep the predicate-pushdown sidecar in sync
            // with the FAISS docstore. Best-effort: a write failure here
            // logs and falls through; the next query simply picks the
            // post-filter ladder until the next successful refresh.
            try {
              await this.refreshMetadataSidecar();
            } catch (sidecarRefreshError: unknown) {
              logger.warn(
                `Issue #283 metadata sidecar refresh failed for ${this.modelId}: ` +
                  `${toError(sidecarRefreshError).message}. Queries will use the ` +
                  `post-filter overfetch ladder until the next successful refresh.`,
              );
            }
          }
          runSummary.sidecars_written =
            pendingHashWrites.length > 0 || pendingChunkManifestWrites.length > 0;
          await emitProgress({
            processedFiles,
            totalFiles,
            currentFile: '',
            phase: 'sidecar',
            phaseStatus: 'completed',
            phaseElapsedMs: Date.now() - sidecarStartedAtMs,
            sidecarsWritten: pendingHashWrites.length + pendingChunkManifestWrites.length,
          });
          for (const entry of successfulIndexedFiles) {
            await recordQuarantineSuccess(entry.knowledgeBasePath, entry.relativePath);
          }
          if (shouldPersistPendingSidecarCommit) {
            await clearPendingSidecarCommitManifest(this.modelDir);
          }
        } catch (sidecarError: unknown) {
          recordFailure(null, 'sidecar', sidecarError);
          throw sidecarError;
        }
      }
      try {
        const manifestStartedAtMs = Date.now();
        const activeIndexFilePath = await this.resolveActiveIndexFilePath();
        if (this.faissIndex === null && shouldPurgePersistedIndexIfEmpty) {
          await this.purgePersistedIndexStore(
            forceReindex ? 'force_reindex' : 'ingest_filter_changed',
          );
        } else if (activeIndexFilePath !== null && runSummary.failure_count === 0) {
          const indexStat = await fsp.stat(activeIndexFilePath);
          await writeFreshnessManifest({
            modelId: this.modelId,
            modelDir: this.modelDir,
            indexMtimeMs: indexStat.mtimeMs,
          });
        }
        await emitProgress({
          processedFiles,
          totalFiles,
          currentFile: '',
          phase: 'manifest',
          phaseStatus: 'completed',
          phaseElapsedMs: Date.now() - manifestStartedAtMs,
        });
      } catch (manifestError: unknown) {
        logger.warn(
          `Could not write freshness manifest for ${this.modelId}: ${toError(manifestError).message}`,
        );
      }
      logger.debug('FAISS index update process completed.');
      runSummary.status = runSummary.failure_count > 0 ? 'partial' : 'success';
    } catch (error: unknown) {
      runSummary.status = 'failed';
      if (runSummary.failure_count === 0) {
        recordFailure(null, 'unknown', error);
      }
      const err = toError(error) as Error & { __alreadyLogged?: boolean };
      if (!err.__alreadyLogged) {
        // Issue #86 — for KBError we already crafted an operator-facing
        // message; suppress the stack to keep the log readable. Unknown
        // errors still get the full stack for debugging.
        if (err instanceof KBError) {
          logger.error(`Error updating FAISS index: ${err.message}`);
        } else {
          logger.error('Error updating FAISS index:', err);
          if (err.stack) {
            logger.error(err.stack);
          }
        }
      }
      throw err;
    } finally {
      const finishedAtMs = Date.now();
      runSummary.finished_at = new Date(finishedAtMs).toISOString();
      runSummary.duration_ms = finishedAtMs - startedAtMs;
      this.lastIndexUpdateSummary = cloneIndexUpdateSummary(runSummary);
      try {
        await this.persistIndexUpdateSummary(this.lastIndexUpdateSummary);
      } catch (persistError: unknown) {
        logger.warn(
          `Could not persist index update summary for ${this.modelId}: ${toError(persistError).message}`,
        );
      }
    }
  }

  /**
   * Performs a similarity search and returns the results with their similarity scores.
   * When `knowledgeBaseName` is provided, results are scoped to documents whose `source`
   * metadata lives under that KB directory; otherwise all KBs are searched.
   *
   * Issue #53 — `filters` adds three optional metadata POST-filters on top of
   * the score + KB filter that already runs here. Each filter is applied to
   * `doc.metadata` after FAISS returns; the FAISS index itself is never
   * pre-filtered (langchain's FaissStore silently drops filter args). When
   * any filter is active we over-fetch via progressive windows so a small
   * `k` doesn't starve once the post-filter drops the top-ranked unfiltered
   * hits — see `progressiveFetchSizes` (#229) for the ladder.
   *
   *   `extensions`  AND-with-existing — exact match on `metadata.extension`
   *                 (already lowercased + dotted at ingest, so ".md" works
   *                 directly; we lowercase the filter value and add a leading
   *                 dot defensively).
   *   `pathGlob`    AND-with-existing — minimatch against the KB-internal
   *                 relative path (i.e. `metadata.relativePath` with the KB
   *                 name segment stripped). This lets `"runbooks/**"` match
   *                 `<any-kb>/runbooks/onboarding.md` without forcing the
   *                 caller to know the KB name. `dot: true, nonegate: true`
   *                 mirror the ingest filter's pattern semantics.
   *   `tags`        AND semantics: every entry in the filter must be present
   *                 on `metadata.tags`. Empty filter array short-circuits.
   */
  async similaritySearch(
    query: string,
    k: number,
    threshold: number = 2,
    knowledgeBaseName?: string,
    filters?: SimilaritySearchFilters,
    timing?: SimilaritySearchTiming,
    opts: SimilaritySearchOptions = {},
  ): Promise<SearchResultDocument[]> {
    const totalStartedAt = Date.now();
    if (!this.faissIndex) {
      throw new KBError('INDEX_NOT_INITIALIZED', 'FAISS index is not initialized');
    }

    const postFilter = createSimilaritySearchPostFilter({
      threshold,
      knowledgeBasesRootDir: KNOWLEDGE_BASES_ROOT_DIR,
      knowledgeBaseName,
      filters,
    });

    // FaissStore.similaritySearchVectorWithScore accepts only (query, k) and
    // silently drops any filter argument, so threshold and KB scoping are both
    // applied as post-filters on the returned [doc, score] tuples. When the
    // wrapper exposes the vector-first entry point, embed once up front and
    // reuse the embedding across every progressive-overfetch rung so the
    // embed cost is paid exactly once. Issue #214 adds the query-embedding
    // cache at this boundary; document embedding remains untouched.
    let queryEmbeddingLookup: ReturnType<typeof queryEmbeddingCache.getOrCompute> | null = null;
    const getQueryEmbedding = (): ReturnType<typeof queryEmbeddingCache.getOrCompute> => {
      queryEmbeddingLookup ??= queryEmbeddingCache.getOrCompute({
        modelId: this.modelId,
        query,
        bypass: opts.noCache === true,
        embed: () => this.embeddings.embedQuery(query),
      });
      return queryEmbeddingLookup;
    };

    const runFaissSearch = async (
      fetchK: number,
    ): Promise<Array<[Document, number]>> => {
      return this.faissIndex!.similaritySearchUsingBestPath({
        query,
        k: fetchK,
        timing,
        getQueryEmbedding,
      });
    };
    const ntotal = this.faissIndex.totalVectors();
    const hasViewDocuments = this.getDocstoreDocuments().some(isRetrievalViewDocument);
    const viewFetchMultiplier = opts.retrievalViews !== undefined && opts.retrievalViews.length > 0
      ? Math.max(4, opts.retrievalViews.length + 1)
      : (hasViewDocuments ? 4 : 1);
    const searchK = Math.min(ntotal, Math.max(k, k * viewFetchMultiplier));
    const shapeResults = (rows: ScoredDocument[]): SearchResultDocument[] => {
      const viewFiltered = rows
        .filter(([doc]) => shouldKeepForRetrievalViews(doc, opts.retrievalViews))
        .map(([doc, score]) => ({ ...doc, score }));
      const shaped = opts.retrievalViews !== undefined && opts.retrievalViews.length > 0
        ? collapseRetrievalViewResults(viewFiltered)
        : viewFiltered;
      return shaped.slice(0, k);
    };
    const hasViewFiltering = hasViewDocuments || (opts.retrievalViews !== undefined && opts.retrievalViews.length > 0);

    if (!postFilter.requiresOverfetch) {
      // No scope or metadata filter — FAISS top-k is already the final result
      // set (threshold is a cheap drop-in post-filter). One call.
      const fetchSizes = hasViewFiltering ? progressiveFetchSizes(k, ntotal) : [k];
      let lastFetchK = k;
      let cumulativePostFilterMs = 0;
      let filtered: ScoredDocument[] = [];
      let shaped: SearchResultDocument[] = [];
      for (const fetchK of fetchSizes) {
        lastFetchK = fetchK;
        const resultsWithScore = await runFaissSearch(fetchK);
        const postFilterStartedAt = Date.now();
        filtered = postFilter.apply(resultsWithScore);
        cumulativePostFilterMs += Date.now() - postFilterStartedAt;
        shaped = shapeResults(filtered);
        if (shaped.length >= k) break;
        if (resultsWithScore.length < fetchK) break;
      }
      if (timing) {
        timing.fetch_k = lastFetchK;
        timing.post_filter_ms = cumulativePostFilterMs;
        timing.post_filter_kept = filtered.length;
        timing.total_ms = Date.now() - totalStartedAt;
      }
      return shaped;
    }

    // Issue #283 — predicate-pushdown fast-path. When a metadata-aware
    // filter is active and the per-model sidecar matches the live docstore
    // we use it to:
    //   (a) short-circuit to an empty result when no row matches (no FAISS
    //       call at all),
    //   (b) pick a single FAISS fetchK targeted at the filter selectivity
    //       so common 1%-class filters terminate in one search instead of
    //       walking the [20, 4k, 16k, ntotal] ladder.
    // The post-filter still runs on the FAISS results for correctness:
    // sidecar candidates only narrow how MANY vectors we ask FAISS for,
    // they do not bypass the post-filter.
    const sidecarFilter = toSidecarFilter({
      knowledgeBaseName,
      knowledgeBasesRootDir: KNOWLEDGE_BASES_ROOT_DIR,
      filters,
    });
    const sidecar = await this.loadMetadataSidecar();
    let cumulativePostFilterMs = 0;
    let filtered: ScoredDocument[] = [];

    if (sidecar !== null && sidecar.hasFilter(sidecarFilter)) {
      const candidates = sidecar.candidateIds(sidecarFilter);
      if (timing) timing.sidecar_candidates = candidates.length;
      if (candidates.length === 0) {
        if (timing) {
          timing.sidecar_fast_path = 'short_circuit';
          timing.fetch_k = 0;
          timing.post_filter_ms = 0;
          timing.post_filter_kept = 0;
          timing.total_ms = Date.now() - totalStartedAt;
        }
        return [];
      }
      const fastFetchK = recommendFastPathFetchK({
        k: searchK,
        candidates: candidates.length,
        ntotal,
      });
      if (fastFetchK !== null) {
        const resultsWithScore = await runFaissSearch(fastFetchK);
        const postFilterStartedAt = Date.now();
        filtered = postFilter.apply(resultsWithScore);
        cumulativePostFilterMs += Date.now() - postFilterStartedAt;
        const shaped = shapeResults(filtered);
        const fastPathSatisfied =
          (hasViewFiltering ? shaped.length >= k : filtered.length >= searchK) ||
          resultsWithScore.length < fastFetchK;
        if (fastPathSatisfied) {
          if (timing) {
            timing.fetch_k = fastFetchK;
            timing.post_filter_ms = cumulativePostFilterMs;
            timing.post_filter_kept = filtered.length;
            timing.sidecar_fast_path = 'hit';
            timing.total_ms = Date.now() - totalStartedAt;
          }
          return shaped;
        }
        if (timing) timing.sidecar_fast_path = 'miss_underflow';
      } else if (timing) {
        timing.sidecar_fast_path = 'unused';
      }
    } else if (timing) {
      timing.sidecar_fast_path = sidecar === null ? 'missing' : 'unused';
    }

    // Issue #229 — progressive overfetch. Walk increasing fetch windows and
    // stop as soon as the post-filter yields at least `k` hits, or FAISS has
    // already returned its entire docstore (raw length below the requested
    // window ⇒ ntotal exhausted). Worst case ends at `ntotal` and matches
    // the pre-#229 cost; common filtered queries terminate at the first rung.
    const fetchSizes = progressiveFetchSizes(searchK, ntotal);
    let lastFetchK = searchK;
    let shaped: SearchResultDocument[] = [];
    for (const fetchK of fetchSizes) {
      lastFetchK = fetchK;
      const resultsWithScore = await runFaissSearch(fetchK);
      const postFilterStartedAt = Date.now();
      filtered = postFilter.apply(resultsWithScore);
      cumulativePostFilterMs += Date.now() - postFilterStartedAt;
      shaped = shapeResults(filtered);
      if (hasViewFiltering ? shaped.length >= k : filtered.length >= searchK) break;
      if (resultsWithScore.length < fetchK) break;
    }
    if (timing) {
      timing.fetch_k = lastFetchK;
      timing.post_filter_ms = cumulativePostFilterMs;
      timing.post_filter_kept = filtered.length;
      timing.total_ms = Date.now() - totalStartedAt;
    }

    return shaped.length > 0 ? shaped : shapeResults(filtered);
  }

  expandWithNeighborContext(
    results: readonly SearchResultDocument[],
    options: NeighborContextOptions,
  ): SearchResultDocument[] {
    const normalized = normalizeNeighborContextOptions(options);
    if (normalized.before === 0 && normalized.after === 0) {
      return [...results];
    }
    if (!this.faissIndex || results.length === 0) {
      return results.map(markSemanticResult);
    }

    const docs = this.getDocstoreDocuments();
    if (docs.length === 0) {
      return results.map(markSemanticResult);
    }

    const byKey = new Map<string, Document>();
    for (const doc of docs) {
      const identity = chunkIdentity(doc);
      if (identity) byKey.set(identity.key, doc);
    }

    const semanticKeys = new Set<string>();
    for (const result of results) {
      const identity = chunkIdentity(result);
      if (identity) semanticKeys.add(identity.key);
    }

    const usedContextKeys = new Set<string>();
    let contextCount = 0;
    let capReached = false;

    return results.map((result) => {
      const semantic = markSemanticResult(result);
      const identity = chunkIdentity(result);
      if (!identity) return semantic;

      const contextChunks: NeighborContextChunk[] = [];
      const addContext = (chunkIndex: number, direction: 'before' | 'after'): void => {
        const key = chunkKey(identity.knowledgeBase, identity.source, chunkIndex);
        if (semanticKeys.has(key) || usedContextKeys.has(key)) return;
        const doc = byKey.get(key);
        if (!doc) return;
        if (contextCount >= normalized.maxContextChunks) {
          capReached = true;
          return;
        }
        usedContextKeys.add(key);
        contextCount += 1;
        contextChunks.push({
          ...doc,
          matchType: 'context',
          semanticMatch: false,
          contextDirection: direction,
          contextDistance: Math.abs(chunkIndex - identity.chunkIndex),
        });
      };

      for (let i = normalized.before; i >= 1; i -= 1) {
        addContext(identity.chunkIndex - i, 'before');
      }
      for (let i = 1; i <= normalized.after; i += 1) {
        addContext(identity.chunkIndex + i, 'after');
      }

      return {
        ...semantic,
        ...(contextChunks.length > 0 ? { contextChunks } : {}),
        ...(capReached ? { contextTruncated: true } : {}),
      };
    });
  }

  findChunkByReference(reference: ChunkReference): Document | null {
    if (!this.faissIndex) {
      throw new KBError('INDEX_NOT_INITIALIZED', 'FAISS index is not initialized');
    }
    const docs = this.getDocstoreDocuments();
    for (const doc of docs) {
      if (documentMatchesReference(doc, reference)) {
        return { ...doc };
      }
    }
    return null;
  }

  /**
   * Issue #54 — observability snapshot for the kb_stats MCP tool.
   *
   * Returns a lightweight, read-only view of the loaded FAISS store: total
   * chunk count (= `index.ntotal()`), vector dimension (= `index.getDimension()`),
   * and per-KB chunk counts grouped by `metadata.knowledgeBase`.
   *
   * Per-KB counts are derived from the in-memory docstore at call time rather
   * than tracked as the index mutates. Reasons: the docstore is the single
   * source of truth post-load, so counts can't drift after a fallback rebuild
   * or a restart; the cost is O(n) over the docstore and `kb_stats` is rare.
   *
   * Pre-load (faissIndex === null): returns zeros and dim=null. The caller
   * still has useful data via per-KB file walks + sidecar mtimes.
   */
  getStats(): {
    totalChunks: number;
    chunkCountsByKb: Record<string, number>;
    dim: number | null;
    indexType: SearchIndexType;
  } {
    if (!this.faissIndex) {
      return { totalChunks: 0, chunkCountsByKb: {}, dim: null, indexType: this.indexType };
    }
    const totalChunks = this.faissIndex.totalVectors();
    const dim = this.faissIndex.vectorDimension();
    const chunkCountsByKb = this.faissIndex.chunkCountsByKnowledgeBase();
    return { totalChunks, chunkCountsByKb, dim, indexType: this.indexType };
  }

  private getDocstoreDocuments(): Document[] {
    return this.faissIndex?.docstoreDocuments() ?? [];
  }

  /**
   * Issue #54 — resolve the path of the active `faiss.index` file used for
   * `last_updated_at`. Handles both the RFC 014 versioned layout
   * (`${modelDir}/index.vN/faiss.index` via the `index` symlink) and the
   * legacy directory (`${modelDir}/faiss.index/faiss.index`). Returns null
   * if no index has been persisted yet for this model.
   */
  async resolveActiveIndexFilePath(): Promise<string | null> {
    return resolveActiveIndexFilePathFromLayout(this.modelDir, this.indexBackend);
  }
}

function normalizeNeighborContextOptions(options: NeighborContextOptions): Required<NeighborContextOptions> {
  return {
    before: normalizeContextCount(options.before ?? 0, 'before'),
    after: normalizeContextCount(options.after ?? 0, 'after'),
    maxContextChunks: normalizeMaxContextChunks(options.maxContextChunks ?? MAX_NEIGHBOR_CONTEXT_CHUNKS),
  };
}

function normalizeContextCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NEIGHBOR_CONTEXT_WINDOW) {
    throw new KBError(
      'VALIDATION',
      `neighbor context ${name} must be an integer between 0 and ${MAX_NEIGHBOR_CONTEXT_WINDOW}`,
    );
  }
  return value;
}

function normalizeMaxContextChunks(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NEIGHBOR_CONTEXT_CHUNKS) {
    throw new KBError(
      'VALIDATION',
      `neighbor context maxContextChunks must be an integer between 0 and ${MAX_NEIGHBOR_CONTEXT_CHUNKS}`,
    );
  }
  return value;
}

function markSemanticResult(result: SearchResultDocument): SearchResultDocument {
  return {
    ...result,
    matchType: 'semantic',
    semanticMatch: true,
  };
}

function chunkIdentity(doc: Document): {
  key: string;
  knowledgeBase: string;
  source: string;
  chunkIndex: number;
} | null {
  const metadata = doc.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const sourceValue = metadata.source ?? metadata.relativePath;
  if (typeof sourceValue !== 'string' || sourceValue.length === 0) return null;
  const chunkIndexValue = metadata.chunkIndex ?? metadata.chunk_index;
  if (!Number.isInteger(chunkIndexValue)) return null;
  const knowledgeBase = typeof metadata.knowledgeBase === 'string' ? metadata.knowledgeBase : '';
  const source = sourceValue;
  const chunkIndex = chunkIndexValue as number;
  return {
    key: chunkKey(knowledgeBase, source, chunkIndex),
    knowledgeBase,
    source,
    chunkIndex,
  };
}

function chunkKey(knowledgeBase: string, source: string, chunkIndex: number): string {
  return `${knowledgeBase}\u0000${source}\u0000${chunkIndex}`;
}

function documentMatchesReference(doc: Document, reference: ChunkReference): boolean {
  const metadata = doc.metadata as Record<string, unknown> | undefined;
  if (!metadata) return false;
  const citation = buildChunkCitation(metadata, 'none');
  if (citation !== null) {
    try {
      const docReference = parseChunkReference(citation.chunk_id);
      if (!sameReferencePath(docReference, reference)) return false;
      if (reference.chunkIndex !== undefined) {
        return docReference.chunkIndex === reference.chunkIndex;
      }
      if (reference.lineFrom !== undefined) {
        return docReference.lineFrom === reference.lineFrom
          && docReference.lineTo === reference.lineTo;
      }
      return true;
    } catch {
      return false;
    }
  }
  if (reference.lineFrom !== undefined || reference.chunkIndex !== undefined) {
    return false;
  }
  // Some resource-style handles point at a whole document rather than a
  // concrete chunk range. In that case, fall back to the indexed metadata path
  // and return the first chunk for that document instead of guessing a range.
  return metadataPathMatchesReference(metadata, reference);
}

function sameReferencePath(a: ChunkReference, b: ChunkReference): boolean {
  return a.knowledgeBase === b.knowledgeBase && a.kbRelativePath === b.kbRelativePath;
}

function metadataPathMatchesReference(
  metadata: Record<string, unknown>,
  reference: ChunkReference,
): boolean {
  const knowledgeBase = metadata.knowledgeBase;
  if (typeof knowledgeBase !== 'string' || knowledgeBase !== reference.knowledgeBase) {
    return false;
  }
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string') {
    return relativePath === reference.displayPath
      || relativePath === reference.kbRelativePath;
  }
  return false;
}
