export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const DEFAULT_RERANK_TOP_N = 40;
export const MAX_RERANK_TOP_N = 1000;

export type RerankOverride = 'on' | 'off' | undefined;

export interface RerankerConfig {
  enabled: boolean;
  model: string;
  topN: number;
}

export interface RerankerEnv {
  [key: string]: string | undefined;
  KB_RERANK?: string;
  KB_RERANK_MODEL?: string;
  KB_RERANK_TOP_N?: string;
  // RFC 020 §9 — the per-domain "skip-rerank fallback". A comma-separated list
  // of KB/domain names where the cross-encoder is force-disabled even when
  // KB_RERANK=on. The KB survey found cross-encoders degrade high-precision /
  // lexical domains (code, skills), so a reranker upgrade "ships only behind a
  // per-domain measurement gate + a skip-rerank fallback — never on by default
  // for all corpora." This env var is that fallback.
  KB_RERANK_SKIP_DOMAINS?: string;
}

export class RerankerConfigError extends Error {
  readonly code = 'RERANK_CONFIG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RerankerConfigError';
  }
}

export function parseRerankFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  throw new RerankerConfigError(`invalid KB_RERANK=${JSON.stringify(raw)} (expected on/off, true/false, or 1/0)`);
}

export function parseRerankTopN(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RERANK_TOP_N;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RerankerConfigError(`invalid KB_RERANK_TOP_N=${JSON.stringify(raw)} (expected integer 1-${MAX_RERANK_TOP_N})`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RERANK_TOP_N) {
    throw new RerankerConfigError(`invalid KB_RERANK_TOP_N=${JSON.stringify(raw)} (expected integer 1-${MAX_RERANK_TOP_N})`);
  }
  return value;
}

/**
 * Normalize a KB/domain name for skip-list matching: trimmed + lower-cased so a
 * skip list of `Code,Skills` matches a search scoped to `code` regardless of how
 * the corpus was named or cased.
 */
export function normalizeRerankDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Parse `KB_RERANK_SKIP_DOMAINS` into a deduplicated, normalized list. Empty,
 * blank, and duplicate entries are dropped. Never throws — a malformed list just
 * yields fewer skip domains, and the worst case (an empty list) is the safe
 * "no domain is skipped" default.
 */
export function parseSkipRerankDomains(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const normalized = normalizeRerankDomain(part);
    if (normalized !== '') seen.add(normalized);
  }
  return [...seen];
}

/**
 * Whether the cross-encoder must be skipped for `domain` per the per-domain
 * skip-rerank fallback (RFC 020 §9). A null/undefined domain (an unscoped
 * search) is never skipped — the fallback only fires for an explicitly scoped
 * KB whose name is on the list.
 */
export function isRerankSkippedForDomain(
  env: RerankerEnv = process.env,
  domain: string | null | undefined,
): boolean {
  if (domain === null || domain === undefined) return false;
  const skip = parseSkipRerankDomains(env.KB_RERANK_SKIP_DOMAINS);
  if (skip.length === 0) return false;
  return skip.includes(normalizeRerankDomain(domain));
}

export function resolveRerankerConfig(
  env: RerankerEnv = process.env,
  override?: RerankOverride,
  // RFC 020 §9 — the KB/domain a search is scoped to. When supplied and present
  // on KB_RERANK_SKIP_DOMAINS, the reranker is force-disabled (skip-rerank
  // fallback) regardless of how it was otherwise enabled. Omitting it preserves
  // the legacy two-argument behavior exactly.
  domain?: string | null,
): RerankerConfig {
  const enabledByRequest = override === 'on'
    ? true
    : override === 'off'
      ? false
      : parseRerankFlag(env.KB_RERANK);
  // The skip-rerank fallback is authoritative: a domain known to be degraded by
  // the cross-encoder stays un-reranked even under an explicit `on`. To measure
  // or force a skip domain, remove it from KB_RERANK_SKIP_DOMAINS.
  const enabled = enabledByRequest && !isRerankSkippedForDomain(env, domain);
  const model = env.KB_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL;
  const topN = enabled ? parseRerankTopN(env.KB_RERANK_TOP_N) : DEFAULT_RERANK_TOP_N;
  return { enabled, model, topN };
}
