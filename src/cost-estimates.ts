// RFC 013 §4.13.6 — centralised cost-per-million-tokens table for paid embedding
// providers. Used by `kb models add` (interactive cost prompt) and the M5
// `bench:compare` orchestrator (cost row in the comparison report).
//
// Numbers are USD per 1M tokens at the provider's published rate as of
// LAST_VERIFIED. Bumped quarterly; the report renders LAST_VERIFIED so a
// reviewer can spot a stale number.

import type { EmbeddingProvider } from './model-id.js';

export const LAST_VERIFIED = '2026-04-26';

/**
 * Per-provider per-tier USD/1M-tokens. Lookup is provider-then-tier-name; tier
 * is derived from `modelName.includes(...)` keywords (matches the heuristic
 * the inline cost prompt used in 0.3.0; see `src/cli.ts` `runAddModel`).
 */
export const COSTS = {
  openai: {
    'text-embedding-3-large': 0.13,
    'text-embedding-ada-002': 0.10,
    default: 0.02, // text-embedding-3-small and other current OpenAI models
  },
  huggingface: { default: 0 }, // free tier (rate-limited)
  ollama: { default: 0 }, // free (local)
} as const;

export interface CostBreakdown {
  usd: number;
  per_million_tokens_usd: number;
  source: 'rule-of-thumb';
  last_verified: string;
}

/**
 * Resolve USD/1M-tokens for a (provider, modelName) pair. Heuristic — kept
 * deliberately simple so a reader can audit it.
 */
export function usdPerMillionTokens(provider: EmbeddingProvider, modelName: string): number {
  if (provider === 'openai') {
    if (modelName.includes('large')) return COSTS.openai['text-embedding-3-large'];
    if (modelName.includes('ada')) return COSTS.openai['text-embedding-ada-002'];
    return COSTS.openai.default;
  }
  return 0;
}

export function estimateCostUsd(
  provider: EmbeddingProvider,
  modelName: string,
  tokens: number,
): CostBreakdown {
  const perM = usdPerMillionTokens(provider, modelName);
  return {
    usd: (tokens / 1_000_000) * perM,
    per_million_tokens_usd: perM,
    source: 'rule-of-thumb',
    last_verified: LAST_VERIFIED,
  };
}
