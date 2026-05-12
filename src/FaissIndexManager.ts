// FaissIndexManager.ts — RFC 013 M1+M2 (multi-model layout).
import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { Document } from "@langchain/core/documents";
import { createEmbeddingsClient, type EmbeddingsClient } from './embedding-provider.js';
import { handleFsOperationError, toError } from './error-utils.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import { buildChunkDocuments, writeSidecarHashes } from './file-ingest.js';
import { loadFile } from './loaders.js';
import {
  KNOWLEDGE_BASES_ROOT_DIR,
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  resolveIndexingBatchSize,
} from './config.js';
import {
  activeFileExists,
  computeLegacyEnvModelSpec,
  modelDir,
  modelNameFilePath,
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
  loadFaissStoreAtomic,
  resolveActiveIndexFilePath as resolveActiveIndexFilePathFromLayout,
  saveFaissStoreAtomic,
} from './faiss-store-layout.js';
import { writeFreshnessManifest } from './freshness-manifest.js';
import {
  createSimilaritySearchPostFilter,
  type ScoredDocument,
  type SimilaritySearchFilters,
} from './search-filters.js';
import { withSidecarLock } from './write-lock.js';

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

function totalFileCount(
  entries: ReadonlyArray<{ filePaths: readonly string[] }>,
): number {
  return entries.reduce((sum, entry) => sum + entry.filePaths.length, 0);
}

export interface FaissIndexManagerOptions {
  provider: EmbeddingProvider;
  modelName: string;
}

export interface IndexUpdateProgress {
  processedFiles: number;
  totalFiles: number;
  currentFile: string;
  modelId: string;
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
  phase: 'load' | 'save' | 'sidecar' | 'unknown';
  code: string | null;
  message: string;
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
  failure_count: number;
  failures: IndexUpdateFailureSummary[];
}

export interface SimilaritySearchTiming {
  embed_query_ms?: number;
  faiss_search_ms?: number;
  query_search_ms?: number;
  post_filter_ms?: number;
  total_ms?: number;
  fetch_k?: number;
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

const MAX_INDEX_UPDATE_FAILURES = 10;

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
    failure_count: 0,
    failures: [],
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

export class FaissIndexManager {
  private faissIndex: FaissStore | null = null;
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
  private lastIndexUpdateSummary: IndexUpdateSummary;

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
    this.lastIndexUpdateSummary = createNeverRunIndexUpdateSummary(this.modelId);

    // Issue #59 — embeddings are constructed lazily inside initialize() so
    // the unused providers' @langchain modules never load. API-key validation
    // moves with them; the throw still fires before any disk work.

    logger.info(`FaissIndexManager bound to ${this.modelDir} (provider=${this.embeddingProvider}, model=${this.modelName}, id=${this.modelId})`);
  }

  get hasLoadedIndex(): boolean {
    return this.faissIndex !== null;
  }

  getLastIndexUpdateSummary(): IndexUpdateSummary {
    return {
      ...this.lastIndexUpdateSummary,
      failures: this.lastIndexUpdateSummary.failures.map((failure) => ({ ...failure })),
    };
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
        await this.purgeStaleSidecars();
      }

      // Save the current model name for this model's dir. Skipped under
      // readOnly:true (RFC 012 §4.5).
      if (!readOnly) {
        try {
          await writeModelNameAtomic(this.modelNameFile, this.modelName);
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
  private async purgeStaleSidecars(): Promise<void> {
    await withSidecarLock(() => this.purgeStaleSidecarsLocked());
  }

  private async purgeStaleSidecarsLocked(): Promise<void> {
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

    if (purged.length > 0) {
      logger.warn(
        `Issue #90: FAISS store for model ${this.modelId} not found on disk but ` +
          `per-KB hash sidecars existed. Purged stale sidecars for ${purged.length} ` +
          `knowledge base(s) [${purged.join(', ')}] so the next updateIndex re-embeds. ` +
          `Common causes: manual removal of $FAISS_INDEX_PATH, partial backup restore, ` +
          `crash mid-rebuild, or model switch with the prior model's store moved aside.`,
      );
    }
    if (skippedSymlinks.length > 0) {
      logger.warn(
        `Issue #90 sidecar purge: skipped ${skippedSymlinks.length} symlinked KB entry(ies) ` +
          `[${skippedSymlinks.join(', ')}] to avoid path-escape rmrf via $KNOWLEDGE_BASES_ROOT_DIR. ` +
          `If those KBs need their sidecars cleared, run \`find <kb-target> -type d -name .index -exec rm -rf {} +\` manually.`,
      );
    }
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
  private async loadAtomic(opts: { repairCorrupt?: boolean } = {}): Promise<FaissStore | null> {
    return loadFaissStoreAtomic({
      modelDir: this.modelDir,
      modelId: this.modelId,
      embeddings: this.embeddings,
      handleFsOperationError,
      repairCorrupt: opts.repairCorrupt,
    });
  }

  /**
   * Reload the last persisted FAISS store into memory, discarding any
   * in-memory additions from a failed updateIndex run. Callers that pair this
   * with a write mutation should already hold this manager's write lock.
   */
  async reloadPersistedIndex(): Promise<void> {
    this.faissIndex = await this.loadAtomic();
  }

  /**
   * RFC 014 — atomic save via versioned dirs + symlink swap.
   *
   * PRECONDITION: caller MUST hold withWriteLock(this.modelDir). Verified
   * call sites: KnowledgeBaseServer.ts:216,374 and cli.ts:436,646. Any
   * future caller that bypasses updateIndex must wrap in withWriteLock.
   * In NODE_ENV=test we assert the lock is held via proper-lockfile.check().
   */
  private async atomicSave(): Promise<void> {
    if (!this.faissIndex) throw new Error('atomicSave called with null faissIndex');

    // PRECONDITION: caller MUST hold withWriteLock(this.modelDir). The four
    // verified call sites are KnowledgeBaseServer.ts:216,374 and
    // cli.ts:436,646. A runtime check via proper-lockfile.check() was
    // considered (RFC 014 §Risks) but proved to false-negative in tests
    // (proper-lockfile distinguishes lockfilePath args inconsistently across
    // call patterns). Documented contract + grep-able call sites is the
    // safer enforcement; future violations are caught by reviewers, not by
    // runtime assertion that itself misfires.

    this.swapCounter += 1;
    await saveFaissStoreAtomic({
      store: this.faissIndex,
      modelDir: this.modelDir,
      modelId: this.modelId,
      swapCounter: this.swapCounter,
    });
  }

  private async addDocumentsToIndex(documentsToAdd: Document[]): Promise<boolean> {
    if (documentsToAdd.length === 0) {
      return false;
    }

    for (let offset = 0; offset < documentsToAdd.length; offset += this.indexingBatchSize) {
      const batch = documentsToAdd.slice(offset, offset + this.indexingBatchSize);
      if (this.faissIndex === null) {
        logger.info(`Creating new FAISS index from ${batch.length} text(s)...`);
        this.faissIndex = await FaissStore.fromTexts(
          batch.map((doc) => doc.pageContent),
          batch.map((doc) => doc.metadata),
          this.embeddings
        );
      } else {
        await this.faissIndex.addDocuments(batch);
      }
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
    try {
      const forceReindex = opts.force === true;
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
      if (forceReindex) {
        this.faissIndex = null;
        if (scopedKnowledgeBase !== undefined) {
          logger.info(
            `Forced reindex of "${scopedKnowledgeBase}" upgraded to a global rebuild ` +
              `(FAISS deletion is unsupported; scoped rebuild would either duplicate ` +
              `vectors or drop other KBs).`,
          );
          scopedKnowledgeBase = undefined;
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
      const loaderFailurePaths = new Set<string>();

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
      const knowledgeBaseFiles = (await enumerateIngestableKbFiles(
        KNOWLEDGE_BASES_ROOT_DIR,
        ingestableKbNames,
        {
          extraExtensions: INGEST_EXTRA_EXTENSIONS,
          excludePaths: INGEST_EXCLUDE_PATHS,
        },
      )).map((entry) => ({
        knowledgeBaseName: entry.kbName,
        knowledgeBasePath: entry.kbPath,
        filePaths: entry.filePaths,
      }));

      const totalFiles = totalFileCount(knowledgeBaseFiles);
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
        });
      };

      // Process each knowledge base directory.
      const changedFileDocuments: Array<{
        filePath: string;
        indexFilePath: string;
        fileHash: string;
        documents: Document[];
      }> = [];
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
          };
        }),
      );
      const fileScanResults = await mapBounded(
        fileScanJobs,
        fsConcurrency,
        async (job) => {
          try {
            const fileHash = await calculateSHA256(job.filePath);
            let storedHash: string | null = null;
            try {
              const buffer = await fsp.readFile(job.indexFilePath);
              storedHash = buffer.toString('utf-8');
            } catch {
              // The hash file may not exist yet; that's fine.
            }
            return { ...job, success: true as const, fileHash, storedHash };
          } catch (error: unknown) {
            return { ...job, success: false as const, error };
          }
        },
      );
      for (const scan of fileScanResults) {
        anyFileProcessed = true;
        runSummary.files_scanned += 1;

        if (!scan.success) {
          logger.error(`Error reading file ${scan.filePath}:`, toError(scan.error));
          runSummary.files_skipped += 1;
          loaderFailurePaths.add(scan.filePath);
          recordFailure(scan.relativePath, 'load', scan.error);
          continue;
        }

        // If the file is new/changed, or the index itself is absent,
        // process it. The missing-index case must ignore matching sidecars:
        // otherwise a rebuild can silently omit files whose hashes were
        // already current.
        if (rebuildFromEmptyIndex || forceReindex || scan.fileHash !== scan.storedHash) {
          runSummary.files_changed += 1;
          logger.info(
            rebuildFromEmptyIndex
              ? `FAISS index is empty. Rebuilding from ${scan.filePath}...`
              : forceReindex
                ? `Force re-indexing ${scan.filePath}...`
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
            logger.error(`Error loading file ${scan.filePath}:`, toError(error));
            runSummary.files_skipped += 1;
            loaderFailurePaths.add(scan.filePath);
            recordFailure(scan.relativePath, 'load', error);
            continue;
          }

          const documentsToAdd: Document[] = await buildChunkDocuments(
            scan.filePath,
            content,
            scan.knowledgeBaseName,
          );
          runSummary.chunks_attempted += documentsToAdd.length;

          if (documentsToAdd.length > 0) {
            changedFileDocuments.push({
              filePath: scan.filePath,
              indexFilePath: scan.indexFilePath,
              fileHash: scan.fileHash,
              documents: documentsToAdd,
            });
          } else {
            logger.debug(`No documents generated from ${scan.filePath}. Skipping index update.`);
          }
        } else {
          runSummary.files_unchanged += 1;
          logger.debug(`File ${scan.filePath} unchanged, skipping.`);
        }
      }
      const documentsToAdd = changedFileDocuments.flatMap((entry) => entry.documents);
      if (await this.addDocumentsToIndex(documentsToAdd)) {
        indexMutated = true;
        runSummary.index_mutated = true;
        runSummary.chunks_added += documentsToAdd.length;
        for (const entry of changedFileDocuments) {
          pendingHashWrites.push({ path: entry.indexFilePath, hash: entry.fileHash });
          logger.debug(`Index updated in-memory for ${entry.filePath}.`);
          processedFiles += 1;
          await reportProgress(entry.filePath);
        }
      }

      // If at least one file was processed but no changes triggered index creation,
      // then attempt to build the FAISS index from all available documents.
      if (this.faissIndex === null && anyFileProcessed) {
        logger.info('No updates detected but FAISS index is not initialized. Building index from all available documents...');
        const fallbackDocuments: Array<{ filePath: string; documents: Document[] }> = [];
        for (const { knowledgeBaseName, knowledgeBasePath, filePaths } of knowledgeBaseFiles) {
          for (const filePath of filePaths) {
            // Issue #46 — same extension-routed loader as the per-file path.
            let content = '';
            try {
              content = await loadFile(filePath);
            } catch (error: unknown) {
              logger.error(`Error loading file ${filePath}:`, toError(error));
              if (!loaderFailurePaths.has(filePath)) {
                runSummary.files_skipped += 1;
                recordFailure(path.relative(knowledgeBasePath, filePath), 'load', error);
              }
              continue;
            }
            const documents = await buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName,
            );
            runSummary.chunks_attempted += documents.length;
            if (documents.length > 0) {
              fallbackDocuments.push({ filePath, documents });
            }
          }
        }
        if (await this.addDocumentsToIndex(fallbackDocuments.flatMap((entry) => entry.documents))) {
          indexMutated = true;
          runSummary.index_mutated = true;
          runSummary.chunks_added += fallbackDocuments.reduce(
            (sum, entry) => sum + entry.documents.length,
            0,
          );
          for (const entry of fallbackDocuments) {
            processedFiles += 1;
            await reportProgress(entry.filePath);
          }
        }
      }

      if (indexMutated && this.faissIndex !== null) {
        // RFC 014 — atomicSave writes to a versioned `index.vN/` and swaps
        // the `index` symlink atomically. The legacy `faiss.index/` directory
        // (if present from a pre-RFC-014 install) is intentionally NOT
        // updated; first save under v014 effectively migrates the model to
        // versioned layout.
        try {
          await this.atomicSave();
          runSummary.saved = true;
        } catch (saveError: unknown) {
          recordFailure(null, 'save', saveError);
          handleFsOperationError(
            'save FAISS index for model',
            this.modelId,
            saveError,
          );
        }
        // Sidecar hashes are written only after the index has persisted so
        // we never claim a hash for vectors that never landed on disk.
        // `writeSidecarHashes` runs the batch under `withSidecarLock` so a
        // concurrent model's `purgeStaleSidecars` cannot rmrf
        // `<kb>/.index/` between our pre-loop `mkdir` and `rename` (issue
        // #90 follow-up). A crash between save() and every rename
        // completing will re-embed the unhashed files on next start,
        // duplicating their vectors until RFC 007 PR 2.1 lands the
        // pending-manifest protocol.
        try {
          await writeSidecarHashes(pendingHashWrites);
          runSummary.sidecars_written = pendingHashWrites.length > 0;
        } catch (sidecarError: unknown) {
          recordFailure(null, 'sidecar', sidecarError);
          throw sidecarError;
        }
      }
      try {
        const activeIndexFilePath = await this.resolveActiveIndexFilePath();
        if (activeIndexFilePath !== null) {
          const indexStat = await fsp.stat(activeIndexFilePath);
          await writeFreshnessManifest({
            modelId: this.modelId,
            modelDir: this.modelDir,
            indexMtimeMs: indexStat.mtimeMs,
          });
        }
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
      this.lastIndexUpdateSummary = {
        ...runSummary,
        failures: runSummary.failures.map((failure) => ({ ...failure })),
      };
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
    // caller wants timing AND the wrapper exposes the vector-first entry
    // point, embed once up front and reuse the embedding across every
    // progressive-overfetch rung so the embed cost is paid exactly once.
    const vectorSearch = (
      this.faissIndex as unknown as {
        similaritySearchVectorWithScore?: (
          queryEmbedding: number[],
          k: number,
        ) => Promise<Array<[Document, number]>>;
      }
    ).similaritySearchVectorWithScore;
    const useVectorPath = timing !== undefined && typeof vectorSearch === 'function';
    let queryEmbedding: number[] | undefined;
    if (useVectorPath) {
      const embedStartedAt = Date.now();
      queryEmbedding = await this.embeddings.embedQuery(query);
      timing!.embed_query_ms = Date.now() - embedStartedAt;
    }

    const runFaissSearch = async (
      fetchK: number,
    ): Promise<Array<[Document, number]>> => {
      if (useVectorPath) {
        const faissStartedAt = Date.now();
        const out = await vectorSearch!.call(this.faissIndex, queryEmbedding!, fetchK);
        timing!.faiss_search_ms = (timing!.faiss_search_ms ?? 0) + (Date.now() - faissStartedAt);
        return out;
      }
      const queryStartedAt = Date.now();
      const out = await this.faissIndex!.similaritySearchWithScore(query, fetchK);
      if (timing) {
        timing.query_search_ms = (timing.query_search_ms ?? 0) + (Date.now() - queryStartedAt);
      }
      return out;
    };

    if (!postFilter.requiresOverfetch) {
      // No scope or metadata filter — FAISS top-k is already the final result
      // set (threshold is a cheap drop-in post-filter). One call.
      if (timing) timing.fetch_k = k;
      const resultsWithScore = await runFaissSearch(k);
      const postFilterStartedAt = Date.now();
      const filtered = postFilter.apply(resultsWithScore);
      if (timing) {
        timing.post_filter_ms = Date.now() - postFilterStartedAt;
        timing.total_ms = Date.now() - totalStartedAt;
      }
      return filtered.slice(0, k).map(([doc, score]) => ({ ...doc, score }));
    }

    // Issue #229 — progressive overfetch. Walk increasing fetch windows and
    // stop as soon as the post-filter yields at least `k` hits, or FAISS has
    // already returned its entire docstore (raw length below the requested
    // window ⇒ ntotal exhausted). Worst case ends at `ntotal` and matches
    // the pre-#229 cost; common filtered queries terminate at the first rung.
    const ntotal = this.faissIndex.index.ntotal();
    const fetchSizes = progressiveFetchSizes(k, ntotal);
    let filtered: ScoredDocument[] = [];
    let lastFetchK = k;
    let cumulativePostFilterMs = 0;
    for (const fetchK of fetchSizes) {
      lastFetchK = fetchK;
      const resultsWithScore = await runFaissSearch(fetchK);
      const postFilterStartedAt = Date.now();
      filtered = postFilter.apply(resultsWithScore);
      cumulativePostFilterMs += Date.now() - postFilterStartedAt;
      if (filtered.length >= k) break;
      if (resultsWithScore.length < fetchK) break;
    }
    if (timing) {
      timing.fetch_k = lastFetchK;
      timing.post_filter_ms = cumulativePostFilterMs;
      timing.total_ms = Date.now() - totalStartedAt;
    }

    return filtered.slice(0, k).map(([doc, score]) => ({ ...doc, score }));
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
  } {
    if (!this.faissIndex) {
      return { totalChunks: 0, chunkCountsByKb: {}, dim: null };
    }
    const totalChunks = this.faissIndex.index.ntotal();
    const dim = this.faissIndex.index.getDimension();
    const chunkCountsByKb: Record<string, number> = {};
    // SynchronousInMemoryDocstore exposes `_docs: Map<string, Document>`
    // (langchain 0.3 internal — verified against the bundled
    // node_modules/langchain/dist/stores/doc/in_memory.js). The cast
    // surfaces only the fields we touch.
    const docs = (
      this.faissIndex.docstore as unknown as {
        _docs: Map<string, { metadata?: { knowledgeBase?: unknown } }>;
      }
    )._docs;
    for (const doc of docs.values()) {
      const kb = doc.metadata?.knowledgeBase;
      if (typeof kb === 'string') {
        chunkCountsByKb[kb] = (chunkCountsByKb[kb] ?? 0) + 1;
      }
    }
    return { totalChunks, chunkCountsByKb, dim };
  }

  private getDocstoreDocuments(): Document[] {
    const docs = (
      this.faissIndex?.docstore as unknown as {
        _docs?: Map<string, Document>;
      } | undefined
    )?._docs;
    if (!(docs instanceof Map)) return [];
    return Array.from(docs.values());
  }

  /**
   * Issue #54 — resolve the path of the active `faiss.index` file used for
   * `last_updated_at`. Handles both the RFC 014 versioned layout
   * (`${modelDir}/index.vN/faiss.index` via the `index` symlink) and the
   * legacy directory (`${modelDir}/faiss.index/faiss.index`). Returns null
   * if no index has been persisted yet for this model.
   */
  async resolveActiveIndexFilePath(): Promise<string | null> {
    return resolveActiveIndexFilePathFromLayout(this.modelDir);
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
