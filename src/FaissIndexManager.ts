// FaissIndexManager.ts — RFC 013 M1+M2 (multi-model layout).
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { OllamaEmbeddings } from "@langchain/ollama";
import { OpenAIEmbeddings } from "@langchain/openai";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { Document } from "@langchain/core/documents";
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import {
  calculateSHA256,
  filterIngestablePaths,
  getFilesRecursively,
  parseFrontmatter,
} from './utils.js';
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

/**
 * RFC 013 §4.7 — atomic write for `model_name.txt`. Per-model file:
 * `${PATH}/models/<id>/model_name.txt`. Tmp+rename is atomic on POSIX.
 */
async function writeModelNameAtomic(modelNameFile: string, modelName: string): Promise<void> {
  const tmp = `${modelNameFile}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, modelName, 'utf-8');
  await fsp.rename(tmp, modelNameFile);
}

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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    const code = (error as FsError | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

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
    const loggedError = new Error(message, { cause: error instanceof Error ? error : undefined }) as Error & {
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

export class FaissIndexManager {
  private faissIndex: FaissStore | null = null;
  private embeddings: HuggingFaceInferenceEmbeddings | OllamaEmbeddings | OpenAIEmbeddings;
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

    if (this.embeddingProvider === 'ollama') {
      logger.info(`Initializing FaissIndexManager with Ollama embeddings (model: ${this.modelName})`);
      this.embeddings = new OllamaEmbeddings({
        baseUrl: OLLAMA_BASE_URL,
        model: this.modelName,
      });
    } else if (this.embeddingProvider === 'openai') {
      logger.info(`Initializing FaissIndexManager with OpenAI embeddings (model: ${this.modelName})`);
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY environment variable is required when using OpenAI provider');
      }

      this.embeddings = new OpenAIEmbeddings({
        apiKey: openaiApiKey,
        model: this.modelName,
      });
    } else {
      logger.info(`Initializing FaissIndexManager with HuggingFace embeddings (model: ${this.modelName})`);
      const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY;
      if (!huggingFaceApiKey) {
        throw new Error('HUGGINGFACE_API_KEY environment variable is required when using HuggingFace provider');
      }

      // HuggingFace endpoint URL is computed from HUGGINGFACE_MODEL_NAME at
      // module load (config.ts). In the multi-model world the endpoint is
      // per-(provider+model), so for non-default models we recompute the URL
      // here. The router URL pattern is `router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction`.
      const endpointUrl = HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN
        ? HUGGINGFACE_ENDPOINT_URL
        : `https://router.huggingface.co/hf-inference/models/${this.modelName}/pipeline/feature-extraction`;

      this.embeddings = new HuggingFaceInferenceEmbeddings({
        apiKey: huggingFaceApiKey,
        model: this.modelName,
        endpointUrl,
        provider: HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN ? undefined : HUGGINGFACE_PROVIDER,
      });
    }

    logger.info(`FaissIndexManager bound to ${this.modelDir} (provider=${this.embeddingProvider}, model=${this.modelName}, id=${this.modelId})`);
  }

  /**
   * RFC 013 §4.8 — process-global, idempotent layout bootstrap. Runs migration
   * from 0.2.x layout to 0.3.0 per-model subtree at MOST ONCE per Node process
   * (module-level Promise cache, round-2 failure N1).
   *
   * MUST be called by `KnowledgeBaseServer.run()` AFTER `acquireInstanceAdvisory()`
   * (round-1 failure F4 + delivery F6 — concurrent migrations need a lock).
   * For CLI invocations (no MCP server holds the advisory), this acquires
   * `.kb-migration.lock` (proper-lockfile, brief retry) to coordinate with
   * a peer CLI that started the migration first.
   */
  static async bootstrapLayout(opts?: { hasInstanceAdvisory?: boolean }): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      // Cross-process serializer: held by self if MCP, else short-lived migration lock.
      let release: (() => Promise<void>) | null = null;
      if (!opts?.hasInstanceAdvisory) {
        await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
        try {
          release = await properLockfile.lock(FAISS_INDEX_PATH, {
            lockfilePath: MIGRATION_LOCK_PATH,
            stale: 30_000,
            retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
          });
        } catch (err) {
          // If we can't get the migration lock, a peer is migrating; wait for
          // them and re-check the layout. Falling through is safe — the
          // pathExists guards in maybeMigrateLayout will early-return.
          logger.warn(`Could not acquire migration lock; assuming peer migration: ${(err as Error).message}`);
        }
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
      // Ensure this model's directory exists. mkdir-p is cheap; first-run
      // for a fresh install creates `${PATH}/models/<id>/`.
      if (!(await pathExists(this.modelDir))) {
        try {
          await fsp.mkdir(this.modelDir, { recursive: true });
        } catch (error) {
          handleFsOperationError('create FAISS model directory', this.modelDir, error);
        }
      }
      const indexFilePath = path.join(this.modelDir, 'faiss.index');

      // RFC 013: no model-switch wipe at initialize time. Each model has its
      // own dir; a different provider+model goes to a different `models/<id>/`.
      // The single-model wipe at lines 356-371 of the 0.2.x file was a
      // single-model artifact; multi-model dispenses with it.

      if (await pathExists(indexFilePath)) {
        logger.info('Loading existing FAISS index from:', indexFilePath);
        try {
          this.faissIndex = await FaissStore.load(indexFilePath, this.embeddings);
          logger.info(`FAISS index loaded for model ${this.modelId}.`);
        } catch (error) {
          logger.warn(
            'Existing FAISS index at',
            indexFilePath,
            'is corrupt or unreadable - rebuilding from source. Error:',
            error,
          );
          try {
            await fsp.rm(indexFilePath, { recursive: true, force: true });
          } catch (unlinkErr) {
            handleFsOperationError('delete corrupt FAISS index', indexFilePath, unlinkErr);
          }
          this.faissIndex = null;
        }
      } else {
        logger.info('FAISS index file not found at', indexFilePath, '. It will be created on the next updateIndex.');
        this.faissIndex = null;
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
    } catch (error: any) {
      if (!error?.__alreadyLogged) {
        logger.error('Error initializing FAISS index:', error);
        if (error?.stack) {
          logger.error(error.stack);
        }
      }
      throw error;
    }
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
    const splitter = ext === '.md'
      ? new MarkdownTextSplitter({
          chunkSize: 1000,
          chunkOverlap: 200,
          keepSeparator: false,
        })
      : new RecursiveCharacterTextSplitter({
          chunkSize: 1000,
          chunkOverlap: 200,
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

  /**
   * Updates the FAISS index.
   * If `specificKnowledgeBase` is provided, only files from that knowledge base will be checked and updated.
   * If no update occurs (and the FAISS index remains uninitialized) but there are documents,
   * then the index is built from all available files.
   */
  async updateIndex(specificKnowledgeBase?: string): Promise<void> {
    logger.debug('Updating FAISS index...');
    try {
      let knowledgeBases: string[] = [];
      if (specificKnowledgeBase) {
        knowledgeBases.push(specificKnowledgeBase);
      } else {
        knowledgeBases = await fsp.readdir(KNOWLEDGE_BASES_ROOT_DIR);
      }

      let anyFileProcessed = false;
      let indexMutated = false;
      const pendingHashWrites: { path: string; hash: string }[] = [];

      // Process each knowledge base directory.
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

          // If the file is new or has changed, process it.
          if (fileHash !== storedHash) {
            logger.info(`File ${filePath} has changed. Updating index...`);
            let content = '';
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error: any) {
              logger.error(`Error reading file ${filePath}:`, error);
              continue;
            }

            const documentsToAdd: Document[] = await this.buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName
            );

            if (documentsToAdd.length > 0) {
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
              indexMutated = true;
              pendingHashWrites.push({ path: indexFilePath, hash: fileHash });
              logger.debug(`Index updated in-memory for ${filePath}.`);
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
        let allDocuments: Document[] = [];
        for (const knowledgeBaseName of knowledgeBases) {
          if (knowledgeBaseName.startsWith('.')) continue;
          const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
          const filePaths = filterIngestablePaths(
            await getFilesRecursively(knowledgeBasePath),
            knowledgeBasePath,
            {
              extraExtensions: INGEST_EXTRA_EXTENSIONS,
              excludePaths: INGEST_EXCLUDE_PATHS,
            },
          );
          for (const filePath of filePaths) {
            let content = '';
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error) {
              logger.error(`Error reading file ${filePath}:`, error);
              continue;
            }
            const documents = await this.buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName
            );
            if (documents.length > 0) {
              allDocuments.push(...documents);
            }
          }
        }
        if (allDocuments.length > 0) {
          this.faissIndex = await FaissStore.fromTexts(
            allDocuments.map((doc) => doc.pageContent),
            allDocuments.map((doc) => doc.metadata),
            this.embeddings
          );
          indexMutated = true;
        }
      }

      if (indexMutated && this.faissIndex !== null) {
        const indexFileSavePath = path.join(this.modelDir, 'faiss.index');
        try {
          await this.faissIndex.save(indexFileSavePath);
          logger.info('FAISS index saved successfully to', indexFileSavePath);
        } catch (saveError: any) {
          handleFsOperationError('save FAISS index at', indexFileSavePath, saveError);
        }
        // Sidecar hashes are written only after the index has persisted so we
        // never claim a hash for vectors that never landed on disk. tmp+rename
        // keeps each sidecar atomic. A crash after save() but before every
        // rename completes will re-embed the unhashed files on next start,
        // duplicating their vectors until RFC 007 PR 2.1 lands the pending
        // manifest protocol.
        await Promise.all(
          pendingHashWrites.map(async ({ path: target, hash }) => {
            const tmpPath = `${target}.tmp`;
            try {
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
      }
      logger.debug('FAISS index update process completed.');
    } catch (error: any) {
      if (!error?.__alreadyLogged) {
        logger.error('Error updating FAISS index:', error);
        if (error?.stack) {
          logger.error(error.stack);
        }
      }
      throw error;
    }
  }

  /**
   * Performs a similarity search and returns the results with their similarity scores.
   * When `knowledgeBaseName` is provided, results are scoped to documents whose `source`
   * metadata lives under that KB directory; otherwise all KBs are searched.
   */
  async similaritySearch(query: string, k: number, threshold: number = 2, knowledgeBaseName?: string) {
    if (!this.faissIndex) {
      throw new Error('FAISS index is not initialized');
    }

    const scoped = typeof knowledgeBaseName === 'string' && knowledgeBaseName.length > 0;
    // When scoping to a KB, over-fetch up to the whole index so we can still
    // surface up to `k` same-KB hits when other KBs dominate the top of the
    // unfiltered ranking.
    const fetchK = scoped
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
      if (kbPrefix) {
        const source = (doc.metadata as { source?: unknown })?.source;
        return typeof source === 'string' && source.startsWith(kbPrefix);
      }
      return true;
    });

    return filtered.slice(0, k).map(([doc, score]) => ({
      ...doc,
      score,
    }));
  }
}
