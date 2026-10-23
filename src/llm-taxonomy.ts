// llm-taxonomy.ts — bounded label vocabulary for chat-completion telemetry
// (issue #1007 split of metrics.ts). Self-contained: no dependency on any
// other metrics module, so every subsystem that needs to normalize a
// provider/model string into a bounded telemetry label can import this
// directly without pulling in the recording classes or singletons.

/**
 * Fixed operation labels for chat-completion telemetry. Keep this enum small:
 * prompt text, KB names, model strings, and request ids must never become
 * metric labels.
 */
export type LlmCallOperation = 'ask' | 'gate' | 'preface';

export const LLM_CALL_OPERATIONS: readonly LlmCallOperation[] = ['ask', 'gate', 'preface'];

export function isLlmCallOperation(value: string): value is LlmCallOperation {
  return (LLM_CALL_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Bounded provider labels for chat-completion telemetry. Unknown providers are
 * deliberately collapsed so a future configuration value cannot create an
 * unbounded metric label set.
 */
export type LlmProvider = 'local' | 'openrouter' | 'fake' | 'unknown';

export const LLM_PROVIDERS: readonly LlmProvider[] = ['local', 'openrouter', 'fake', 'unknown'];

/** Coarse model families used for telemetry; raw model strings never escape this boundary. */
export type LlmModel =
  | 'local'
  | 'fake'
  | 'deepseek'
  | 'qwen'
  | 'llama'
  | 'gpt'
  | 'claude'
  | 'gemini'
  | 'mistral'
  | 'other'
  | 'unknown';

export const LLM_MODELS: readonly LlmModel[] = [
  'local',
  'fake',
  'deepseek',
  'qwen',
  'llama',
  'gpt',
  'claude',
  'gemini',
  'mistral',
  'other',
  'unknown',
];

export type LlmCacheOutcome = 'hit' | 'miss' | 'not_applicable';
export type LlmAnswerImpact = 'used' | 'not_used' | 'unknown';

export const LLM_CACHE_OUTCOMES: readonly LlmCacheOutcome[] = ['hit', 'miss', 'not_applicable'];
export const LLM_ANSWER_IMPACTS: readonly LlmAnswerImpact[] = ['used', 'not_used', 'unknown'];

export function isLlmCacheOutcome(value: string): value is LlmCacheOutcome {
  return (LLM_CACHE_OUTCOMES as readonly string[]).includes(value);
}

export function isLlmAnswerImpact(value: string): value is LlmAnswerImpact {
  return (LLM_ANSWER_IMPACTS as readonly string[]).includes(value);
}

export function normalizeLlmProvider(value: string | null | undefined): LlmProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'local') return 'local';
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'fake') return 'fake';
  return 'unknown';
}

/**
 * Map a configured or provider-returned model string to a finite family. The
 * original string is intentionally not retained in telemetry.
 */
export function normalizeLlmModel(
  value: string | null | undefined,
  provider?: LlmProvider | string | null,
): LlmModel {
  const normalizedProvider = normalizeLlmProvider(provider);
  if (normalizedProvider === 'fake') return 'fake';
  const model = value?.trim().toLowerCase() ?? '';
  if (model === '') return normalizedProvider === 'local' ? 'local' : 'unknown';
  if (model.includes('deepseek')) return 'deepseek';
  if (model.includes('qwen')) return 'qwen';
  if (model.includes('llama')) return 'llama';
  if (/\b(?:gpt|o[1-4](?:-mini|-preview)?)\b/.test(model)) return 'gpt';
  if (model.includes('claude') || model.includes('anthropic')) return 'claude';
  if (model.includes('gemini') || model.includes('google')) return 'gemini';
  if (model.includes('mistral') || model.includes('mixtral')) return 'mistral';
  if (model === 'local' || model === 'local-model' || model.startsWith('local-')) return 'local';
  return 'other';
}
