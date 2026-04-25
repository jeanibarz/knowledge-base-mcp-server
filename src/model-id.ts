// RFC 013 §4.3 — deterministic, filesystem-safe `<model_id>` slug.
//
// Derived from `(provider, modelName)` AS TYPED — not canonicalized. Two
// equivalent forms (`OLLAMA_MODEL=foo` vs `OLLAMA_MODEL=foo:latest`) produce
// different ids on disk; documented determinism caveat in RFC §4.3 + §7.
// Slug regex matches POSIX-safe subset; throws on overlong (no silent hash).

export type EmbeddingProvider = 'ollama' | 'openai' | 'huggingface';

export const MAX_MODEL_ID_LENGTH = 240;

export class ModelIdTooLongError extends Error {
  constructor(provider: string, modelName: string) {
    super(
      `Model id derived from (provider="${provider}", model="${modelName}") would exceed ` +
      `${MAX_MODEL_ID_LENGTH} bytes — pick a shorter model name or open an issue ` +
      `(no embedding provider in production catalogue today exceeds 100 chars).`,
    );
    this.name = 'ModelIdTooLongError';
  }
}

export class InvalidModelIdError extends Error {
  constructor(id: string) {
    super(
      `Invalid model_id "${id}": must match ^[a-z]+__[A-Za-z0-9._-]+$ ` +
      `(provider double-underscore slug). Reject path-traversal characters.`,
    );
    this.name = 'InvalidModelIdError';
  }
}

const MODEL_ID_REGEX = /^([a-z]+)__([A-Za-z0-9._-]+)$/;

/**
 * Compute the on-disk model_id from (provider, modelName). Filesystem-safe:
 * non-`[A-Za-z0-9._-]` characters become `-`, runs collapse, leading/trailing
 * `-` trimmed. Provider lowercased; `__` separator so `-` collisions are
 * impossible across the boundary.
 */
export function deriveModelId(provider: EmbeddingProvider, modelName: string): string {
  const slug = modelName
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const id = `${provider.toLowerCase()}__${slug}`;
  if (id.length > MAX_MODEL_ID_LENGTH) {
    throw new ModelIdTooLongError(provider, modelName);
  }
  return id;
}

/**
 * Parse a model_id back into its (provider, slugBody). Hard-validates against
 * the slug regex — rejects path-traversal characters (`..`, `/`, `\`, NUL).
 * RFC 013 §4.11 + round-1 failure F12 — this is the safety check before any
 * `path.join(modelsDir, modelId)`.
 */
export function parseModelId(id: string): { provider: string; slugBody: string } {
  const m = MODEL_ID_REGEX.exec(id);
  if (!m) throw new InvalidModelIdError(id);
  return { provider: m[1], slugBody: m[2] };
}

/** Cheap predicate; doesn't throw. */
export function isValidModelId(id: string): boolean {
  return MODEL_ID_REGEX.test(id);
}
