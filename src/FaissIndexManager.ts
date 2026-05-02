// FaissIndexManager.ts — RFC 013 M1+M2 (multi-model layout).
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import * as properLockfile from 'proper-lockfile';
// Issue #59 — provider modules are loaded lazily inside initialize(). Each
// `@langchain/*` provider drags its full dep graph (e.g. @huggingface/inference,
// openai, ollama) at import time; eager-loading all three for a process that
// only ever uses one was ~170 ms / 81 MB peak RSS in RFC 007 §5.1.
// `import type` is erased by tsc, so the union type is preserved without any
// runtime require/resolve of the unused provider's tree.
import type { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import type { OllamaEmbeddings } from "@langchain/ollama";
import type { OpenAIEmbeddings } from "@langchain/openai";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { Document } from "@langchain/core/documents";
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { toError } from './error-utils.js';
import { calculateSHA256, getFilesRecursively } from './file-utils.js';
import { parseFrontmatter } from './frontmatter.js';
import { filterIngestablePaths } from './ingest-filter.js';
import { loadFile } from './loaders.js';
import {
  EMBEDDING_PROVIDER,
  KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH,
  HUGGINGFACE_MODEL_NAME,
  HUGGINGFACE_PROVIDER,
  HUGGINGFACE_ENDPOINT_URL,
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OPENAI_MODEL_NAME,
} from './config.js';
import {
  activeFileExists,
  computeLegacyEnvDerivedId,
  modelDir,
  modelNameFilePath,
  writeActiveModelAtomic,
} from './active-model.js';
import { deriveModelId, EmbeddingProvider } from './model-id.js';
import { logger } from './logger.js';
import { KBError } from './errors.js';
import { listKnowledgeBases } from './kb-fs.js';
import { makeOllamaOnFailedAttempt } from './ollama-error.js';
import {
  loadFaissStoreAtomic,
  pathExists,
  resolveActiveIndexFilePath as resolveActiveIndexFilePathFromLayout,
  saveFaissStoreAtomic,
} from './faiss-store-layout.js';

export { nextVersionAfter } from './faiss-store-layout.js';

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

// -----------------------------------------------------------------------------
// RFC 011 §5.4 — whitelisted frontmatter lift + sibling PDF detection.
//
// `parseFrontmatter` returns the entire parsed YAML object; the server lifts
// a whitelist of known keys into a typed shape on every chunk's metadata.
// Unknown string-valued keys are collected into `frontmatter.extras` so a
// workflow author who adds a new field doesn't silently lose it — but the
// MCP-boundary sanitizer strips `extras` by default (RFC 011 §7.1 R1, wired
// in `src/KnowledgeBaseServer.ts`). Non-string-valued keys (YAML arrays or
// nested maps — FAILSAFE doesn't coerce numbers or booleans) are dropped:
// there's no safe scalar target for them here.
// -----------------------------------------------------------------------------

/** Whitelisted frontmatter keys lifted into `ChunkMetadata.frontmatter`. */
const FRONTMATTER_WHITELIST: readonly string[] = [
  'arxiv_id',
  'title',
  'authors',
  'published',
  'relevance_score',
  'ingested_at',
  'judge_method',
  'metrics_used',
  'bias_handling',
] as const;

export interface LiftedFrontmatter {
  arxiv_id?: string;
  title?: string;
  authors?: string;
  published?: string;
  relevance_score?: number;
  ingested_at?: string;
  judge_method?: string;
  metrics_used?: string;
  bias_handling?: string;
  /** Other string-valued frontmatter keys (e.g. workflow-specific additions). */
  extras?: Record<string, string>;
}

/**
 * Applies the RFC 011 §5.4.2 whitelist to `parseFrontmatter`'s raw object.
 * Returns `undefined` when the input yields no fields — absent metadata is
 * preferable to an empty object at the wire boundary.
 */
export function liftFrontmatter(
  frontmatter: Record<string, unknown>,
  filePath: string,
): LiftedFrontmatter | undefined {
  const lifted: LiftedFrontmatter = {};
  const extras: Record<string, string> = {};
  let hasAny = false;

  for (const [key, value] of Object.entries(frontmatter)) {
    // `tags` is already lifted into the sibling `tags` metadata field;
    // don't duplicate it into the frontmatter block.
    if (key === 'tags') continue;

    // FAILSAFE parses scalars as strings and lists/maps as arrays/objects.
    // Only strings survive the lift; arrays and objects are dropped with a
    // debug log so a workflow author who wrote `metrics: [a, b, c]` sees
    // why their field disappeared.
    if (typeof value !== 'string') {
      logger.debug(`Dropping non-string frontmatter key "${key}" from ${filePath}`);
      continue;
    }

    if (key === 'relevance_score') {
      // RFC 011 §5.4.3: parseInt + isFinite; non-numeric → omit and log.
      // Log the *length* of the rejected value, never the value itself —
      // frontmatter authored by the workflow is otherwise-untrusted input,
      // and the RFC §5.4.2 leak rule for non-string keys ("key name, not
      // value") applies equally here.
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        lifted.relevance_score = parsed;
        hasAny = true;
      } else {
        logger.debug(
          `Dropping non-numeric relevance_score (length=${value.length}) from ${filePath}`,
        );
      }
      continue;
    }

    if ((FRONTMATTER_WHITELIST as readonly string[]).includes(key)) {
      (lifted as Record<string, unknown>)[key] = value;
      hasAny = true;
    } else {
      extras[key] = value;
    }
  }

  if (Object.keys(extras).length > 0) {
    lifted.extras = extras;
    hasAny = true;
  }

  return hasAny ? lifted : undefined;
}

/**
 * Looks for a PDF whose basename (without extension) matches the `.md` file
 * at `filePath`. Checks (in order) the arxiv `<kb>/pdfs/<stem>.pdf` layout,
 * then the same-directory `<stem>.pdf` fallback. Returns the KB-directory-
 * relative forward-slash path, or `undefined` when no sibling exists.
 *
 * Uses sync `existsSync` deliberately: called once per file inside an
 * already-`await`-heavy ingest loop; an extra async boundary is not worth
 * the 1-stat-per-file cost.
 */
export function detectSiblingPdfPath(
  filePath: string,
  knowledgeBaseName: string,
): string | undefined {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const kbRoot = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);

  // Returns a KB-directory-scoped forward-slash path, or undefined if
  // `candidate` escapes the KB root (e.g. the arxiv layout's `../pdfs/`
  // probe for a `.md` at the KB root resolves outside the KB — `pdf_path`
  // on a chunk must not reference a sibling KB's files).
  const toKbRelative = (candidate: string): string | undefined => {
    const rel = path.relative(kbRoot, candidate).split(path.sep).join('/');
    if (rel.length === 0 || rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) {
      return undefined;
    }
    return rel;
  };

  // arxiv layout: notes/<stem>.md next to pdfs/<stem>.pdf
  const arxivCandidate = path.join(dir, '..', 'pdfs', `${stem}.pdf`);
  if (fs.existsSync(arxivCandidate)) {
    const rel = toKbRelative(arxivCandidate);
    if (rel !== undefined) return rel;
    // `arxivCandidate` escapes the KB (e.g. the .md lives at the KB root,
    // so `dir/../pdfs/` points at KNOWLEDGE_BASES_ROOT_DIR/pdfs — a sibling
    // directory, not a subdir of this KB). Fall through to same-dir check.
  }

  // Fallback: same-directory colocation (KBs that don't split notes/ and pdfs/)
  const sameDirCandidate = path.join(dir, `${stem}.pdf`);
  if (fs.existsSync(sameDirCandidate)) {
    const rel = toKbRelative(sameDirCandidate);
    if (rel !== undefined) return rel;
  }

  return undefined;
}

type FsError = NodeJS.ErrnoException & { code?: string };

function isPermissionError(error: unknown): error is FsError {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as FsError).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function handleFsOperationError(action: string, targetPath: string, error: unknown): never {
  const pathDescription = path.resolve(targetPath);
  const stack = (error as Error)?.stack;
  if (isPermissionError(error)) {
    const message = `Permission denied while attempting to ${action} ${pathDescription}. Grant write access and retry.`;
    logger.error(message);
    if (stack) {
      logger.error(stack);
    }
    const loggedError = new KBError('PERMISSION_DENIED', message, error) as KBError & {
      __alreadyLogged?: boolean;
    };
    loggedError.__alreadyLogged = true;
    throw loggedError;
  }
  logger.error(`Failed to ${action} ${pathDescription}:`, error);
  if (stack) {
    logger.error(stack);
  }
  if (error instanceof Error) {
    (error as Error & { __alreadyLogged?: boolean }).__alreadyLogged = true;
    throw error;
  }
  const newError = new Error(`Failed to ${action} ${pathDescription}: ${String(error)}`) as Error & {
    __alreadyLogged?: boolean;
  };
  newError.__alreadyLogged = true;
  throw newError;
}

/**
 * RFC 013 §4.8 — module-level cache for `bootstrapLayout()`. Ensures migration
 * runs at most once per Node process even when multiple FaissIndexManager
 * instances exist (tests, `kb models add` after `KnowledgeBaseServer` already
 * constructed one). Round-2 failure N1.
 */
let bootstrapPromise: Promise<void> | null = null;

const MIGRATION_LOCK_PATH = path.join(FAISS_INDEX_PATH, '.kb-migration.lock');

// Issue #90 follow-up — cross-model serialization for per-KB hash sidecar
// state at `<kb>/.index/`. Sidecars are SHARED across models (the on-disk
// shape is per-KB, not per-model), but `updateIndex` historically protected
// them with a PER-MODEL write lock. That left two concurrent windows racy:
//   1. Two models updating different KBs simultaneously: harmless overwrite
//      with the same hash bytes.
//   2. One model's `purgeStaleSidecars` (init under missing store) firing
//      while another model's `updateIndex` is mid-`Promise.all` of sidecar
//      writes: the writer's `fsp.rename(tmp, target)` ENOENTs because the
//      parent `.index/` dir was just rmrf'd by the purger.
//
// The shared lock at `${FAISS_INDEX_PATH}/.kb-sidecar.lock` serializes
// every cross-model sidecar mutation: both the purge and the post-save
// sidecar write batch acquire it briefly. The lock is held only across
// filesystem syscalls (no embedding work), so cross-model contention adds
// at most milliseconds per `updateIndex`.
const SIDECAR_LOCK_PATH = path.join(FAISS_INDEX_PATH, '.kb-sidecar.lock');

async function withSidecarLock<T>(action: () => Promise<T>): Promise<T> {
  await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
  let release: (() => Promise<void>) | null = null;
  try {
    release = await properLockfile.lock(FAISS_INDEX_PATH, {
      lockfilePath: SIDECAR_LOCK_PATH,
      stale: 30_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    });
  } catch (err) {
    // Lock acquisition exhausted retries: a peer is holding it for an
    // unusually long time, or we're on a filesystem where proper-lockfile
    // can't operate. Either way, falling through is safer than aborting:
    // the worst case (rename ENOENT from a concurrent rmrf) is recoverable
    // on the next updateIndex pass, while a hard abort poisons the caller.
    logger.warn(
      `Issue #90 sidecar lock: could not acquire ${SIDECAR_LOCK_PATH}, proceeding without serialization: ${(err as Error).message}`,
    );
  }
  try {
    return await action();
  } finally {
    if (release) {
      try { await release(); } catch { /* best-effort */ }
    }
  }
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_REBUILD_PROGRESS_INTERVAL_FILES = 10;

function totalFileCount(
  entries: ReadonlyArray<{ filePaths: readonly string[] }>,
): number {
  return entries.reduce((sum, entry) => sum + entry.filePaths.length, 0);
}

/**
 * Resolve the splitter chunk size and overlap from env vars, with the
 * historical defaults preserved when nothing is set. `KB_CHUNK_SIZE` lets
 * operators tune the splitter for short-context embedding models without
 * editing source — when `bench:compare` (#107) auto-clamps for a short-ctx
 * leg, it sets this so the production code path emits chunks small enough
 * to fit. `KB_CHUNK_OVERLAP` is honored independently when set; otherwise
 * it scales as `floor(chunkSize / 5)` so the previous 1000/200 ratio
 * (chunkSize=1000 → overlap=200) holds at the default.
 */
export function resolveChunkSize(): { chunkSize: number; chunkOverlap: number } {
  const sizeRaw = process.env.KB_CHUNK_SIZE;
  const overlapRaw = process.env.KB_CHUNK_OVERLAP;
  const sizeParsed = sizeRaw ? Number(sizeRaw) : NaN;
  const chunkSize = Number.isFinite(sizeParsed) && sizeParsed > 0 ? Math.floor(sizeParsed) : DEFAULT_CHUNK_SIZE;
  const overlapParsed = overlapRaw ? Number(overlapRaw) : NaN;
  const chunkOverlap = Number.isFinite(overlapParsed) && overlapParsed >= 0
    ? Math.floor(overlapParsed)
    : (chunkSize === DEFAULT_CHUNK_SIZE ? DEFAULT_CHUNK_OVERLAP : Math.floor(chunkSize / 5));
  return { chunkSize, chunkOverlap };
}

export class MigrationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationRefusedError';
  }
}

/**
 * RFC 013 §4.8 — auto-migrate 0.2.x single-model layout to 0.3.0 per-model
 * subtree. Idempotent: early-returns if `models/` already exists or no old
 * layout is present. Atomic per `fsp.rename`. ENOENT-tolerant for peer-races.
 *
 * Migration policy (was OQ3, promoted to RFC-level decision in v3 round-2
 * boundary F7): when `model_name.txt` is present but env is unset, trust the
 * file + `huggingface` default (config.ts:12). When `model_name.txt` is
 * MISSING (pre-RFC-012 indexes), refuse — round-1 failure F5: silently
 * deriving an id under the wrong provider creates permanent on-disk-shape bugs.
 */
async function maybeMigrateLayout(): Promise<void> {
  const oldIndexDir = path.join(FAISS_INDEX_PATH, 'faiss.index');
  const oldModelFile = path.join(FAISS_INDEX_PATH, 'model_name.txt');
  const newModelsDir = path.join(FAISS_INDEX_PATH, 'models');

  const hasOldIndex = await pathExists(oldIndexDir);
  const hasNewModels = await pathExists(newModelsDir);
  if (!hasOldIndex || hasNewModels) {
    // Cleanup: stray model_name.txt at root after a previous migration's
    // crash recovery (pseudo-code in §4.8).
    if (hasNewModels && (await pathExists(oldModelFile))) {
      logger.info(`Removing straggler ${oldModelFile} from a previous migration`);
      await fsp.unlink(oldModelFile).catch(() => {});
    }
    return;
  }

  // Pre-RFC-012 indexes — round-1 failure F5: refuse, don't silently mis-id.
  let oldModelName: string | null = null;
  try {
    oldModelName = (await fsp.readFile(oldModelFile, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (oldModelName === null || oldModelName === '') {
    throw new MigrationRefusedError(
      `Cannot determine which model built ${oldIndexDir} — model_name.txt is missing. ` +
      `Set EMBEDDING_PROVIDER + the model env vars to the values used when the index was built ` +
      `and re-run, OR delete ${oldIndexDir} and let 0.3.0 re-embed under the current env.`,
    );
  }

  const provider = (process.env.EMBEDDING_PROVIDER ?? 'huggingface') as EmbeddingProvider;
  const newModelId = deriveModelId(provider, oldModelName);
  const targetDir = path.join(newModelsDir, newModelId);
  await fsp.mkdir(targetDir, { recursive: true });

  // Two atomic renames. ENOENT-tolerant: peer process may have already moved.
  await renameIfPresent(oldIndexDir, path.join(targetDir, 'faiss.index'));
  await renameIfPresent(oldModelFile, path.join(targetDir, 'model_name.txt'));

  // Single-writer for active.txt (RFC §4.7 — bootstrap is permitted writer #1).
  await writeActiveModelAtomic(newModelId);

  logger.info(`Migrated single-model layout from ${oldIndexDir} to models/${newModelId}/`);
}

async function renameIfPresent(src: string, dst: string): Promise<void> {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Legacy constructor fallback — derive (provider, modelName) from env when no
 * args passed. Preserves 0.2.x tests + 0.2.x single-model callers that don't
 * yet thread an explicit model through. Multi-model code paths (`kb models *`,
 * `kb search --model=<id>`, MCP per-call selection) MUST use the explicit form.
 */
function resolveLegacyConstructorArgs(): FaissIndexManagerOptions {
  const provider = (EMBEDDING_PROVIDER || 'huggingface') as EmbeddingProvider;
  let modelName: string;
  switch (provider) {
    case 'ollama':
      modelName = OLLAMA_MODEL;
      break;
    case 'openai':
      modelName = OPENAI_MODEL_NAME;
      break;
    default:
      modelName = HUGGINGFACE_MODEL_NAME;
      break;
  }
  return { provider, modelName };
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

export class FaissIndexManager {
  private faissIndex: FaissStore | null = null;
  // Issue #59 — populated by initialize() via dynamic import of the active
  // provider's @langchain module. Definite-assignment-asserted because the
  // class invariant is "every method that touches embeddings runs after
  // initialize()", which holds for every call site (KnowledgeBaseServer,
  // cli.ts, every test that exercises retrieval).
  private embeddings!: HuggingFaceInferenceEmbeddings | OllamaEmbeddings | OpenAIEmbeddings;
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
    const resolved = opts ?? resolveLegacyConstructorArgs();
    this.embeddingProvider = resolved.provider;
    this.modelName = resolved.modelName;
    this.modelId = deriveModelId(resolved.provider, resolved.modelName);
    this.modelDir = modelDir(this.modelId);
    this.modelNameFile = modelNameFilePath(this.modelId);

    // Issue #59 — embeddings are constructed lazily inside initialize() so
    // the unused providers' @langchain modules never load. API-key validation
    // moves with them; the throw still fires before any disk work.

    logger.info(`FaissIndexManager bound to ${this.modelDir} (provider=${this.embeddingProvider}, model=${this.modelName}, id=${this.modelId})`);
  }

  get hasLoadedIndex(): boolean {
    return this.faissIndex !== null;
  }

  /**
   * Issue #59 — dynamically imports the active provider's `@langchain/*`
   * module so cold start only pays for one provider's dep graph. Validates
   * the relevant API key first; the throw shape and message match the
   * pre-#59 constructor exactly so caller error handling is unchanged.
   */
  private async createEmbeddings(): Promise<
    HuggingFaceInferenceEmbeddings | OllamaEmbeddings | OpenAIEmbeddings
  > {
    if (this.embeddingProvider === 'ollama') {
      logger.info(`Initializing FaissIndexManager with Ollama embeddings (model: ${this.modelName})`);
      const { OllamaEmbeddings } = await import('@langchain/ollama');
      // Issue #86 — Ollama's ResponseError uses snake_case `status_code`,
      // which langchain's default failed-attempt handler doesn't recognise,
      // so deterministic 400s (e.g. "input length exceeds the context length")
      // burn 7 retries. We pass our own onFailedAttempt that short-circuits
      // those errors and rethrows them as a translated KBError.
      return new OllamaEmbeddings({
        baseUrl: OLLAMA_BASE_URL,
        model: this.modelName,
        onFailedAttempt: makeOllamaOnFailedAttempt(this.modelName),
      });
    }
    if (this.embeddingProvider === 'openai') {
      logger.info(`Initializing FaissIndexManager with OpenAI embeddings (model: ${this.modelName})`);
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        throw new KBError('PROVIDER_AUTH', 'OPENAI_API_KEY environment variable is required when using OpenAI provider');
      }
      const { OpenAIEmbeddings } = await import('@langchain/openai');
      return new OpenAIEmbeddings({
        apiKey: openaiApiKey,
        model: this.modelName,
      });
    }
    logger.info(`Initializing FaissIndexManager with HuggingFace embeddings (model: ${this.modelName})`);
    const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY;
    if (!huggingFaceApiKey) {
      throw new KBError('PROVIDER_AUTH', 'HUGGINGFACE_API_KEY environment variable is required when using HuggingFace provider');
    }
    const { HuggingFaceInferenceEmbeddings } = await import('@langchain/community/embeddings/hf');

    // HuggingFace endpoint URL is computed from HUGGINGFACE_MODEL_NAME at
    // module load (config.ts). In the multi-model world the endpoint is
    // per-(provider+model), so for non-default models we recompute the URL
    // here. The router URL pattern is `router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction`.
    const endpointUrl = HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN
      ? HUGGINGFACE_ENDPOINT_URL
      : `https://router.huggingface.co/hf-inference/models/${this.modelName}/pipeline/feature-extraction`;

    return new HuggingFaceInferenceEmbeddings({
      apiKey: huggingFaceApiKey,
      model: this.modelName,
      endpointUrl,
      provider: HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN ? undefined : HUGGINGFACE_PROVIDER,
    });
  }

  /**
   * RFC 013 §4.8 — process-global, idempotent layout bootstrap. Runs migration
   * from 0.2.x layout to 0.3.0 per-model subtree at MOST ONCE per Node process
   * (module-level Promise cache, round-2 failure N1).
   *
   * Cross-process coordination: every caller acquires the brief
   * `.kb-migration.lock` (proper-lockfile, short retry budget) for the
   * duration of `maybeMigrateLayout`. Pre-RFC-014 the MCP server
   * piggybacked on its single-instance PID advisory; that advisory was
   * removed once atomic save (RFC 014) made it unnecessary for data
   * integrity, so MCP and CLI start paths now use the same migration-lock
   * primitive.
   */
  static async bootstrapLayout(): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      // Cross-process serializer: short-lived migration lock at
      // ${FAISS_INDEX_PATH}/.kb-migration.lock. Pre-RFC-014 the MCP server
      // would piggyback on the single-instance advisory it held for its
      // lifetime; after the advisory was removed (post-RFC-014, atomic save
      // is sufficient for data integrity), every caller acquires the
      // migration lock for the brief duration of maybeMigrateLayout.
      await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
      let release: (() => Promise<void>) | null = null;
      try {
        release = await properLockfile.lock(FAISS_INDEX_PATH, {
          lockfilePath: MIGRATION_LOCK_PATH,
          stale: 30_000,
          retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
        });
      } catch (err) {
        // If we can't get the migration lock, a peer is migrating; wait for
        // them and re-check the layout. Falling through is safe because
        // `maybeMigrateLayout` is idempotent: it creates `models/<id>/` via
        // `mkdir({recursive:true})` BEFORE the renames, so a loser arriving
        // mid-migration sees `pathExists(models/)` and early-returns; the
        // winner's renames complete unaffected. The renames also use
        // `renameIfPresent` which swallows ENOENT.
        logger.warn(`Could not acquire migration lock; assuming peer migration: ${(err as Error).message}`);
      }
      try {
        await maybeMigrateLayout();
      } finally {
        if (release) {
          try { await release(); } catch { /* best-effort */ }
        }
      }
    })();
    return bootstrapPromise;
  }

  /** Test-only: reset the bootstrap cache between tests. */
  static __resetBootstrapForTests(): void {
    bootstrapPromise = null;
  }

  /**
   * RFC 013 §4.8 — per-instance, load-only. NO migration (that's bootstrapLayout).
   * NO cross-process advisory. Cheap, called per `kb search` and per MCP
   * `handleRetrieveKnowledge`.
   *
   * RFC 012 §4.5 — `readOnly: true` skips the `model_name.txt` write so a CLI
   * can load the index without contending with a running MCP server.
   */
  async initialize(opts: { readOnly?: boolean } = {}): Promise<void> {
    try {
      // Issue #59 — lazy provider import. Idempotent: a second initialize()
      // (e.g. tests that re-call after corrupt-recovery) reuses the existing
      // embeddings client. Throws here on missing API keys, matching the
      // pre-#59 constructor's error shape.
      if (!this.embeddings) {
        this.embeddings = await this.createEmbeddings();
      }
      // Ensure this model's directory exists. mkdir-p is cheap; first-run
      // for a fresh install creates `${PATH}/models/<id>/`.
      if (!(await pathExists(this.modelDir))) {
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
      this.faissIndex = await this.loadAtomic();

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
      if (this.faissIndex === null && !opts.readOnly) {
        await this.purgeStaleSidecars();
      }

      // Save the current model name for this model's dir. Skipped under
      // readOnly:true (RFC 012 §4.5).
      if (!opts.readOnly) {
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
  private async loadAtomic(): Promise<FaissStore | null> {
    return loadFaissStoreAtomic({
      modelDir: this.modelDir,
      modelId: this.modelId,
      embeddings: this.embeddings,
      handleFsOperationError,
    });
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

  /**
   * Splits `content` into chunks and tags each chunk with the RFC 010 M1
   * metadata shape plus RFC 011 M2 additions (`frontmatter` whitelist,
   * `pdf_path` sibling detection). Frontmatter (if any) is stripped before
   * splitting so the `---` fence does not leak into the embedding text.
   *
   * Both the incremental update loop and the fallback rebuild loop call
   * this helper so the metadata shape stays identical across paths.
   */
  private async buildChunkDocuments(
    filePath: string,
    content: string,
    knowledgeBaseName: string
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
      [{ source: filePath }]
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

  private async addDocumentsToIndex(documentsToAdd: Document[]): Promise<boolean> {
    if (documentsToAdd.length === 0) {
      return false;
    }

    if (this.faissIndex === null) {
      logger.info('Creating new FAISS index from texts...');
      this.faissIndex = await FaissStore.fromTexts(
        documentsToAdd.map((doc) => doc.pageContent),
        documentsToAdd.map((doc) => doc.metadata),
        this.embeddings
      );
    } else {
      await this.faissIndex.addDocuments(documentsToAdd);
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

      const knowledgeBaseFiles: {
        knowledgeBaseName: string;
        knowledgeBasePath: string;
        filePaths: string[];
      }[] = [];

      // First enumerate every candidate path so progress notifications can
      // report a stable denominator before embedding begins.
      for (const knowledgeBaseName of knowledgeBases) {
        if (knowledgeBaseName.startsWith('.')) {
          logger.debug(`Skipping dot folder: ${knowledgeBaseName}`);
          continue;
        }
        const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
        const filePaths = filterIngestablePaths(
          await getFilesRecursively(knowledgeBasePath),
          knowledgeBasePath,
          {
            extraExtensions: INGEST_EXTRA_EXTENSIONS,
            excludePaths: INGEST_EXCLUDE_PATHS,
          },
        );
        knowledgeBaseFiles.push({ knowledgeBaseName, knowledgeBasePath, filePaths });
      }

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
      for (const { knowledgeBaseName, knowledgeBasePath, filePaths } of knowledgeBaseFiles) {
        for (const filePath of filePaths) {
          anyFileProcessed = true;

          const fileHash = await calculateSHA256(filePath);
          const relativePath = path.relative(knowledgeBasePath, filePath);
          const indexDirPath = path.join(knowledgeBasePath, '.index', path.dirname(relativePath));
          const indexFilePath = path.join(indexDirPath, path.basename(filePath));

          if (!(await pathExists(indexDirPath))) {
            try {
              await fsp.mkdir(indexDirPath, { recursive: true });
            } catch (error) {
              handleFsOperationError('create index metadata directory', indexDirPath, error);
            }
          }

          let storedHash: string | null = null;
          try {
            const buffer = await fsp.readFile(indexFilePath);
            storedHash = buffer.toString('utf-8');
          } catch (error) {
            // The hash file may not exist yet; that's fine.
          }

          // If the file is new/changed, or the index itself is absent,
          // process it. The missing-index case must ignore matching sidecars:
          // otherwise a rebuild can silently omit files whose hashes were
          // already current.
          if (rebuildFromEmptyIndex || forceReindex || fileHash !== storedHash) {
            logger.info(
              rebuildFromEmptyIndex
                ? `FAISS index is empty. Rebuilding from ${filePath}...`
                : forceReindex
                  ? `Force re-indexing ${filePath}...`
                : `File ${filePath} has changed. Updating index...`,
            );
            // Issue #46 — extension-routed loader. `.pdf` runs through
            // pdf-parse, `.html`/`.htm` through html-to-text, anything else
            // (including operator-supplied INGEST_EXTRA_EXTENSIONS like
            // `.json` or `.csv`) reads as UTF-8.
            let content = '';
            try {
              content = await loadFile(filePath);
            } catch (error: unknown) {
              logger.error(`Error loading file ${filePath}:`, toError(error));
              continue;
            }

            const documentsToAdd: Document[] = await this.buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName
            );

            if (await this.addDocumentsToIndex(documentsToAdd)) {
              indexMutated = true;
              pendingHashWrites.push({ path: indexFilePath, hash: fileHash });
              logger.debug(`Index updated in-memory for ${filePath}.`);
              processedFiles += 1;
              await reportProgress(filePath);
            } else {
              logger.debug(`No documents generated from ${filePath}. Skipping index update.`);
            }
          } else {
            logger.debug(`File ${filePath} unchanged, skipping.`);
          }
        }
      }

      // If at least one file was processed but no changes triggered index creation,
      // then attempt to build the FAISS index from all available documents.
      if (this.faissIndex === null && anyFileProcessed) {
        logger.info('No updates detected but FAISS index is not initialized. Building index from all available documents...');
        for (const { knowledgeBaseName, filePaths } of knowledgeBaseFiles) {
          for (const filePath of filePaths) {
            // Issue #46 — same extension-routed loader as the per-file path.
            let content = '';
            try {
              content = await loadFile(filePath);
            } catch (error: unknown) {
              logger.error(`Error loading file ${filePath}:`, toError(error));
              continue;
            }
            const documents = await this.buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName
            );
            if (await this.addDocumentsToIndex(documents)) {
              indexMutated = true;
              processedFiles += 1;
              await reportProgress(filePath);
            }
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
        } catch (saveError: unknown) {
          handleFsOperationError(
            'save FAISS index for model',
            this.modelId,
            saveError,
          );
        }
        // Sidecar hashes are written only after the index has persisted so we
        // never claim a hash for vectors that never landed on disk. tmp+rename
        // keeps each sidecar atomic. A crash after save() but before every
        // rename completes will re-embed the unhashed files on next start,
        // duplicating their vectors until RFC 007 PR 2.1 lands the pending
        // manifest protocol.
        //
        // Issue #90 follow-up (Codex P1) — the sidecar write batch is wrapped
        // in `withSidecarLock` so a concurrent model's `purgeStaleSidecars`
        // can't rmrf `<kb>/.index/` between our `mkdir` and `rename` and
        // ENOENT this writer. The lock is held only across the syscall
        // batch, no embedding work — cross-model contention is bounded to
        // milliseconds.
        await withSidecarLock(async () => {
          await Promise.all(
            pendingHashWrites.map(async ({ path: target, hash }) => {
              const tmpPath = `${target}.tmp`;
              try {
                // Recreate the parent if a peer purged it between the
                // pre-loop mkdir and now. mkdir({recursive:true}) is a
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
            })
          );
        });
      }
      logger.debug('FAISS index update process completed.');
    } catch (error: unknown) {
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
   * any filter is active we over-fetch up to `ntotal` so a small `k` doesn't
   * starve once the post-filter drops the top-ranked unfiltered hits.
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
    filters?: { extensions?: readonly string[]; pathGlob?: string; tags?: readonly string[] },
  ) {
    if (!this.faissIndex) {
      throw new KBError('INDEX_NOT_INITIALIZED', 'FAISS index is not initialized');
    }

    const scoped = typeof knowledgeBaseName === 'string' && knowledgeBaseName.length > 0;

    const normalizedExtensions = normalizeExtensionFilter(filters?.extensions);
    const pathGlob = filters?.pathGlob && filters.pathGlob.length > 0 ? filters.pathGlob : undefined;
    const requiredTags = filters?.tags?.filter((t): t is string => typeof t === 'string' && t.length > 0) ?? [];
    const hasMetadataFilter =
      normalizedExtensions !== undefined || pathGlob !== undefined || requiredTags.length > 0;

    // Over-fetch when scoping or when any metadata post-filter is active so
    // the post-filter doesn't starve `k` when other docs dominate the
    // unfiltered top-K. The cost (linear in ntotal) is bounded by KB size.
    const fetchK = scoped || hasMetadataFilter
      ? Math.max(k, this.faissIndex.index.ntotal())
      : k;

    // FaissStore.similaritySearchVectorWithScore accepts only (query, k) and
    // silently drops any filter argument, so threshold and KB scoping are both
    // applied as post-filters on the returned [doc, score] tuples.
    const resultsWithScore = await this.faissIndex.similaritySearchWithScore(query, fetchK);

    const kbPrefix = scoped
      ? path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName as string) + path.sep
      : undefined;

    const filtered = resultsWithScore.filter(([doc, score]) => {
      if (score > threshold) {
        return false;
      }
      const metadata = doc.metadata as Record<string, unknown> | undefined;
      if (kbPrefix) {
        const source = metadata?.source;
        if (typeof source !== 'string' || !source.startsWith(kbPrefix)) {
          return false;
        }
      }
      if (normalizedExtensions !== undefined) {
        const ext = metadata?.extension;
        if (typeof ext !== 'string' || !normalizedExtensions.has(ext.toLowerCase())) {
          return false;
        }
      }
      if (pathGlob !== undefined) {
        const rel = metadata?.relativePath;
        if (typeof rel !== 'string' || !matchesPathGlob(rel, pathGlob)) {
          return false;
        }
      }
      if (requiredTags.length > 0) {
        const tags = metadata?.tags;
        if (!Array.isArray(tags)) return false;
        const tagSet = new Set(tags.filter((x): x is string => typeof x === 'string'));
        for (const required of requiredTags) {
          if (!tagSet.has(required)) return false;
        }
      }
      return true;
    });

    return filtered.slice(0, k).map(([doc, score]) => ({
      ...doc,
      score,
    }));
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

/**
 * Issue #53 — normalize the extensions filter into a lower-cased, dot-prefixed
 * Set for O(1) lookup. Returns `undefined` when the filter is absent or empty
 * (so the caller can skip the filter entirely instead of rejecting every doc).
 * Empty/whitespace entries are dropped silently — a trailing `,` or stray
 * empty string in the user's array shouldn't cause a no-results.
 */
function normalizeExtensionFilter(raw: readonly string[] | undefined): Set<string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    out.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return out.size > 0 ? out : undefined;
}

/**
 * Issue #53 — match `pathGlob` against the KB-internal relative path.
 * `metadata.relativePath` is KNOWLEDGE_BASES_ROOT_DIR-relative (i.e.
 * `<kb-name>/path/to/file.md`). The user's glob is meant to read against the
 * in-KB path — `"runbooks/**"` should match any KB's `runbooks/foo.md` —
 * so we strip the KB-name segment and match against the rest. The full
 * KB-prefixed form is also tried as a fallback so an explicit prefix in the
 * pattern (e.g. `"my-kb/notes/**"`) still works.
 */
function matchesPathGlob(relativePath: string, pattern: string): boolean {
  const opts = { dot: true, nonegate: true } as const;
  if (minimatch(relativePath, pattern, opts)) return true;
  const firstSep = relativePath.indexOf('/');
  if (firstSep > 0) {
    const inKb = relativePath.slice(firstSep + 1);
    if (minimatch(inKb, pattern, opts)) return true;
  }
  return false;
}
