import { callFakeChatCompletion, isFakeLlmEnabled } from './llm-fake-stub.js';
import { resolveLlmProvider } from './config/llm-provider.js';
import { providerBreakerRegistry } from './provider-breaker.js';

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  endpoint: string;
  model?: string;
  messages: LlmChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  stream?: ChatCompletionStreamOptions;
  /** Retry policy for transient provider/network failures. Set to false to disable. */
  retry?: false | LlmRetryOptions;
  /**
   * Bearer API key for hosted providers (e.g. OpenRouter). When omitted it is
   * resolved from the environment via {@link resolveLlmProvider}. Sent as
   * `Authorization: Bearer <key>` and never logged.
   */
  apiKey?: string;
  /** OpenRouter `X-Title` attribution header (only sent when an apiKey is set). */
  appTitle?: string;
  /** OpenRouter `HTTP-Referer` attribution header (only sent when an apiKey is set). */
  httpReferer?: string;
}

export interface ChatCompletionStreamOptions {
  onToken: (token: string) => void | Promise<void>;
  onFirstToken?: () => void;
}

export interface ChatCompletionResult {
  content: string;
  model: string | null;
  raw: unknown;
}

export interface LlmProbeResult {
  endpoint: string;
  health_url: string;
  health_ok: boolean;
  chat_ok: boolean;
  detail: string;
}

export interface LlmProbeOptions {
  /** Model to use for the probe when the endpoint has a feature-specific model. */
  model?: string;
  healthTimeoutMs?: number;
  chatTimeoutMs?: number;
}

export interface LlmRetryOptions {
  /** Additional attempts after the initial request. Defaults to KB_LLM_MAX_RETRIES or 2. */
  maxRetries?: number;
  /** Base exponential backoff delay before jitter. */
  baseDelayMs?: number;
  /** Per-retry cap before jitter. */
  maxDelayMs?: number;
  /** Cap across all retry sleeps for one chat completion call. */
  maxTotalDelayMs?: number;
  /** Injectable for deterministic tests. Defaults to Math.random. */
  random?: () => number;
  /** Injectable for deterministic tests. Defaults to setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class LlmClientError extends Error {
  /** HTTP status when the failure came from a non-ok response. */
  readonly status?: number;
  /** Server-advised backoff in ms, parsed from a `Retry-After` header. */
  readonly retryAfterMs?: number;
  /** Whether this error class is safe to retry inside the shared LLM client. */
  readonly transient?: boolean;

  constructor(message: string, opts?: { status?: number; retryAfterMs?: number; transient?: boolean }) {
    super(message);
    this.name = 'LlmClientError';
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts?.transient !== undefined) this.transient = opts.transient;
  }
}

type FetchLike = typeof fetch;

interface ResolvedRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxTotalDelayMs: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_LLM_MAX_RETRIES = 2;
const MAX_LLM_MAX_RETRIES = 5;
const DEFAULT_LLM_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_LLM_RETRY_MAX_DELAY_MS = 2_000;
const DEFAULT_LLM_RETRY_MAX_TOTAL_DELAY_MS = 5_000;

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into ms.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

export function normalizeChatEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new LlmClientError('LLM endpoint is empty');
  if (trimmed.endsWith('/v1/chat/completions')) return trimmed;
  return `${trimmed}/v1/chat/completions`;
}

export function deriveHealthUrl(chatEndpoint: string): string {
  return normalizeChatEndpoint(chatEndpoint).replace(/\/v1\/chat\/completions$/, '/health');
}

export async function callChatCompletion(
  options: ChatCompletionOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ChatCompletionResult> {
  if (isFakeLlmEnabled()) {
    return callFakeChatCompletion(options);
  }

  const endpoint = normalizeChatEndpoint(options.endpoint);
  // Resolve auth/model from the environment when the caller did not pass them
  // explicitly, so every call site (contextual prefaces, the gate judge, the
  // probe) picks up the OpenRouter provider switch centrally.
  const provider = resolveLlmProvider();
  const apiKey = options.apiKey ?? provider.apiKey;
  const remote = apiKey !== undefined;
  const payload: Record<string, unknown> = {
    model: options.model ?? provider.model ?? 'local-model',
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    stream: options.stream !== undefined,
  };
  // `chat_template_kwargs` is a llama.cpp / vLLM extension; hosted providers
  // (OpenRouter) reject or ignore unknown body fields, so only send it locally.
  if (!remote) {
    payload.chat_template_kwargs = { enable_thinking: false };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey !== undefined) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-Title'] = options.appTitle ?? provider.appTitle;
    const referer = options.httpReferer ?? provider.httpReferer;
    if (referer !== undefined) headers['HTTP-Referer'] = referer;
  }

  const retryPolicy = resolveRetryPolicy(options.retry);
  const breakerKey = llmProviderBreakerKey(provider.provider, endpoint, String(payload.model));
  return providerBreakerRegistry.run(
    breakerKey,
    () => callChatCompletionWithRetry({
      endpoint,
      payload,
      headers,
      timeoutMs: options.timeoutMs,
      stream: options.stream,
      retryPolicy,
      fetchImpl,
    }),
    { shouldRecordFailure: (err) => err instanceof LlmClientError && isTransientLlmClientError(err) },
  );
}

interface ChatCompletionWithRetryOptions {
  endpoint: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  timeoutMs?: number;
  stream?: ChatCompletionStreamOptions;
  retryPolicy: ResolvedRetryPolicy | null;
  fetchImpl: FetchLike;
}

async function callChatCompletionWithRetry(
  options: ChatCompletionWithRetryOptions,
): Promise<ChatCompletionResult> {
  let totalRetryDelayMs = 0;
  let emittedStreamToken = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callChatCompletionOnce(options.endpoint, options.payload, options.headers, options.timeoutMs, options.stream, () => {
        emittedStreamToken = true;
      }, options.fetchImpl);
    } catch (err) {
      if (
        !(err instanceof LlmClientError) ||
        emittedStreamToken ||
        options.retryPolicy === null ||
        attempt >= options.retryPolicy.maxRetries ||
        !isTransientLlmClientError(err)
      ) {
        throw err;
      }

      const remainingDelayMs = options.retryPolicy.maxTotalDelayMs - totalRetryDelayMs;
      if (remainingDelayMs <= 0) throw err;
      const delayMs = Math.min(computeRetryDelayMs(err, attempt, options.retryPolicy), remainingDelayMs);
      totalRetryDelayMs += delayMs;
      await options.retryPolicy.sleep(delayMs);
    }
  }
}

export function llmProviderBreakerKey(provider: string, endpoint: string, model: string): string {
  return `llm:${provider}:${endpoint}:${model}`;
}

async function callChatCompletionOnce(
  endpoint: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number | undefined,
  stream: ChatCompletionStreamOptions | undefined,
  onStreamTokenEmitted: () => void,
  fetchImpl: FetchLike,
): Promise<ChatCompletionResult> {
  let response: Response;
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), timeoutMs ?? 180_000);
  const resetStreamingIdleTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), timeoutMs ?? 180_000);
  };
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmClientError(`local LLM request failed: ${msg}`, { transient: true });
  }
  if (stream === undefined) clearTimeout(timeout);
  else resetStreamingIdleTimeout();

  if (stream !== undefined) {
    try {
      return await readStreamingChatCompletion(response, stream, onStreamTokenEmitted, resetStreamingIdleTimeout);
    } catch (err) {
      if (err instanceof LlmClientError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmClientError(`local LLM stream failed: ${msg}`, { transient: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  const body = await readResponseBody(response);

  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const message = body.ok
      ? extractErrorMessage(body.data)
      : body.text ?? body.errorMessage;
    throw new LlmClientError(
      `local LLM returned HTTP ${response.status}: ${message}`,
      { status: response.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (!body.ok) {
    throw new LlmClientError(`local LLM returned non-JSON response: ${body.errorMessage}`, { transient: false });
  }

  const data = body.data;
  const content = extractAssistantContent(data);
  if (content === null || content.trim() === '') {
    throw new LlmClientError('local LLM response did not contain choices[0].message.content', { transient: false });
  }
  const model = typeof (data as { model?: unknown }).model === 'string'
    ? (data as { model: string }).model
    : null;
  return { content: content.trim(), model, raw: data };
}

async function readStreamingChatCompletion(
  response: Response,
  stream: ChatCompletionStreamOptions,
  onStreamTokenEmitted: () => void,
  onChunk: () => void,
): Promise<ChatCompletionResult> {
  if (!response.ok) {
    const body = await readResponseBody(response);
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const message = body.ok
      ? extractErrorMessage(body.data)
      : body.text ?? body.errorMessage;
    throw new LlmClientError(
      `local LLM returned HTTP ${response.status}: ${message}`,
      { status: response.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (response.body === null) {
    throw new LlmClientError('local LLM streaming response did not contain a body', { transient: true });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: StreamingReadState = {
    rawEvents: [],
    contentParts: [],
    model: null,
    sawFirstToken: false,
  };
  let buffer = '';
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      onChunk();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = await drainSseBlocks(buffer, async (block) => {
        return handleStreamingBlock(block, state, stream, onStreamTokenEmitted);
      });
      buffer = parsed.remaining;
      done = parsed.done;
    }

    const tail = decoder.decode();
    if (tail !== '') {
      buffer += tail;
    }
    if (!done && buffer.trim() !== '') {
      await drainSseBlocks(`${buffer}\n\n`, async (block) => {
        return handleStreamingBlock(block, state, stream, onStreamTokenEmitted);
      });
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new LlmClientError('local LLM stream timed out waiting for the next chunk', { transient: true });
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  const content = state.contentParts.join('').trim();
  if (content === '') {
    throw new LlmClientError('local LLM streaming response did not contain choices[0].delta.content', { transient: false });
  }
  return { content, model: state.model, raw: { stream: true, events: state.rawEvents } };
}

interface StreamingReadState {
  rawEvents: unknown[];
  contentParts: string[];
  model: string | null;
  sawFirstToken: boolean;
}

async function handleStreamingBlock(
  block: string,
  state: StreamingReadState,
  stream: ChatCompletionStreamOptions,
  onStreamTokenEmitted: () => void,
): Promise<boolean> {
  const data = sseData(block);
  if (data === null) return false;
  if (data.trim() === '[DONE]') return true;
  const parsedEvent = parseStreamingEvent(data);
  state.rawEvents.push(parsedEvent);
  const eventModel = typeof (parsedEvent as { model?: unknown }).model === 'string'
    ? (parsedEvent as { model: string }).model
    : null;
  if (eventModel !== null) state.model = eventModel;
  const delta = extractStreamingDelta(parsedEvent);
  if (delta === null || delta === '') return false;
  if (!state.sawFirstToken) {
    state.sawFirstToken = true;
    try {
      stream.onFirstToken?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmClientError(`local LLM stream callback failed: ${msg}`, { transient: false });
    }
  }
  onStreamTokenEmitted();
  try {
    await stream.onToken(delta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmClientError(`local LLM stream callback failed: ${msg}`, { transient: false });
  }
  state.contentParts.push(delta);
  return false;
}

async function drainSseBlocks(
  input: string,
  handle: (block: string) => Promise<boolean>,
): Promise<{ remaining: string; done: boolean }> {
  let remaining = input;
  let done = false;
  for (;;) {
    const separator = findSseBlockSeparator(remaining);
    if (separator === null) break;
    const block = remaining.slice(0, separator.index);
    remaining = remaining.slice(separator.index + separator.length);
    if (block.trim() === '') continue;
    done = await handle(block);
    if (done) break;
  }
  return { remaining, done };
}

function findSseBlockSeparator(input: string): { index: number; length: number } | null {
  const crlf = input.indexOf('\r\n\r\n');
  const lf = input.indexOf('\n\n');
  const cr = input.indexOf('\r\r');
  let best: { index: number; length: number } | null = null;
  for (const candidate of [
    crlf < 0 ? null : { index: crlf, length: 4 },
    lf < 0 ? null : { index: lf, length: 2 },
    cr < 0 ? null : { index: cr, length: 2 },
  ]) {
    if (candidate !== null && (best === null || candidate.index < best.index)) {
      best = candidate;
    }
  }
  return best;
}

function sseData(block: string): string | null {
  const lines = block.split(/\r\n|\n|\r/);
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  return data.length === 0 ? null : data.join('\n');
}

function parseStreamingEvent(data: string): unknown {
  try {
    const parsed = JSON.parse(data) as unknown;
    const err = (parsed as { error?: unknown }).error;
    if (err !== undefined) {
      throw new LlmClientError(`local LLM streaming response returned error: ${extractErrorMessage(parsed)}`, {
        transient: false,
      });
    }
    return parsed;
  } catch (err) {
    if (err instanceof LlmClientError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmClientError(`local LLM returned malformed streaming event: ${msg}`, { transient: true });
  }
}

function extractStreamingDelta(data: unknown): string | null {
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
    text?: unknown;
  };
  if (typeof first.delta?.content === 'string') return first.delta.content;
  if (typeof first.message?.content === 'string') return first.message.content;
  if (typeof first.text === 'string') return first.text;
  return null;
}

async function readResponseBody(response: Response): Promise<
  | { ok: true; data: unknown }
  | { ok: false; text?: string; errorMessage: string }
> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorMessage: msg };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, text: raw, errorMessage: msg };
  }
}

function resolveRetryPolicy(options: ChatCompletionOptions['retry']): ResolvedRetryPolicy | null {
  if (options === false) return null;
  const maxRetries = boundedInteger(
    options?.maxRetries,
    boundedInteger(envInteger('KB_LLM_MAX_RETRIES'), DEFAULT_LLM_MAX_RETRIES, 0, MAX_LLM_MAX_RETRIES),
    0,
    MAX_LLM_MAX_RETRIES,
  );
  if (maxRetries === 0) return null;
  return {
    maxRetries,
    baseDelayMs: boundedInteger(options?.baseDelayMs, DEFAULT_LLM_RETRY_BASE_DELAY_MS, 0, 60_000),
    maxDelayMs: boundedInteger(options?.maxDelayMs, DEFAULT_LLM_RETRY_MAX_DELAY_MS, 0, 60_000),
    maxTotalDelayMs: boundedInteger(options?.maxTotalDelayMs, DEFAULT_LLM_RETRY_MAX_TOTAL_DELAY_MS, 0, 60_000),
    random: options?.random ?? Math.random,
    sleep: options?.sleep ?? sleep,
  };
}

function envInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isTransientLlmClientError(err: LlmClientError): boolean {
  if (err.transient !== undefined) return err.transient;
  if (err.status === undefined) return false;
  return err.status === 408 || err.status === 429 || err.status >= 500;
}

function computeRetryDelayMs(
  err: LlmClientError,
  retryIndex: number,
  policy: ResolvedRetryPolicy,
): number {
  if (err.retryAfterMs !== undefined) return Math.max(0, err.retryAfterMs);
  const exponentialCap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryIndex);
  return Math.floor(exponentialCap * clampUnitInterval(policy.random()));
}

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeLlmEndpoint(
  endpoint: string,
  fetchImpl: FetchLike = fetch,
  options: LlmProbeOptions = {},
): Promise<LlmProbeResult> {
  const chatEndpoint = normalizeChatEndpoint(endpoint);
  const healthUrl = deriveHealthUrl(chatEndpoint);
  // Hosted providers (OpenRouter) expose no `/health` route; a GET there 404s.
  // Skip the health probe for remote providers and judge readiness by the chat
  // call alone.
  const remote = resolveLlmProvider().remote;
  let healthOk = false;
  let healthDetail = '';
  if (remote) {
    healthOk = true;
    healthDetail = 'remote provider (health check skipped)';
  } else {
    try {
      const health = await fetchImpl(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(options.healthTimeoutMs ?? 3_000),
      });
      healthOk = health.ok;
      healthDetail = `health HTTP ${health.status}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      healthDetail = `health failed: ${msg}`;
    }
  }

  try {
    await callChatCompletion({
      endpoint: chatEndpoint,
      model: options.model,
      messages: [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'health check' },
      ],
      temperature: 0,
      timeoutMs: options.chatTimeoutMs ?? 15_000,
    }, fetchImpl);
    return {
      endpoint: chatEndpoint,
      health_url: healthUrl,
      health_ok: healthOk,
      chat_ok: true,
      detail: remote
        ? `chat completion succeeded; ${healthDetail}`
        : (healthOk ? 'health and chat completion succeeded' : `chat completion succeeded; ${healthDetail}`),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      endpoint: chatEndpoint,
      health_url: healthUrl,
      health_ok: healthOk,
      chat_ok: false,
      detail: `${healthDetail}; chat failed: ${msg}`,
    };
  }
}

function extractAssistantContent(data: unknown): string | null {
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  return typeof first.message?.content === 'string' ? first.message.content : null;
}

function extractErrorMessage(data: unknown): string {
  const err = (data as { error?: unknown }).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return JSON.stringify(data);
}
