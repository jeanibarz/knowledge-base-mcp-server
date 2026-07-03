// The canonical, runtime-enumerable list of KBError codes. This array is the
// single source of truth: the `KBErrorCode` type is derived from it, and the
// docs registry in error-codes-doc.ts keys off it so the generate-and-diff gate
// (scripts/gen-error-codes-doc.mjs) can enforce that every code is documented.
// Keep the order stable — the generated docs/reference/error-codes.md table
// follows it.
export const KB_ERROR_CODES = [
  'INDEX_NOT_INITIALIZED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_AUTH',
  'KB_NOT_FOUND',
  'PERMISSION_DENIED',
  'CORRUPT_INDEX',
  'VALIDATION',
  'INTERNAL',
  // RFC 017 — contextual-retrieval failure taxonomy. The four codes below
  // map to canonical-log categories that surface LLM-side issues
  // distinctly from index-corruption and validation errors. Variants of
  // LLM-side failure (unreachable, malformed, refusal, truncated) live on
  // the per-chunk sidecar `error_code` field; this taxonomy is the
  // operator-facing umbrella.
  'PREFACE_LLM_FAILURE',
  'PREFACE_SIDECAR_CORRUPT',
  'REINDEX_LOCK_HELD',
  'REINDEX_BUDGET_EXCEEDED',
  // Issue #645 — disk-space preflight guard. Thrown by the reindex/ingest
  // entry path when estimated required bytes exceed available free space
  // (minus the KB_MIN_FREE_DISK_BYTES margin), so a write-heavy run fails
  // fast with an actionable "need ~X, have Y" message instead of an
  // ENOSPC partway through.
  'INSUFFICIENT_DISK_SPACE',
] as const;

export type KBErrorCode = (typeof KB_ERROR_CODES)[number];

export class KBError extends Error {
  readonly code: KBErrorCode;
  override readonly cause?: unknown;

  constructor(code: KBErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'KBError';
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
