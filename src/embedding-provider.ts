// embedding-provider.ts — lazy construction for the active embeddings backend.
// Issue #59 — provider modules are loaded lazily inside initialize(). The
// HuggingFace provider drags its full dep graph (@huggingface/inference) at
// import time. Issue #1257 — Ollama and OpenAI-compatible providers use the
// plain-fetch clients in embedding-http-client.ts, with no SDK import at all.
// `import type` is erased by tsc, so the union type is preserved without any
// runtime require/resolve of the unused provider's tree.
import type { HuggingFaceInferenceEmbeddings } from '@langchain/community/embeddings/hf';
import type { InferenceProviderOrPolicy } from '@huggingface/inference';
import { OllamaFetchEmbeddings, OpenAIFetchEmbeddings, type EmbedCallOptions } from './embedding-http-client.js';
import {
  HUGGINGFACE_ENDPOINT_URL,
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  HUGGINGFACE_PROVIDER,
  KB_EMBED_TIMEOUT_MS,
  KB_EMBEDDING_TASK_PREFIXES,
  KB_FAKE_DIM,
  OLLAMA_BASE_URL,
  OPENAI_BASE_URL,
  OPENAI_ORG_ID,
  OPENAI_PROJECT_ID,
} from './config/provider.js';
import { resolveIndexingBatchSize } from './config/indexing.js';
import { KBError } from './errors.js';
import { logger } from './logger.js';
import { instrumentEmbeddingsClient, type ProviderCallMetrics } from './metrics-recording.js';
import type { EmbeddingProvider } from './model-id.js';
import { providerBreakerRegistry, type ProviderBreakerRegistry } from './provider-breaker.js';

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

/**
 * Issue #567 — per-role task prefixes for embedding models trained with
 * instruction prefixes. The nomic-embed-text family (v1, v1.5, v2-moe)
 * requires `search_document: <text>` at index time and
 * `search_query: <text>` at query time; embedding both roles raw lands
 * them in the wrong region of the embedding space (SciFact dense nDCG@10
 * 0.491 vs 0.669 source-BM25 in the BEIR harness).
 *
 * Issue #1047 — the Qwen3-Embedding family is instruction-aware on the QUERY
 * side only: queries carry a task instruction, documents are embedded raw
 * (model card). Its `document` prefix is therefore empty, which leaves
 * document text byte-identical, so existing Qwen3 indexes stay valid and need
 * no reindex. The bake-off (benchmarks/results/embedding-bakeoff/) measured
 * dense nDCG@10 +0.063 SciFact, +0.116 NFCorpus, +0.001 ArguAna.
 */
export interface EmbeddingTaskPrefixes {
  query: string;
  document: string;
}

const NOMIC_TASK_PREFIXES: EmbeddingTaskPrefixes = {
  query: 'search_query: ',
  document: 'search_document: ',
};

// Exact string from the Qwen3-Embedding model card / the measured bake-off
// run: no space after `Query:` (the model card concatenates the query directly).
const QWEN3_TASK_PREFIXES: EmbeddingTaskPrefixes = {
  query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
  document: '',
};

/**
 * @internal exported for tests. Returns the per-role prefixes a model
 * requires, or `null` for models that take raw text. Matched on the
 * model-name stem so Ollama tags (`:latest`, `:v1.5`, `:Q8_0`) and HF-style
 * org paths (`nomic-ai/nomic-embed-text-v1.5`, `Qwen/Qwen3-Embedding-0.6B`)
 * are covered, and gated on `KB_EMBEDDING_TASK_PREFIXES` so an operator can
 * defer the change while a pre-#567 index (built without prefixes) is still
 * in service. `KB_EMBEDDING_TASK_PREFIXES=off` is also the rollback for the
 * Qwen3 query instruction (#1047).
 */
export function embeddingTaskPrefixesFor(
  provider: EmbeddingProvider | 'fake',
  modelName: string,
): EmbeddingTaskPrefixes | null {
  if (!KB_EMBEDDING_TASK_PREFIXES) return null;
  // The fake provider is a hash bag — a prefix would only shift tokens.
  if (provider === 'fake') return null;
  if (/(^|\/)nomic-embed-text/.test(modelName)) return NOMIC_TASK_PREFIXES;
  if (/(^|\/)qwen3-embedding/i.test(modelName)) return QWEN3_TASK_PREFIXES;
  return null;
}

/**
 * An embeddings client that may honour a per-call abort signal. The fetch
 * clients do; the LangChain HuggingFace client takes no second argument and
 * ignores it.
 */
interface SignalAwareEmbeddings {
  embedDocuments(texts: string[], options?: EmbedCallOptions): Promise<number[][]>;
  embedQuery(text: string, options?: EmbedCallOptions): Promise<number[]>;
}

/**
 * Issue #567 — wraps a provider client so every document/query embed call
 * carries its role prefix. Kept as a delegating wrapper (not a patch of the
 * inner client) so `instrumentEmbeddingsClient` can instrument it like any
 * other client and the inner provider stays untouched.
 */
export class TaskPrefixedEmbeddings {
  constructor(
    private readonly inner: SignalAwareEmbeddings,
    readonly prefixes: EmbeddingTaskPrefixes,
  ) {}

  // Call options (the TimeoutEmbeddings abort signal, #1264) pass through.
  async embedDocuments(texts: string[], options?: EmbedCallOptions): Promise<number[][]> {
    return this.inner.embedDocuments(texts.map((text) => this.prefixes.document + text), options);
  }

  async embedQuery(text: string, options?: EmbedCallOptions): Promise<number[]> {
    return this.inner.embedQuery(this.prefixes.query + text, options);
  }
}

/**
 * Issue #687 — process-shared circuit breaker wrapper for network-backed
 * embedding providers. It sits outside provider-specific clients and inside
 * telemetry, so open circuits skip provider retries while still recording a
 * failed provider call when a model_id is instrumented.
 */
export class CircuitBrokenEmbeddings {
  constructor(
    private readonly inner: {
      embedDocuments(texts: string[]): Promise<number[][]>;
      embedQuery(text: string): Promise<number[]>;
    },
    readonly breakerKey: string,
    private readonly breaker: ProviderBreakerRegistry = providerBreakerRegistry,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.breaker.run(
      this.breakerKey,
      () => this.inner.embedDocuments(texts),
      { shouldRecordFailure: shouldRecordEmbeddingBreakerFailure },
    );
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.breaker.run(
      this.breakerKey,
      () => this.inner.embedQuery(text),
      { shouldRecordFailure: shouldRecordEmbeddingBreakerFailure },
    );
  }
}

/**
 * Issue #793 — bounds every network embedding call with a per-call deadline.
 * The embed path is the only network stage with no timeout, so a
 * silently-hanging (not-erroring) provider socket can stall `retrieve`,
 * `ask`, and reindex indefinitely. This decorator sits INSIDE the circuit
 * breaker (the breaker wraps it) so an expired deadline throws
 * `KBError('PROVIDER_TIMEOUT')`, which `shouldRecordEmbeddingBreakerFailure`
 * counts as a breaker failure — making the previously-dead `PROVIDER_TIMEOUT`
 * branch reachable on the embed path.
 *
 * Cancellation: each call gets its own `AbortController`, whose signal is
 * passed to the inner client as `{ signal }`. On expiry the signal aborts, so
 * the Ollama and OpenAI-compatible fetch clients cancel the in-flight request
 * and stop retrying (#1264). The LangChain HuggingFace client ignores the
 * signal; its abandoned call runs to completion in the background.
 */
export class TimeoutEmbeddings {
  constructor(
    private readonly inner: SignalAwareEmbeddings,
    readonly timeoutMs: number,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.withDeadline('embedDocuments', (signal) => this.inner.embedDocuments(texts, { signal }));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.withDeadline('embedQuery', (signal) => this.inner.embedQuery(text, { signal }));
  }

  private async withDeadline<T>(method: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeout = new KBError(
          'PROVIDER_TIMEOUT',
          `embedding provider ${method} exceeded ${this.timeoutMs}ms deadline`,
        );
        controller.abort(timeout);
        reject(timeout);
      }, this.timeoutMs);
    });
    const inFlight = call(controller.signal);
    // If the deadline wins the race, `inFlight` is abandoned; swallow any late
    // rejection on that orphaned branch so it does not surface as an
    // unhandledRejection after we have already thrown PROVIDER_TIMEOUT.
    inFlight.catch(() => {});
    try {
      return await Promise.race([inFlight, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

export type EmbeddingsClient =
  | HuggingFaceInferenceEmbeddings
  | OllamaFetchEmbeddings
  | OpenAIFetchEmbeddings
  | FakeEmbeddings
  | TaskPrefixedEmbeddings
  | TimeoutEmbeddings
  | CircuitBrokenEmbeddings;

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

  const rawClient = await constructEmbeddingsClient({ provider, modelName });
  // Issue #567 — apply per-role task prefixes before telemetry so the
  // instrumented surface is the one production code actually calls.
  const prefixes = embeddingTaskPrefixesFor(provider, modelName);
  let client: EmbeddingsClient = rawClient;
  if (prefixes !== null) {
    logger.info(
      `Applying embedding task prefixes for ${modelName} `
      + `(documents: "${prefixes.document}", queries: "${prefixes.query}")`
      + (prefixes.document === ''
        ? ' — query-only prompt, documents unchanged, no reindex needed'
        : ' — indexes built without prefixes (pre-#567) need a reindex'),
    );
    client = new TaskPrefixedEmbeddings(rawClient, prefixes);
  }
  const breakerKey = embeddingProviderBreakerKey(provider, modelName);
  if (breakerKey !== null) {
    // Issue #793 — bound the call BEFORE the breaker wraps it, so an expired
    // deadline surfaces as PROVIDER_TIMEOUT and the breaker records it. The
    // fake provider (breakerKey === null) is offline and needs no deadline.
    client = new TimeoutEmbeddings(client, KB_EMBED_TIMEOUT_MS);
    client = new CircuitBrokenEmbeddings(client, breakerKey);
  }
  if (options.modelId !== undefined) {
    // Issue #210 — wrap once with the per-model_id telemetry collector.
    // The wrap is idempotent so a second `initialize()` (e.g.
    // corrupt-recovery in `FaissIndexManager`) does not double-count.
    instrumentEmbeddingsClient(client, options.modelId, { metrics: options.metrics });
  }
  return client;
}

export function embeddingProviderBreakerKey(
  provider: EmbeddingProvider | 'fake',
  modelName: string,
): string | null {
  if (provider === 'fake') return null;
  if (provider === 'ollama') return `embedding:ollama:${OLLAMA_BASE_URL}:${modelName}`;
  // Trailing slashes are trimmed so the same endpoint spelled with or without
  // one shares one breaker instead of minting two.
  if (provider === 'openai') return `embedding:openai:${OPENAI_BASE_URL.replace(/\/+$/, '')}/embeddings:${modelName}`;  // NOSONAR typescript:S8786 — bounded URL string, single quantifier
  const endpointUrl = HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN
    ? HUGGINGFACE_ENDPOINT_URL
    : `https://router.huggingface.co/hf-inference/models/${modelName}/pipeline/feature-extraction`;
  return `embedding:huggingface:${endpointUrl}:${modelName}`;
}

function shouldRecordEmbeddingBreakerFailure(err: unknown): boolean {
  if (err instanceof KBError) {
    return err.code === 'PROVIDER_UNAVAILABLE' || err.code === 'PROVIDER_TIMEOUT';
  }
  return true;
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
    // Issue #1257 — plain-fetch client (no @langchain/ollama import). Issue
    // #86's deterministic-400 translation (context-length overflow) lives in
    // the client via ollama-error.ts, so it still fails fast with no retries.
    return new OllamaFetchEmbeddings({
      baseUrl: OLLAMA_BASE_URL,
      model: modelName,
      batchSize: resolveIndexingBatchSize('ollama'),
    });
  }

  if (provider === 'openai') {
    logger.info(`Initializing FaissIndexManager with OpenAI embeddings (model: ${modelName})`);
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new KBError('PROVIDER_AUTH', 'OPENAI_API_KEY environment variable is required when using OpenAI provider');
    }
    // OPENAI_BASE_URL targets OpenAI-compatible endpoints (TEI, vLLM,
    // self-hosted gateways, Volcengine Ark, ...). Unset, it is the official
    // api.openai.com default. Issue #1257 — plain-fetch client.
    const extraHeaders: Record<string, string> = {};
    if (OPENAI_ORG_ID) extraHeaders['OpenAI-Organization'] = OPENAI_ORG_ID;
    if (OPENAI_PROJECT_ID) extraHeaders['OpenAI-Project'] = OPENAI_PROJECT_ID;
    return new OpenAIFetchEmbeddings({
      baseUrl: OPENAI_BASE_URL,
      model: modelName,
      apiKey: openaiApiKey,
      extraHeaders,
      batchSize: resolveIndexingBatchSize('openai'),
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
