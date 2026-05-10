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

export class LlmClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmClientError';
  }
}

type FetchLike = typeof fetch;

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
  const endpoint = normalizeChatEndpoint(options.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);
  const payload = {
    model: options.model ?? 'local-model',
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    throw new LlmClientError(`local LLM returned HTTP ${response.status}: ${extractErrorMessage(data)}`);
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
): Promise<LlmProbeResult> {
  const chatEndpoint = normalizeChatEndpoint(endpoint);
  const healthUrl = deriveHealthUrl(chatEndpoint);
  let healthOk = false;
  let healthDetail = '';
  try {
    const health = await fetchImpl(healthUrl, { method: 'GET', signal: AbortSignal.timeout(3_000) });
    healthOk = health.ok;
    healthDetail = `health HTTP ${health.status}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    healthDetail = `health failed: ${msg}`;
  }

  try {
    await callChatCompletion({
      endpoint: chatEndpoint,
      messages: [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'health check' },
      ],
      temperature: 0,
      timeoutMs: 15_000,
    }, fetchImpl);
    return {
      endpoint: chatEndpoint,
      health_url: healthUrl,
      health_ok: healthOk,
      chat_ok: true,
      detail: healthOk ? 'health and chat completion succeeded' : `chat completion succeeded; ${healthDetail}`,
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
