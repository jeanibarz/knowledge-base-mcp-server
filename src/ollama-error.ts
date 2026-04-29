// Ollama embedding error translation + retry short-circuit (issue #86).
//
// `@langchain/core`'s AsyncCaller retries failed embedding calls 7 times by
// default. Its built-in defaultFailedAttemptHandler short-circuits HTTP 4xx
// via `error.status` / `error.response.status`, but the `ollama` SDK's
// ResponseError exposes the status as snake_case `status_code`, so the
// handler never sees it and we burn 7 attempts on a deterministic 400.
//
// This module returns an `onFailedAttempt` handler that:
//   1. Recognises the deterministic schema-violation classes we care about
//      (context-length overflow, generic Ollama 4xx).
//   2. Throws a KBError translated for the operator — model name + a pointer
//      at safer alternatives — which aborts p-retry on the very first attempt.
import { KBError } from './errors.js';

const CONTEXT_OVERFLOW_PATTERNS = [
  /input length exceeds the context length/i,
  /context length exceeded/i,
  /input is too long/i,
];

interface OllamaResponseErrorShape {
  status_code?: number;
  status?: number;
  response?: { status?: number };
  message?: string;
  name?: string;
}

function readStatus(err: OllamaResponseErrorShape): number | undefined {
  return err.status_code ?? err.status ?? err.response?.status;
}

export function isOllamaContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as OllamaResponseErrorShape;
  const msg = typeof e.message === 'string' ? e.message : '';
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(msg))) return true;
  // Some Ollama builds report context overflow with status 400 + a slightly
  // different phrasing; treat 400 with "context" + "length" in the message
  // as the same bucket.
  if (readStatus(e) === 400 && /context/i.test(msg) && /length/i.test(msg)) {
    return true;
  }
  return false;
}

export function isNonRetryableOllamaError(err: unknown): boolean {
  if (isOllamaContextLengthError(err)) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as OllamaResponseErrorShape;
  if (e.name !== 'ResponseError') return false;
  const status = readStatus(e);
  // Treat the langchain STATUS_NO_RETRY set (4xx schema violations,
  // not-found, auth, payment) as terminal. 408/429 stay retryable.
  if (status === undefined) return false;
  return [400, 401, 402, 403, 404, 405, 406, 407, 409].includes(status);
}

const KNOWN_LARGE_CONTEXT_OLLAMA_MODELS: { name: string; ctx: string }[] = [
  { name: 'nomic-embed-text', ctx: '8192 tokens' },
  { name: 'dengcao/Qwen3-Embedding-0.6B:Q8_0', ctx: '32K tokens' },
  { name: 'mxbai-embed-large', ctx: '512 tokens' },
];

export function translateOllamaEmbeddingError(err: unknown, model: string): KBError {
  if (isOllamaContextLengthError(err)) {
    const suggestions = KNOWN_LARGE_CONTEXT_OLLAMA_MODELS
      .map((m) => `\`${m.name}\` (${m.ctx})`)
      .join(', ');
    const message =
      `Ollama embedding model \`${model}\` rejected an input chunk as too long for ` +
      `its context window. The default chunker emits ~1000-character chunks, which ` +
      `commonly tokenize past 256 tokens — too large for small models like ` +
      `all-minilm. Switch OLLAMA_MODEL to a larger-context embedding model ` +
      `(e.g. ${suggestions}) and retry. See README → Ollama Configuration.`;
    return new KBError('VALIDATION', message, err);
  }
  // Generic non-retryable Ollama 4xx — keep the original message but tag it
  // so callers know we already decided not to retry.
  const original =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message ?? '')
      : String(err);
  return new KBError(
    'PROVIDER_UNAVAILABLE',
    `Ollama embedding request for model \`${model}\` failed with a non-retryable error: ${original}`,
    err,
  );
}

/**
 * Returns an `onFailedAttempt` handler suitable for `OllamaEmbeddings`'s
 * AsyncCaller. Throwing from this handler aborts the p-retry loop on the
 * first failed attempt, so deterministic schema violations fail fast with
 * an actionable message instead of running through 7 retries.
 */
export function makeOllamaOnFailedAttempt(
  model: string,
): (err: unknown) => void {
  return (err: unknown) => {
    if (isNonRetryableOllamaError(err)) {
      throw translateOllamaEmbeddingError(err, model);
    }
    // Other errors stay retryable — fall through (no throw) so AsyncCaller
    // continues with its exponential-backoff retry loop.
  };
}
