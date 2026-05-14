// RFC 017 — Contextual Retrieval at Ingest.
//
// Config knobs live here so the rest of the module can read them via a
// single function. The master switch (`KB_CONTEXTUAL_RETRIEVAL`) is off
// by default — every code path in `src/contextual-preface.ts`,
// `src/faiss-store-adapter.ts`, and `src/lexical-index.ts` short-circuits
// to today's behavior when this returns `false`.
//
// Everything else (truncation budget, retry budget, timeout, backoffs) is
// hard-coded per RFC §6 — we deliberately keep the operator surface at
// three vars (KB_CONTEXTUAL_RETRIEVAL, KB_CONTEXTUAL_MAX_TOKENS,
// KB_LLM_ENDPOINT).

const DEFAULT_MAX_TOKENS = 150;

export function isContextualRetrievalEnabled(): boolean {
  const raw = (process.env.KB_CONTEXTUAL_RETRIEVAL ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
}

export function resolveContextualMaxTokens(): number {
  const raw = process.env.KB_CONTEXTUAL_MAX_TOKENS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_TOKENS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(1000, Math.max(20, Math.floor(parsed)));
}

export function resolveContextualLlmEndpoint(): string | null {
  const raw = process.env.KB_LLM_ENDPOINT;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

// Hard-coded constants per RFC §6.
export const CONTEXTUAL_DOCUMENT_TRUNCATION_CHARS = 48_000;
export const CONTEXTUAL_LLM_TIMEOUT_MS = 30_000;
export const CONTEXTUAL_RETRY_LIMIT = 2;
export const CONTEXTUAL_CONSECUTIVE_TIMEOUT_LIMIT = 5;

// Per-error retry-after deadlines (milliseconds added to now() at the
// time of failure). Treated as "earliest retryable time"; a future
// resolve() call before next_retry_after re-uses the failed entry.
export const CONTEXTUAL_RETRY_AFTER_MS = {
  llm_unreachable: 24 * 60 * 60 * 1_000,  // 24h
  llm_malformed: 60 * 60 * 1_000,         // 1h
  llm_refusal: 72 * 60 * 60 * 1_000,      // 72h
  truncated_doc: Number.POSITIVE_INFINITY, // never until file changes
} as const;

export type ContextualErrorCode = keyof typeof CONTEXTUAL_RETRY_AFTER_MS;
