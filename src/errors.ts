export type KBErrorCode =
  | 'INDEX_NOT_INITIALIZED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_AUTH'
  | 'KB_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'CORRUPT_INDEX'
  | 'VALIDATION'
  | 'INTERNAL'
  // RFC 017 — contextual-retrieval failure taxonomy. The four codes below
  // map to canonical-log categories that surface LLM-side issues
  // distinctly from index-corruption and validation errors. Variants of
  // LLM-side failure (unreachable, malformed, refusal, truncated) live on
  // the per-chunk sidecar `error_code` field; this taxonomy is the
  // operator-facing umbrella.
  | 'PREFACE_LLM_FAILURE'
  | 'PREFACE_SIDECAR_CORRUPT'
  | 'REINDEX_LOCK_HELD'
  | 'REINDEX_BUDGET_EXCEEDED';

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
