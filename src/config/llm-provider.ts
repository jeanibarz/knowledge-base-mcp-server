import { initializeProjectConfig } from './project-config.js';

initializeProjectConfig();

// LLM provider resolution — local (default) vs OpenRouter (OpenAI-compatible).
//
// This mirrors the provider-neutral switch used by the sibling repos
// (local-research-agent's `LRA_LLM_*`, kookr's `KOOKR_LLM_*`): a single
// `KB_LLM_PROVIDER` toggle moves every chat-completion call (contextual
// prefaces RFC 017, the relevance-gate judge RFC 018, `kb llm probe`) between
//
//   - "local"      — a localhost OpenAI-compatible server (llama-server, the
//                    RFC 015 default). No auth header.
//   - "openrouter" — OpenRouter's hosted OpenAI-compatible API. Requires an
//                    API key sent as `Authorization: Bearer <key>`.
//
// API-key precedence matches the sibling repos: the component-specific
// `KB_OPENROUTER_API_KEY` is checked first, then the shared `OPENROUTER_API_KEY`
// fallback — so kb can hold its own OpenRouter credit/limit, or single-key
// setups can share one variable across kb, LRA, and kookr.
//
// The endpoint itself is still read per-feature (`KB_LLM_ENDPOINT`,
// `KB_GATE_LLM_ENDPOINT`); this module resolves the *auth* and a sensible
// default *model* so `callChatCompletion` can fill them in centrally.

export type LlmProviderKind = 'local' | 'openrouter';

export const OPENROUTER_DEFAULT_CHAT_URL =
  'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
export const KB_LLM_APP_TITLE_DEFAULT = 'knowledge-base-mcp';

export interface LlmProviderResolution {
  provider: LlmProviderKind;
  /** Present only for remote providers; never logged. */
  apiKey?: string;
  /** OpenRouter `X-Title` attribution header. */
  appTitle: string;
  /** OpenRouter `HTTP-Referer` attribution header (optional). */
  httpReferer?: string;
  /**
   * Default model when a call site does not specify one. For OpenRouter this is
   * required by the API, so we fall back to `KB_LLM_MODEL` then a DeepSeek
   * default; for local it is `KB_LLM_MODEL` or undefined (client uses its own
   * `local-model` placeholder).
   */
  model?: string;
  /** True when the active endpoint has no `/health` route (skip health probe). */
  remote: boolean;
  /** Operator-facing hint for a likely OpenRouter provider configuration drift. */
  warning?: string;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

export function resolveLlmProvider(
  env: NodeJS.ProcessEnv = process.env,
): LlmProviderResolution {
  const raw = (env.KB_LLM_PROVIDER ?? '').trim().toLowerCase();
  const provider: LlmProviderKind = raw === 'openrouter' ? 'openrouter' : 'local';
  const appTitle = firstNonEmpty(env.KB_LLM_APP_TITLE) ?? KB_LLM_APP_TITLE_DEFAULT;
  const httpReferer = firstNonEmpty(env.KB_LLM_HTTP_REFERER);
  const configuredModel = firstNonEmpty(env.KB_LLM_MODEL);
  const hasOpenRouterKey = firstNonEmpty(env.KB_OPENROUTER_API_KEY, env.OPENROUTER_API_KEY) !== undefined;
  const warning = provider === 'local' && hasOpenRouterKey
    ? 'OpenRouter API key is configured but KB_LLM_PROVIDER resolves to local; set KB_LLM_PROVIDER=openrouter to use OpenRouter.'
    : undefined;

  if (provider === 'openrouter') {
    const apiKey = firstNonEmpty(env.KB_OPENROUTER_API_KEY, env.OPENROUTER_API_KEY);
    return {
      provider,
      ...(apiKey !== undefined ? { apiKey } : {}),
      appTitle,
      ...(httpReferer !== undefined ? { httpReferer } : {}),
      model: configuredModel ?? OPENROUTER_DEFAULT_MODEL,
      remote: true,
    };
  }

  return {
    provider,
    appTitle,
    ...(httpReferer !== undefined ? { httpReferer } : {}),
    ...(configuredModel !== undefined ? { model: configuredModel } : {}),
    remote: false,
    ...(warning !== undefined ? { warning } : {}),
  };
}
