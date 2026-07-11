// Embedding provider configuration.
//
import { initializeProjectConfig } from './project-config.js';

initializeProjectConfig();

// Issue #204 - `fake` is a deterministic, offline embedding provider used by
// CI and local development. It produces hash-bag, L2-normalized vectors with
// no network, no API key, and no Ollama daemon. Whitelisted here so callers
// that validate against `KNOWN_EMBEDDING_PROVIDERS` accept it; ranking
// quality is poor by design (testing only, never deploy).
export const KNOWN_EMBEDDING_PROVIDERS = [
  'huggingface',
  'ollama',
  'openai',
  'fake',
] as const;

export type KnownEmbeddingProvider = (typeof KNOWN_EMBEDDING_PROVIDERS)[number];

export class UnknownEmbeddingProviderError extends Error {
  constructor(rawValue: string) {
    super(
      `unknown EMBEDDING_PROVIDER=${JSON.stringify(rawValue)} `
      + `(expected one of: ${KNOWN_EMBEDDING_PROVIDERS.join(', ')})`,
    );
    this.name = 'UnknownEmbeddingProviderError';
  }
}

/**
 * Issue #204 - soft validator for `EMBEDDING_PROVIDER`. Existing callers
 * cast the raw env string at use-sites, so wiring a strict throw here would
 * break boot for anyone with a typo. Callers that want enforcement
 * (`kb doctor`, future config-lint surfaces) invoke this directly; the
 * exported `EMBEDDING_PROVIDER` constant preserves pre-#204 behavior.
 */
export function parseEmbeddingProvider(raw: string | undefined): KnownEmbeddingProvider {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return 'huggingface';
  if ((KNOWN_EMBEDDING_PROVIDERS as readonly string[]).includes(trimmed)) {
    return trimmed as KnownEmbeddingProvider;
  }
  throw new UnknownEmbeddingProviderError(trimmed);
}

export function isKnownEmbeddingProvider(raw: string): raw is KnownEmbeddingProvider {
  return (KNOWN_EMBEDDING_PROVIDERS as readonly string[]).includes(raw);
}

export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'huggingface';

// Issue #204 - vector dimension for the deterministic `fake` provider.
// Defaults to 256; clamped to `[MIN, MAX]` so an operator-supplied `2` does
// not collapse the hash bag and `999999` does not balloon memory.
const DEFAULT_KB_FAKE_DIM = 256;
const MIN_KB_FAKE_DIM = 8;
const MAX_KB_FAKE_DIM = 4096;

/**
 * @internal exported only for config tests. Parses `KB_FAKE_DIM`.
 * Invalid / unset -> default 256; otherwise floored, then clamped into
 * `[MIN, MAX]`.
 */
export function parseKbFakeDim(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_KB_FAKE_DIM;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_KB_FAKE_DIM;
  return Math.max(
    MIN_KB_FAKE_DIM,
    Math.min(MAX_KB_FAKE_DIM, Math.floor(parsed)),
  );
}

export const KB_FAKE_DIM: number = parseKbFakeDim(process.env.KB_FAKE_DIM);

// RFC 013 section4.7 - per-process override for the active model. When set, takes
// precedence over `${FAISS_INDEX_PATH}/active.txt` for the lifetime of this
// process. Empty/unset = fall through to active.txt then to legacy env-var
// derivation. Slug validation (^[a-z]+__[A-Za-z0-9._-]+$) is enforced by
// active-model.ts before any path-join.
export const KB_ACTIVE_MODEL = process.env.KB_ACTIVE_MODEL || '';

// HuggingFace configuration
export const DEFAULT_HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
export const HUGGINGFACE_MODEL_NAME = process.env.HUGGINGFACE_MODEL_NAME || DEFAULT_HUGGINGFACE_MODEL_NAME;
export const DEFAULT_HUGGINGFACE_PROVIDER = 'hf-inference';
// Issue #159 - typed as plain `string` so consumers do not transitively
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

// Issue #567 — kill switch for per-role embedding task prefixes (the
// nomic-embed-text family needs `search_document: ` / `search_query: `).
// Default on. Set to `0`/`false`/`off`/`no` to keep querying an index that
// was built without prefixes (pre-#567) until it can be reindexed — mixing
// prefixed queries with unprefixed document vectors is worse than neither.
export function parseEmbeddingTaskPrefixes(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === '') return true;
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

export const KB_EMBEDDING_TASK_PREFIXES: boolean =
  parseEmbeddingTaskPrefixes(process.env.KB_EMBEDDING_TASK_PREFIXES);

// Issue #793 — per-call deadline (ms) that bounds every network
// embedding-provider call (`embedQuery`/`embedDocuments`). The embed path is
// the only network stage with no timeout, so a silently-hanging provider
// socket can stall `retrieve`/`ask`/reindex indefinitely; the deadline
// converts a hang into a `PROVIDER_TIMEOUT` the circuit breaker can record.
// Default 120s: generous enough for a cold local Ollama first-load yet
// bounded. Invalid / non-positive values fall back to the default (the call
// stays bounded — there is no "disable" escape hatch by design).
const DEFAULT_KB_EMBED_TIMEOUT_MS = 120_000;

/**
 * @internal exported only for config tests. Parses `KB_EMBED_TIMEOUT_MS`.
 * Unset / blank / non-finite / `<= 0` -> default 120000; otherwise floored.
 */
export function parseKbEmbedTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_KB_EMBED_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_KB_EMBED_TIMEOUT_MS;
  return Math.floor(parsed);
}

export const KB_EMBED_TIMEOUT_MS: number = parseKbEmbedTimeoutMs(process.env.KB_EMBED_TIMEOUT_MS);

// Ollama configuration
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'dengcao/Qwen3-Embedding-0.6B:Q8_0';

// OpenAI configuration
export const DEFAULT_OPENAI_MODEL_NAME = 'text-embedding-3-small';
export const OPENAI_MODEL_NAME = process.env.OPENAI_MODEL_NAME || DEFAULT_OPENAI_MODEL_NAME;
