import * as path from 'path';
import * as os from 'os';

export const KNOWLEDGE_BASES_ROOT_DIR = process.env.KNOWLEDGE_BASES_ROOT_DIR ||
  path.join(os.homedir(), 'knowledge_bases');

export const DEFAULT_FAISS_INDEX_PATH = path.join(KNOWLEDGE_BASES_ROOT_DIR, '.faiss');
export const FAISS_INDEX_PATH = process.env.FAISS_INDEX_PATH || DEFAULT_FAISS_INDEX_PATH;

// Embedding provider configuration
export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'huggingface';

// RFC 013 §4.7 — per-process override for the active model. When set, takes
// precedence over `${FAISS_INDEX_PATH}/active.txt` for the lifetime of this
// process. Empty/unset = fall through to active.txt then to legacy env-var
// derivation. Slug validation (^[a-z]+__[A-Za-z0-9._-]+$) is enforced by
// active-model.ts before any path-join.
export const KB_ACTIVE_MODEL = process.env.KB_ACTIVE_MODEL || '';

// HuggingFace configuration
export const DEFAULT_HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
export const HUGGINGFACE_MODEL_NAME = process.env.HUGGINGFACE_MODEL_NAME || DEFAULT_HUGGINGFACE_MODEL_NAME;
export const DEFAULT_HUGGINGFACE_PROVIDER = 'hf-inference';
// Issue #159 — typed as plain `string` so consumers do not transitively
// couple to `@huggingface/inference`'s `InferenceProviderOrPolicy`. The
// SDK call site in `embedding-provider.ts` casts at the boundary.
export const HUGGINGFACE_PROVIDER: string =
  process.env.HUGGINGFACE_PROVIDER || DEFAULT_HUGGINGFACE_PROVIDER;
const HUGGINGFACE_ENDPOINT_URL_OVERRIDE = process.env.HUGGINGFACE_ENDPOINT_URL?.trim();
export const HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN = Boolean(HUGGINGFACE_ENDPOINT_URL_OVERRIDE);

// The legacy api-inference.huggingface.co endpoint that older versions of
// @huggingface/inference target has been retired in favour of the
// Inference Providers router. Route feature-extraction calls through the
// router by default; allow a full override via HUGGINGFACE_ENDPOINT_URL
// for self-hosted or Inference Endpoints deployments.
function huggingFaceRouterUrl(model: string): string {
  return `https://router.huggingface.co/hf-inference/models/${model}/pipeline/feature-extraction`;
}

export const HUGGINGFACE_ENDPOINT_URL = HUGGINGFACE_ENDPOINT_URL_OVERRIDE
  || huggingFaceRouterUrl(HUGGINGFACE_MODEL_NAME);

// Ollama configuration
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'dengcao/Qwen3-Embedding-0.6B:Q8_0';

// OpenAI configuration
export const DEFAULT_OPENAI_MODEL_NAME = 'text-embedding-3-small';
export const OPENAI_MODEL_NAME = process.env.OPENAI_MODEL_NAME || DEFAULT_OPENAI_MODEL_NAME;

// ---------------------------------------------------------------------------
// Ingest filter configuration (RFC 011 §5.2.3).
// Operator-extensible extras; the base allowlist and exclusion rules in
// `src/ingest-filter.ts` are authoritative and cannot be removed through env.
// ---------------------------------------------------------------------------

function parseCommaSeparatedList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const INGEST_EXTRA_EXTENSIONS: readonly string[] = parseCommaSeparatedList(
  process.env.INGEST_EXTRA_EXTENSIONS,
);

export const INGEST_EXCLUDE_PATHS: readonly string[] = parseCommaSeparatedList(
  process.env.INGEST_EXCLUDE_PATHS,
);

// ---------------------------------------------------------------------------
// Indexing batch configuration (RFC 007 §6.2 / issue #236).
// ---------------------------------------------------------------------------

const DEFAULT_INDEXING_BATCH_SIZE = 64;
const DEFAULT_OLLAMA_INDEXING_BATCH_SIZE = 16;
const MAX_INDEXING_BATCH_SIZE = 512;

export function resolveIndexingBatchSize(
  provider: string = EMBEDDING_PROVIDER,
): number {
  const defaultForProvider = provider === 'ollama'
    ? DEFAULT_OLLAMA_INDEXING_BATCH_SIZE
    : DEFAULT_INDEXING_BATCH_SIZE;
  const raw = process.env.INDEXING_BATCH_SIZE;
  if (raw === undefined || raw.trim() === '') {
    return defaultForProvider;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultForProvider;
  }
  return Math.min(MAX_INDEXING_BATCH_SIZE, Math.max(1, Math.floor(parsed)));
}

export const INDEXING_BATCH_SIZE: number = resolveIndexingBatchSize();

// ---------------------------------------------------------------------------
// Chunking configuration (#107 follow-up).
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

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
  const chunkSize = Number.isFinite(sizeParsed) && sizeParsed > 0
    ? Math.floor(sizeParsed)
    : DEFAULT_CHUNK_SIZE;
  const overlapParsed = overlapRaw ? Number(overlapRaw) : NaN;
  const chunkOverlap = Number.isFinite(overlapParsed) && overlapParsed >= 0
    ? Math.floor(overlapParsed)
    : (chunkSize === DEFAULT_CHUNK_SIZE ? DEFAULT_CHUNK_OVERLAP : Math.floor(chunkSize / 5));
  return { chunkSize, chunkOverlap };
}

/**
 * When false (default), `frontmatter.extras` is stripped from every
 * `retrieve_knowledge` response before JSON serialization. Extras hold
 * non-whitelisted frontmatter keys; defaulting to stripped prevents a
 * workflow-author typo (e.g. `api_key: sk-…` in a note's frontmatter)
 * from leaking onto the wire. The raw value remains on the server-side
 * `Document.metadata` object for local logging. RFC 011 §7.1 R1.
 */
export const FRONTMATTER_EXTRAS_WIRE_VISIBLE: boolean =
  process.env.FRONTMATTER_EXTRAS_WIRE_VISIBLE === 'true';

// ---------------------------------------------------------------------------
// Retrieval citation output (#220).
// ---------------------------------------------------------------------------

export type KBEditorUriMode = 'vscode' | 'cursor' | 'file' | 'none';

export function parseKBEditorUri(raw: string | undefined): KBEditorUriMode {
  if (raw === undefined || raw.trim() === '') return 'none';
  const value = raw.trim().toLowerCase();
  if (value === 'vscode' || value === 'cursor' || value === 'file' || value === 'none') {
    return value;
  }
  throw new Error(`invalid KB_EDITOR_URI=${JSON.stringify(raw)} (expected vscode, cursor, file, or none)`);
}

export const KB_EDITOR_URI: KBEditorUriMode = parseKBEditorUri(process.env.KB_EDITOR_URI);

// ---------------------------------------------------------------------------
// Reindex-trigger watcher (RFC 011 §5.5).
// External workflows (e.g. the arxiv-ingestion n8n flow) signal the server
// that new content has landed by `touch`ing a dotfile at the KB root. The
// watcher polls its mtime, so a running MCP server picks up writes without
// an explicit `refresh_knowledge_base` call.
// ---------------------------------------------------------------------------

const DEFAULT_REINDEX_TRIGGER_POLL_MS = 5000;
const MIN_REINDEX_TRIGGER_POLL_MS = 1000;
const MAX_REINDEX_TRIGGER_POLL_MS = 60000;

/**
 * @internal
 *
 * Exported only so `config.test.ts` can pin the parser semantics
 * (default, sentinel, MIN/MAX clamp, scientific-notation acceptance)
 * directly. Production code uses the resolved `REINDEX_TRIGGER_POLL_MS`
 * constant below — no consumer outside the test file should import this
 * function.
 */
export function parseReindexTriggerPollMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_REINDEX_TRIGGER_POLL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_REINDEX_TRIGGER_POLL_MS;
  }
  // `0` is the documented "disabled" sentinel — accepted unchanged.
  if (parsed === 0) return 0;
  // Otherwise clamp into [MIN, MAX] so operators can't set a 50ms spin-poll
  // or a multi-hour interval that defeats the point of the watcher.
  return Math.max(
    MIN_REINDEX_TRIGGER_POLL_MS,
    Math.min(MAX_REINDEX_TRIGGER_POLL_MS, Math.round(parsed)),
  );
}

export const REINDEX_TRIGGER_POLL_MS: number = parseReindexTriggerPollMs(
  process.env.REINDEX_TRIGGER_POLL_MS,
);

/**
 * Path the reindex-trigger watcher polls. Defaults to a dotfile at the
 * KB root so it is NOT picked up by `getFilesRecursively` (which skips
 * dot-prefixed entries at `src/file-utils.ts:25-29`).
 */
export const REINDEX_TRIGGER_PATH: string =
  process.env.REINDEX_TRIGGER_PATH
  || path.join(KNOWLEDGE_BASES_ROOT_DIR, '.reindex-trigger');

// ---------------------------------------------------------------------------
// Tool description overrides (RFC 010 M2 / #52).
// Operators can repurpose the same binary for different deployments (eng
// docs vs. personal notes vs. postmortems) by overriding the model-facing
// description the agent sees during tool selection. Read once at module
// load; set the env vars BEFORE the server process starts.
// ---------------------------------------------------------------------------

export const DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION =
  'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.';
export const RETRIEVE_KNOWLEDGE_DESCRIPTION =
  process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION && process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION.length > 0
    ? process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION
    : DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION;

export const DEFAULT_LIST_KNOWLEDGE_BASES_DESCRIPTION =
  'Lists the available knowledge bases.';
export const LIST_KNOWLEDGE_BASES_DESCRIPTION =
  process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION && process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION.length > 0
    ? process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION
    : DEFAULT_LIST_KNOWLEDGE_BASES_DESCRIPTION;

// RFC 013 M3 §4.5 — list_models tool description.
export const DEFAULT_LIST_MODELS_DESCRIPTION =
  'Lists the embedding models registered for retrieval. Returns an array of {model_id, provider, model_name, active}. Use the model_id as the optional `model_name` argument to retrieve_knowledge to query a specific model instead of the active default.';
export const LIST_MODELS_DESCRIPTION =
  process.env.LIST_MODELS_DESCRIPTION && process.env.LIST_MODELS_DESCRIPTION.length > 0
    ? process.env.LIST_MODELS_DESCRIPTION
    : DEFAULT_LIST_MODELS_DESCRIPTION;

// Issue #54 — kb_stats tool description.
export const DEFAULT_KB_STATS_DESCRIPTION =
  'Reports observability stats for the knowledge base index: per-KB file_count, chunk_count, total_bytes_indexed and last_updated_at; the active embedding provider/model/dim; the on-disk index_path; and server version/uptime. Pass `knowledge_base_name` to scope to a single KB; omit it to get an entry per registered KB.';
export const KB_STATS_DESCRIPTION =
  process.env.KB_STATS_DESCRIPTION && process.env.KB_STATS_DESCRIPTION.length > 0
    ? process.env.KB_STATS_DESCRIPTION
    : DEFAULT_KB_STATS_DESCRIPTION;

// Issue #51 — MCP ingest tools.
export const ADD_DOCUMENT_DESCRIPTION =
  'Adds or overwrites a UTF-8 document in a knowledge base, creating parent directories as needed, then updates the active model index so the new content is queryable immediately.';

export const DELETE_DOCUMENT_DESCRIPTION =
  'DESTRUCTIVE: Deletes a document from a knowledge base and removes its hash sidecar. FAISS does not support vector deletion in this server, so orphan vectors for the removed file persist until a full rebuild; run reindex_knowledge_base after deletes if vector hygiene matters.';

export const REINDEX_KNOWLEDGE_BASE_DESCRIPTION =
  'Forces the active model to fully rebuild its FAISS index from on-disk files, replacing the in-memory store and clearing orphan vectors left behind by prior delete_document calls. The rebuild always covers every KB because FAISS lacks per-vector deletion; passing knowledge_base_name is accepted (and recorded in the response) but does not narrow the rebuild scope.';

// Transport configuration (RFC 008) moved to `src/transport-config.ts`
// in issue #159 — `KnowledgeBaseServer.run`, `transport/sse.ts`,
// `transport/http.ts`, and `transport/base-http-host.ts` import it
// directly.
