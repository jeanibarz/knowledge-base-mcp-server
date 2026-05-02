import * as path from 'path';
import * as os from 'os';
import type { InferenceProviderOrPolicy } from '@huggingface/inference';

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
export const HUGGINGFACE_PROVIDER = (
  process.env.HUGGINGFACE_PROVIDER || DEFAULT_HUGGINGFACE_PROVIDER
) as InferenceProviderOrPolicy;
const HUGGINGFACE_ENDPOINT_URL_OVERRIDE = process.env.HUGGINGFACE_ENDPOINT_URL?.trim();
export const HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN = Boolean(HUGGINGFACE_ENDPOINT_URL_OVERRIDE);

// The legacy api-inference.huggingface.co endpoint that older versions of
// @huggingface/inference target has been retired in favour of the
// Inference Providers router. Route feature-extraction calls through the
// router by default; allow a full override via HUGGINGFACE_ENDPOINT_URL
// for self-hosted or Inference Endpoints deployments.
export function huggingFaceRouterUrl(model: string): string {
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
// Reindex-trigger watcher (RFC 011 §5.5).
// External workflows (e.g. the arxiv-ingestion n8n flow) signal the server
// that new content has landed by `touch`ing a dotfile at the KB root. The
// watcher polls its mtime, so a running MCP server picks up writes without
// an explicit `refresh_knowledge_base` call.
// ---------------------------------------------------------------------------

const DEFAULT_REINDEX_TRIGGER_POLL_MS = 5000;
const MIN_REINDEX_TRIGGER_POLL_MS = 1000;
const MAX_REINDEX_TRIGGER_POLL_MS = 60000;

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

// ---------------------------------------------------------------------------
// Transport configuration (RFC 008: stdio + SSE + streamable HTTP).
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'sse' | 'http';

const VALID_TRANSPORTS: readonly McpTransport[] = ['stdio', 'sse', 'http'];

export const DEFAULT_MCP_PORT = 8765;
export const DEFAULT_MCP_BIND_ADDR = '127.0.0.1';

export interface TransportConfig {
  transport: McpTransport;
  port: number;
  bindAddr: string;
  authToken?: string;
  allowedOrigins: string[];
}

export class TransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportConfigError';
  }
}

function parseTransport(raw: string | undefined): McpTransport {
  if (raw === undefined || raw === '') {
    return 'stdio';
  }
  if ((VALID_TRANSPORTS as readonly string[]).includes(raw)) {
    return raw as McpTransport;
  }
  throw new TransportConfigError(
    `Invalid MCP_TRANSPORT='${raw}'; expected one of ${VALID_TRANSPORTS.join('|')}`,
  );
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_MCP_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TransportConfigError(
      `Invalid MCP_PORT='${raw}'; expected integer in [1, 65535]`,
    );
  }
  return port;
}

/**
 * Normalize an origin string to the RFC 6454 form browsers actually send:
 * lowercased scheme + host, no path, no trailing slash. Non-default ports
 * are preserved (`:8080`); the WHATWG URL parser strips scheme-default ports
 * (`:443` on https, `:80` on http), matching browser behavior.
 * Accepts operator-friendly input like "HTTPS://App.EXAMPLE.com:8080/".
 *
 * Falls back to a plain `toLowerCase()` on strings the WHATWG URL parser
 * rejects (e.g. missing scheme). A malformed stored entry will then never
 * match a browser-sent Origin and silently behave as "deny" — which is the
 * safe direction for an allow-list. Tightening this into a hard reject is
 * tracked separately in #77's issue body.
 */
export function normalizeOrigin(origin: string): string {
  const trimmed = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  if (raw.trim() === '*') {
    throw new TransportConfigError(
      "MCP_ALLOWED_ORIGINS='*' is rejected; list explicit origins (see RFC 008 §6.4 / §7.6)",
    );
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeOrigin(entry));
}

export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const transport = parseTransport(env.MCP_TRANSPORT);
  const port = parsePort(env.MCP_PORT);
  const bindAddr = env.MCP_BIND_ADDR && env.MCP_BIND_ADDR.length > 0
    ? env.MCP_BIND_ADDR
    : DEFAULT_MCP_BIND_ADDR;
  const authToken = env.MCP_AUTH_TOKEN;
  const allowedOrigins = parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS);

  if (transport === 'sse' || transport === 'http') {
    if (!authToken || authToken.length === 0) {
      throw new TransportConfigError(
        `MCP_TRANSPORT=${transport} requires MCP_AUTH_TOKEN to be set (generate with: openssl rand -base64 32)`,
      );
    }
    // RFC 008 §6.1 / §8.1 R3: tokens shorter than 32 chars are rejected at
    // startup so operators cannot unintentionally deploy a brute-forceable
    // secret even if generation tooling truncates.
    if (authToken.length < 32) {
      throw new TransportConfigError(
        'MCP_AUTH_TOKEN must be at least 32 characters (generate with: openssl rand -base64 32)',
      );
    }
  }

  return { transport, port, bindAddr, authToken, allowedOrigins };
}
