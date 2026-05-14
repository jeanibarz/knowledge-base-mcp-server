// embedding-provider.ts — lazy construction for the active embeddings backend.
// Issue #59 — provider modules are loaded lazily inside initialize(). Each
// `@langchain/*` provider drags its full dep graph (e.g. @huggingface/inference,
// openai, ollama) at import time; eager-loading all three for a process that
// only ever uses one was ~170 ms / 81 MB peak RSS in RFC 007 §5.1.
// `import type` is erased by tsc, so the union type is preserved without any
// runtime require/resolve of the unused provider's tree.
import type { HuggingFaceInferenceEmbeddings } from '@langchain/community/embeddings/hf';
import type { InferenceProviderOrPolicy } from '@huggingface/inference';
import type { OllamaEmbeddings } from '@langchain/ollama';
import type { OpenAIEmbeddings } from '@langchain/openai';
import {
  HUGGINGFACE_ENDPOINT_URL,
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  HUGGINGFACE_PROVIDER,
  KB_FAKE_DIM,
  OLLAMA_BASE_URL,
} from './config/provider.js';
import { KBError } from './errors.js';
import { logger } from './logger.js';
import { instrumentEmbeddingsClient, type ProviderCallMetrics } from './metrics.js';
import type { EmbeddingProvider } from './model-id.js';
import { makeOllamaOnFailedAttempt } from './ollama-error.js';

/**
 * Issue #204 — deterministic, network-free embedding host. Hash-bag over a
 * fixed-dim vector, L2-normalized, pure-function. Same input → same vector
 * across runs and across machines. Public API matches the langchain
 * Embeddings interface (`embedDocuments` / `embedQuery`) so `FaissStore` can
 * consume it without any provider-specific glue.
 */
export class FakeEmbeddings {
  readonly dim: number;
  constructor(options: { dim?: number } = {}) {
    this.dim = options.dim ?? KB_FAKE_DIM;
  }
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => vectorizeFake(text, this.dim));
  }
  async embedQuery(text: string): Promise<number[]> {
    return vectorizeFake(text, this.dim);
  }
}

export type EmbeddingsClient =
  | HuggingFaceInferenceEmbeddings
  | OllamaEmbeddings
  | OpenAIEmbeddings
  | FakeEmbeddings;

export interface CreateEmbeddingsOptions {
  // Issue #204 — `'fake'` is accepted at the factory boundary but is not in
  // the strict `EmbeddingProvider` union (model-id.ts) on purpose: model-id
  // slug derivation, registered-model schema, and cost-estimates do not need
  // a new arm. Callers that already cast `EMBEDDING_PROVIDER` (active-model
  // legacy env path, model_id parsing) flow `'fake'` through unchanged.
  provider: EmbeddingProvider | 'fake';
  modelName: string;
  /**
   * Issue #210 — when provided, wrap the returned client so every
   * `embedQuery`/`embedDocuments` call lands in the provider-call
   * telemetry registry under this `model_id`. Optional so legacy
   * callers and bench harnesses can opt out; `FaissIndexManager.initialize`
   * passes its own `modelId`.
   */
  modelId?: string;
  /**
   * Test-seam for the metrics registry. Production callers leave this
   * undefined so the process-wide singleton is used.
   */
  metrics?: ProviderCallMetrics;
}

/**
 * Issue #59 — dynamically imports the active provider's `@langchain/*`
 * module so cold start only pays for one provider's dep graph. Validates
 * the relevant API key first; the throw shape and message match the
 * pre-#59 constructor exactly so caller error handling is unchanged.
 */
export async function createEmbeddingsClient(
  options: CreateEmbeddingsOptions,
): Promise<EmbeddingsClient> {
  const { provider, modelName } = options;

  const client = await constructEmbeddingsClient({ provider, modelName });
  if (options.modelId !== undefined) {
    // Issue #210 — wrap once with the per-model_id telemetry collector.
    // The wrap is idempotent so a second `initialize()` (e.g.
    // corrupt-recovery in `FaissIndexManager`) does not double-count.
    instrumentEmbeddingsClient(client, options.modelId, { metrics: options.metrics });
  }
  return client;
}

async function constructEmbeddingsClient(
  options: { provider: EmbeddingProvider | 'fake'; modelName: string },
): Promise<EmbeddingsClient> {
  const { provider, modelName } = options;

  if (provider === 'fake') {
    // Issue #204 — no network, no API key, no daemon. The model name is
    // recorded for slug derivation but does not influence the vector.
    logger.info(
      `Initializing FaissIndexManager with FAKE embeddings (model: ${modelName}, dim: ${KB_FAKE_DIM}) — testing only, do not deploy`,
    );
    return new FakeEmbeddings({ dim: KB_FAKE_DIM });
  }

  if (provider === 'ollama') {
    logger.info(`Initializing FaissIndexManager with Ollama embeddings (model: ${modelName})`);
    const { OllamaEmbeddings } = await import('@langchain/ollama');
    // Issue #86 — Ollama's ResponseError uses snake_case `status_code`,
    // which langchain's default failed-attempt handler doesn't recognise,
    // so deterministic 400s (e.g. "input length exceeds the context length")
    // burn 7 retries. We pass our own onFailedAttempt that short-circuits
    // those errors and rethrows them as a translated KBError.
    return new OllamaEmbeddings({
      baseUrl: OLLAMA_BASE_URL,
      model: modelName,
      onFailedAttempt: makeOllamaOnFailedAttempt(modelName),
    });
  }

  if (provider === 'openai') {
    logger.info(`Initializing FaissIndexManager with OpenAI embeddings (model: ${modelName})`);
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new KBError('PROVIDER_AUTH', 'OPENAI_API_KEY environment variable is required when using OpenAI provider');
    }
    const { OpenAIEmbeddings } = await import('@langchain/openai');
    return new OpenAIEmbeddings({
      apiKey: openaiApiKey,
      model: modelName,
    });
  }

  logger.info(`Initializing FaissIndexManager with HuggingFace embeddings (model: ${modelName})`);
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
    : `https://router.huggingface.co/hf-inference/models/${modelName}/pipeline/feature-extraction`;

  return new HuggingFaceInferenceEmbeddings({
    apiKey: huggingFaceApiKey,
    model: modelName,
    endpointUrl,
    // Issue #159 — HUGGINGFACE_PROVIDER is typed as plain `string` so
    // `config.ts` doesn't leak `@huggingface/inference`'s
    // `InferenceProviderOrPolicy` to other modules. Cast at this boundary
    // — the SDK is the right home for its own type knowledge.
    provider: HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN
      ? undefined
      : (HUGGINGFACE_PROVIDER as InferenceProviderOrPolicy),
  });
}

/**
 * Issue #204 — deterministic hash-bag vectorizer. Tokenize on
 * whitespace+punctuation, accumulate `vec[fnv1a(token) mod dim] += 1`,
 * L2-normalize, round to 6 decimals so the byte-stable property holds
 * across machines (Node's float printing is platform-stable but rounding
 * removes any last-bit ambiguity from sqrt/division).
 */
function vectorizeFake(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    vector[fnv1a(token) % dim] += 1;
  }
  let sumSq = 0;
  for (const value of vector) sumSq += value * value;
  const magnitude = sumSq === 0 ? 1 : Math.sqrt(sumSq);
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
