// embedding-http-client.ts — plain-`fetch` embedding clients for Ollama and
// OpenAI-compatible servers (OpenAI, TEI, vLLM, llama-server, ...). Issue #1257.
//
// These replace `@langchain/ollama` / `@langchain/openai` on the embed path.
// The langchain wrappers only POST a JSON body and read vectors back, but
// importing them costs ~170-300 ms of cold start in a one-shot `kb search`.
// The public surface (`embedDocuments` / `embedQuery`) matches the langchain
// Embeddings interface so `FaissStore` and the provider wrappers consume these
// unchanged.
//
// Text is sent byte-for-byte: no newline stripping, trimming or client-side
// EOS token. Failures are mapped onto KBError codes; only transient ones
// (network drop, HTTP 5xx/429) are retried.
import { INDEXING_BATCH_SIZE } from './config/indexing.js';
import { KBError } from './errors.js';
import { translateOllamaEmbeddingError } from './ollama-error.js';

export interface FetchEmbeddingsOptions {
  /** Ollama: `http://127.0.0.1:11434`. OpenAI: `https://api.openai.com/v1`. Trailing slashes tolerated. */
  baseUrl: string;
  model: string;
  /** OpenAI-compatible only: sent as `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** OpenAI-compatible only: extra request headers (e.g. OpenAI-Organization, OpenAI-Project). */
  extraHeaders?: Record<string, string>;
  /** Max inputs per HTTP request. Default: INDEXING_BATCH_SIZE. */
  batchSize?: number;
  /** Retries for transient failures only. Default 5 (at most 6 attempts, about 7.75 s of backoff). */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4000;

/** Exponential backoff before retry `retry` (1-based): 250, 500, 1000, 2000, 4000 ms. */
function backoffMs(retry: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (retry - 1));
}

interface WireProtocol {
  readonly label: string;
  url(baseUrl: string): string;
  body(model: string, input: string[]): Record<string, unknown>;
  parse(json: unknown, expected: number): number[][];
  /** Error for a non-transient 4xx (401/403 are handled before this). */
  clientError(status: number, serverText: string, model: string): KBError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'number');
}

/** Rejects empty vectors and vectors of differing length within one response. */
function assertUniformVectors(label: string, vectors: number[][]): void {
  const dim = vectors[0]?.length ?? 0;
  for (const [i, v] of vectors.entries()) {
    if (v.length === 0) throw malformed(label, `vector ${i} is empty`);
    if (v.length !== dim) {
      throw malformed(label, `vector ${i} has ${v.length} dimensions, expected ${dim}`);
    }
  }
}

function malformed(label: string, detail: string): KBError {
  return new KBError('INTERNAL', `${label} embedding response malformed: ${detail}`);
}

/** Pulls a human message out of `{"error": "..."}` / `{"error": {"message": "..."}}` bodies. */
function extractServerMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const err = parsed.error;
      if (typeof err === 'string') return err;
      if (isRecord(err) && typeof err.message === 'string') return err.message;
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return text;
}

const OLLAMA_PROTOCOL: WireProtocol = {
  label: 'Ollama',
  url: (baseUrl) => `${baseUrl}/api/embed`,
  body: (model, input) => ({ model, input, truncate: false }),
  parse(json, expected) {
    const embeddings = isRecord(json) ? json.embeddings : undefined;
    if (!Array.isArray(embeddings) || !embeddings.every(isVector)) {
      throw malformed('Ollama', 'missing `embeddings` array');
    }
    if (embeddings.length !== expected) {
      throw malformed('Ollama', `expected ${expected} vectors, got ${embeddings.length}`);
    }
    assertUniformVectors('Ollama', embeddings);
    return embeddings;
  },
  clientError(status, serverText, model) {
    // Every terminal Ollama 4xx keeps the pre-#1257 translation: context-length
    // overflow becomes VALIDATION, anything else (e.g. 404 model not pulled)
    // becomes PROVIDER_UNAVAILABLE so it stays a provider-category failure.
    const message = extractServerMessage(serverText);
    return translateOllamaEmbeddingError({ status_code: status, status, message, name: 'ResponseError' }, model);
  },
};

const OPENAI_PROTOCOL: WireProtocol = {
  label: 'OpenAI-compatible',
  url: (baseUrl) => `${baseUrl}/embeddings`,
  body: (model, input) => ({ model, input, encoding_format: 'float' }),
  parse(json, expected) {
    const data = isRecord(json) ? json.data : undefined;
    if (!Array.isArray(data)) throw malformed('OpenAI-compatible', 'missing `data` array');
    if (data.length !== expected) {
      throw malformed('OpenAI-compatible', `expected ${expected} vectors, got ${data.length}`);
    }
    const ordered: (number[] | undefined)[] = new Array<number[] | undefined>(expected).fill(undefined);
    for (const item of data) {
      if (!isRecord(item) || !isVector(item.embedding)) {
        throw malformed('OpenAI-compatible', 'item without a numeric `embedding`');
      }
      const index = item.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) {
        throw malformed('OpenAI-compatible', `item has invalid index ${String(index)}`);
      }
      if (ordered[index] !== undefined) {
        throw malformed('OpenAI-compatible', `duplicate index ${index}`);
      }
      ordered[index] = item.embedding;
    }
    const vectors = ordered.map((vector, i) => {
      if (vector === undefined) throw malformed('OpenAI-compatible', `missing index ${i}`);
      return vector;
    });
    assertUniformVectors('OpenAI-compatible', vectors);
    return vectors;
  },
  clientError(status, serverText, model) {
    // 404 usually means a wrong model name or a base URL missing `/v1`: an
    // endpoint/provider problem, not a bad input.
    return new KBError(
      status === 404 ? 'PROVIDER_UNAVAILABLE' : 'VALIDATION',
      `OpenAI-compatible embedding request for model \`${model}\` failed with HTTP ${status}: ${extractServerMessage(serverText)}`,
    );
  },
};

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('embedding request aborted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class FetchEmbeddings {
  /** Normalised endpoint base (trailing slashes removed). */
  readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;

  constructor(
    private readonly protocol: WireProtocol,
    private readonly options: FetchEmbeddingsOptions,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');  // NOSONAR typescript:S8786 — bounded URL string, single quantifier
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? INDEXING_BATCH_SIZE));
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      out.push(...(await this.requestWithRetry(texts.slice(start, start + this.batchSize))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.requestWithRetry([text]);
    return vector;
  }

  private async requestWithRetry(input: string[]): Promise<number[][]> {
    const signal = this.options.signal;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(input);
      } catch (err) {
        if (signal?.aborted) throw err;
        const transient = err instanceof TransientError;
        if (!transient || attempt >= this.maxRetries) {
          throw transient ? err.kbError : err;
        }
        await sleep(backoffMs(attempt + 1), signal);
      }
    }
  }

  private async requestOnce(input: string[]): Promise<number[][]> {
    const { model, apiKey, signal } = this.options;
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    Object.assign(headers, this.options.extraHeaders);

    let response: Response;
    try {
      response = await fetchImpl(this.protocol.url(this.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(this.protocol.body(model, input)),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      throw new TransientError(new KBError(
        'PROVIDER_UNAVAILABLE',
        `${this.protocol.label} embedding request for model \`${model}\` failed: ${detail}${cause}`,
        err,
      ));
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const { status } = response;
      if (status === 401 || status === 403) {
        throw new KBError(
          'PROVIDER_AUTH',
          `${this.protocol.label} embedding request for model \`${model}\` was rejected with HTTP ${status}: ${extractServerMessage(text)}`,
        );
      }
      if (status >= 500 || status === 429 || status === 408) {
        throw new TransientError(new KBError(
          'PROVIDER_UNAVAILABLE',
          `${this.protocol.label} embedding request for model \`${model}\` failed with HTTP ${status}: ${extractServerMessage(text)}`,
        ));
      }
      throw this.protocol.clientError(status, text, model);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      if (signal?.aborted) throw err;
      throw malformed(this.protocol.label, 'body is not valid JSON');
    }
    return this.protocol.parse(json, input.length);
  }
}

/** Internal marker: a failure worth retrying. Unwrapped to `kbError` once retries are spent. */
class TransientError extends Error {
  constructor(readonly kbError: KBError) {
    super(kbError.message);
  }
}

export class OllamaFetchEmbeddings extends FetchEmbeddings {
  constructor(options: FetchEmbeddingsOptions) {
    super(OLLAMA_PROTOCOL, options);
  }
}

export class OpenAIFetchEmbeddings extends FetchEmbeddings {
  constructor(options: FetchEmbeddingsOptions) {
    super(OPENAI_PROTOCOL, options);
  }
}
