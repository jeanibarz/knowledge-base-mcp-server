import { callFakeChatCompletion, isFakeLlmEnabled } from './llm-fake-stub.js';
import { resolveLlmProvider } from './config/llm-provider.js';

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
  healthTimeoutMs?: number;
  chatTimeoutMs?: number;
}

export class LlmClientError extends Error {
  /** HTTP status when the failure came from a non-ok response. */
  readonly status?: number;
  /** Server-advised backoff in ms, parsed from a `Retry-After` header. */
  readonly retryAfterMs?: number;

  constructor(message: string, opts?: { status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = 'LlmClientError';
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

type FetchLike = typeof fetch;

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);
  const payload: Record<string, unknown> = {
    model: options.model ?? provider.model ?? 'local-model',
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    stream: false,
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

  let response: Response;
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
    throw new LlmClientError(`local LLM request failed: ${msg}`);
  }
  clearTimeout(timeout);

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmClientError(`local LLM returned non-JSON response: ${msg}`);
  }

  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw new LlmClientError(
      `local LLM returned HTTP ${response.status}: ${extractErrorMessage(data)}`,
      { status: response.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  const content = extractAssistantContent(data);
  if (content === null || content.trim() === '') {
    throw new LlmClientError('local LLM response did not contain choices[0].message.content');
  }
  const model = typeof (data as { model?: unknown }).model === 'string'
    ? (data as { model: string }).model
    : null;
  return { content: content.trim(), model, raw: data };
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
