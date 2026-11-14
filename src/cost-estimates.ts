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

/**
 * Where an OpenAI-provider model's embeddings are actually served (issue #1267).
 *
 * - `hosted`: the official api.openai.com API, where OpenAI's price table and
 *   HTTP latency apply.
 * - `local`: a loopback or private-network server (TEI, llama-server, vLLM on
 *   the LAN, …) — typically free, with throughput set by local hardware.
 * - `custom`: some other OpenAI-compatible host (OpenRouter, a gateway, …)
 *   whose pricing is that provider's own, not OpenAI's.
 */
export type OpenAiEndpointKind = 'hosted' | 'local' | 'custom';

const OFFICIAL_OPENAI_HOST = 'api.openai.com';

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127            // loopback
    || a === 10               // RFC 1918
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254) // link-local
    || a === 0;               // 0.0.0.0 "this host"
}

function isLocalHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host.docker.internal' || host.endsWith('.local')) return true;
  if (isPrivateIpv4(host)) return true;
  // WHATWG URL keeps IPv6 hosts bracketed: "[::1]".
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(v6)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]?:/.test(v6)) return true;  // fe80::/10 link-local
  }
  return false;
}

/**
 * Classify an `OPENAI_BASE_URL` value. Pure — takes the URL rather than reading
 * config so callers and tests can pass any value. An unparseable URL is
 * `custom` (it is certainly not the official endpoint).
 */
export function classifyOpenAiEndpoint(baseUrl: string): OpenAiEndpointKind {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'custom';
  }
  if (host === OFFICIAL_OPENAI_HOST) return 'hosted';
  if (isLocalHostname(host)) return 'local';
  return 'custom';
}
