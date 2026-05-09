// Issue #199 — classify and format `kb search` failures so each common
// failure mode (server reachability, configuration, indexing, provider/API,
// permissions, input) renders a distinct, actionable error.
//
// `kb doctor` is the documented availability smoke check; whenever a
// failure could be diagnosed by it, the next-action string says so. The
// classifier is deliberately conservative: unknown errors fall into the
// `unknown` bucket with `kb doctor` as the next action rather than
// pretending we know more than we do.

import { ActiveModelResolutionError } from './active-model.js';
import { KBError, type KBErrorCode } from './errors.js';
import { WriteLockContentionError } from './write-lock.js';

export type SearchFailureCategory =
  | 'configuration'
  | 'indexing'
  | 'provider'
  | 'permissions'
  | 'input'
  | 'lock'
  | 'unknown';

export interface SearchFailure {
  /** Stable machine-readable code; existing KBError codes are reused verbatim. */
  code: string;
  /** Coarse bucket for "what kind of problem is this?" */
  category: SearchFailureCategory;
  /** Operator-facing one-line summary. */
  message: string;
  /** A concrete next step the user/agent can take. */
  next_action: string;
  /** Extra structured fields surfaced for the lock-contention case (RFC 012 §4.8.3). */
  lock_path?: string;
  resource?: string;
}

const RUN_DOCTOR = 'Run `kb doctor` to diagnose backend, configuration, and index health.';

export function classifyKbSearchError(err: unknown): SearchFailure {
  if (err instanceof WriteLockContentionError) {
    return {
      code: err.code,
      category: 'lock',
      message: err.message,
      next_action:
        'Retry in a few seconds; only one `kb search --refresh` writer may run per model at a time.',
      lock_path: err.lockPath,
      resource: err.resource,
    };
  }

  if (err instanceof ActiveModelResolutionError) {
    return {
      code: 'ACTIVE_MODEL_UNRESOLVED',
      category: 'configuration',
      message: err.message,
      next_action:
        'Run `kb models list` to see registered models, then `kb models add <provider> <model>` or ' +
        '`kb models set-active <id>` to make one active. `kb doctor` shows the current resolution state.',
    };
  }

  if (err instanceof KBError) {
    return classifyKBError(err);
  }

  // Unknown thrown value — keep the original message but route the user to
  // the smoke check so they can categorise it themselves.
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'UNKNOWN',
    category: 'unknown',
    message,
    next_action: RUN_DOCTOR,
  };
}

function classifyKBError(err: KBError): SearchFailure {
  const code: KBErrorCode = err.code;
  switch (code) {
    case 'INDEX_NOT_INITIALIZED':
      return {
        code,
        category: 'indexing',
        message: err.message,
        next_action:
          'Build the index with `kb search --refresh` (or `kb models add <provider> <model>` if no model is registered yet).',
      };
    case 'CORRUPT_INDEX':
      return {
        code,
        category: 'indexing',
        message: err.message,
        next_action:
          'Re-build the index with `kb search --refresh`. If the failure repeats, run `kb doctor` to inspect the FAISS layout for this model.',
      };
    case 'PROVIDER_AUTH':
      return {
        code,
        category: 'configuration',
        message: err.message,
        next_action:
          'Set the provider API key (`OPENAI_API_KEY`, `HUGGINGFACE_API_KEY`) in the same shell you launch `kb` from. `kb doctor` reports which keys it sees.',
      };
    case 'PROVIDER_UNAVAILABLE':
      return {
        code,
        category: 'provider',
        message: err.message,
        next_action:
          'Verify the embedding backend is reachable (e.g. `ollama serve` for Ollama; provider status page for HuggingFace/OpenAI). `kb doctor` probes the configured backend.',
      };
    case 'PROVIDER_TIMEOUT':
      return {
        code,
        category: 'provider',
        message: err.message,
        next_action:
          'Retry once. If timeouts persist, check network/proxy settings and the provider status page; `kb doctor` runs a short reachability probe.',
      };
    case 'KB_NOT_FOUND':
      return {
        code,
        category: 'configuration',
        message: err.message,
        next_action:
          'Run `kb list` to see registered knowledge bases, then re-run search with a valid `--kb=<name>` (or omit it to search across all KBs).',
      };
    case 'PERMISSION_DENIED':
      return {
        code,
        category: 'permissions',
        message: err.message,
        next_action:
          'Grant the running user write access to `$FAISS_INDEX_PATH` and the `.index` directory inside each KB, then retry.',
      };
    case 'VALIDATION':
      return {
        code,
        category: 'input',
        message: err.message,
        next_action:
          'Adjust the input and retry. The message above names the rejected field.',
      };
    case 'INTERNAL':
      return {
        code,
        category: 'unknown',
        message: err.message,
        next_action: RUN_DOCTOR,
      };
    default: {
      // Exhaustiveness — if a new KBErrorCode is added, the switch above must
      // be updated. The fallthrough here keeps the runtime behaviour safe.
      const _exhaustive: never = code;
      void _exhaustive;
      return {
        code: String(code),
        category: 'unknown',
        message: err.message,
        next_action: RUN_DOCTOR,
      };
    }
  }
}

/** Stderr (markdown / human-mode) renderer. Always ends with a trailing newline. */
export function formatKbSearchFailureStderr(failure: SearchFailure): string {
  const lines = [
    `kb search: ${failure.message}`,
    `  category: ${failure.category} (code: ${failure.code})`,
    `  next: ${failure.next_action}`,
  ];
  if (failure.lock_path !== undefined) {
    lines.push(`  lock: ${failure.lock_path}`);
  }
  return `${lines.join('\n')}\n`;
}

/** JSON renderer for `--format=json` so agents can branch on `error.category`/`error.code`. */
export function formatKbSearchFailureJson(failure: SearchFailure): string {
  const error: Record<string, unknown> = {
    code: failure.code,
    category: failure.category,
    message: failure.message,
    next_action: failure.next_action,
  };
  if (failure.lock_path !== undefined) {
    error.lock_path = failure.lock_path;
  }
  if (failure.resource !== undefined) {
    error.resource = failure.resource;
  }
  return `${JSON.stringify({ error }, null, 2)}\n`;
}

/**
 * Map a classified failure to the CLI exit code:
 *   2 — argv / configuration / input problems the user can fix without retry.
 *   1 — runtime / index / provider / permission / lock problems.
 * Mirrors the codes documented in `cli.ts` HELP.
 */
export function exitCodeForFailure(failure: SearchFailure): number {
  if (failure.category === 'configuration' || failure.category === 'input') {
    return 2;
  }
  return 1;
}
