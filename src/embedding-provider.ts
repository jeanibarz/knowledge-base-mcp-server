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
  OLLAMA_BASE_URL,
} from './config.js';
import { KBError } from './errors.js';
import { logger } from './logger.js';
import type { EmbeddingProvider } from './model-id.js';
import { makeOllamaOnFailedAttempt } from './ollama-error.js';

export type EmbeddingsClient =
  | HuggingFaceInferenceEmbeddings
  | OllamaEmbeddings
  | OpenAIEmbeddings;

export interface CreateEmbeddingsOptions {
  provider: EmbeddingProvider;
  modelName: string;
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
