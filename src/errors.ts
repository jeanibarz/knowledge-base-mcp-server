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
  // Issue #645/#908 — disk-space preflight guard. Thrown by write-heavy
  // entry paths (reindex, backup, restore) when estimated required bytes
  // exceed available free space (minus the KB_MIN_FREE_DISK_BYTES margin),
  // so the run fails fast with an actionable "need ~X, have Y" message
  // instead of an ENOSPC partway through.
  'INSUFFICIENT_DISK_SPACE',
  // Issue #1181 — a persisted index version exists but this process must not
  // silently rebuild over it. INDEX_CONFIG_MISMATCH: the stored version was
  // written for another backend/index type/HNSW tuning than the current
  // environment. INDEX_POINTER_MISSING: index.vN/ directories exist but the
  // `index` pointer is gone (repairable with `kb verify --integrity --repair`).
  'INDEX_CONFIG_MISMATCH',
  'INDEX_POINTER_MISSING',
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

/** Embedding backend that rejected a request's credentials. */
export type ProviderAuthSource = 'ollama' | 'openai';

/**
 * Issue #1264 — a `PROVIDER_AUTH` raised by an embedding endpoint's HTTP
 * 401/403. It records which backend answered, so the operator hint can name
 * the right fix: an Ollama server takes no API key, so a 401/403 there comes
 * from an auth proxy in front of it, not from a missing `OPENAI_API_KEY`.
 */
export class ProviderAuthError extends KBError {
  readonly provider: ProviderAuthSource;

  constructor(provider: ProviderAuthSource, message: string, cause?: unknown) {
    super('PROVIDER_AUTH', message, cause);
    this.provider = provider;
  }
}

/**
 * True when a `KBError` means a candidate is not an addressable knowledge base
 * and an UNSCOPED enumeration should skip it rather than abort: `KB_NOT_FOUND`
 * (missing, dangling symlink, or a symlink/path that does not resolve to a
 * directory) and `VALIDATION` (a symlink that resolves outside the root). Every
 * other error — a non-KBError such as `ELOOP`/`EACCES`, or any other KBError
 * code — is a real failure and must still propagate. Callers addressing a
 * single KB by name must NOT swallow these: an explicit bad name still fails.
 */
export function isUnaddressableKbError(error: unknown): boolean {
  return error instanceof KBError
    && (error.code === 'KB_NOT_FOUND' || error.code === 'VALIDATION');
}

// Issue #1006 — moved from active-model.ts so logging primitives (e.g.
// canonical-log.ts) can depend on this leaf module instead of reaching
// upward into the active-model domain layer. Re-exported from
// active-model.ts for existing consumers.
export class ActiveModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveModelResolutionError';
  }
}
