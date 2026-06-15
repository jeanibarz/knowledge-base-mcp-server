// Issue #199 — classify and format `kb search` failures so each common
// failure mode (server reachability, configuration, indexing, provider/API,
// permissions, input) renders a distinct, actionable error.
//
// `kb doctor` is the documented availability smoke check; whenever a
// failure could be diagnosed by it, the next-action string says so. The
// classifier is deliberately conservative: unknown errors fall into the
// `unknown` bucket with `kb doctor` as the next action rather than
// pretending we know more than we do.
//
// This is the command-independent core: it is consumed by `cli-search`,
// `cli-ask`, `cli-stats`, `cli-explain`, and the ingest-quarantine
// classifier. CLI adapters should import from here, not from a sibling
// CLI command module (issue #341 boundary fix).

import { ActiveModelResolutionError } from './active-model.js';
import { KBError, type KBErrorCode } from './errors.js';
import { LlmClientError } from './llm-client.js';
import { RerankerConfigError } from './config/reranker.js';
import { WriteLockContentionError } from './write-lock.js';

export type SearchFailureCategory =
  | 'configuration'
  | 'indexing'
  | 'provider'
  | 'external'
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
const ASK_HELP_NEXT_ACTION = 'Fix the command arguments and retry. Run `kb ask --help` for usage.';

export type AskFailureKind =
  | 'argument'
  | 'llm-profile'
  | 'llm-chat'
  | 'transcript'
  | 'runtime';

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

  if (err instanceof RerankerConfigError) {
    return {
      code: err.code,
      category: 'configuration',
      message: err.message,
      next_action:
        'Fix KB_RERANK and KB_RERANK_TOP_N, or pass `--no-rerank` for this search. `kb doctor` reports reranker configuration.',
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

export function classifyKbAskError(err: unknown, kind: AskFailureKind): SearchFailure {
  if (kind === 'runtime') {
    return classifyKbSearchError(err);
  }

  const message = errorMessage(err);
  if (kind === 'argument') {
    if (message.includes('--context-budget-tokens')) {
      return {
        code: 'ASK_CONTEXT_BUDGET_INVALID',
        category: 'input',
        message,
        next_action: 'Pass `--context-budget-tokens=<int>` with a value of at least 64, then retry.',
      };
    }
    return {
      code: 'ASK_ARGUMENT_INVALID',
      category: 'input',
      message,
      next_action: ASK_HELP_NEXT_ACTION,
    };
  }

  if (kind === 'llm-profile') {
    return {
      code: 'ASK_LLM_PROFILE_INVALID',
      category: 'configuration',
      message,
      next_action:
        'Run `kb llm status --format=json` to inspect the active profile, then fix it with `kb llm use-endpoint <url> --profile=<name>` or choose a valid `--llm-profile=<name>`.',
    };
  }

  if (kind === 'llm-chat') {
    return classifyAskLlmError(err, message);
  }

  return classifyAskTranscriptError(err, message);
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
    // RFC 017 — contextual-retrieval failure surfaces. None of these are
    // reachable from the search path today (they originate at ingest time
    // and during M0b's reindex CLI), so the search-error mapping keeps a
    // generic recovery hint. Wired into the exhaustiveness check so
    // adding more codes still fails the compile if forgotten.
    case 'PREFACE_LLM_FAILURE':
      return {
        code,
        category: 'external',
        message: err.message,
        next_action:
          'A previous contextual-preface generation failed. Confirm `KB_LLM_ENDPOINT` is reachable and re-run ingest; the failure is retried automatically per RFC 017 backoff schedule.',
      };
    case 'PREFACE_SIDECAR_CORRUPT':
      return {
        code,
        category: 'indexing',
        message: err.message,
        next_action:
          'Delete the offending contextual-preface sidecar under `$FAISS_INDEX_PATH/.contextual-prefaces/` to force regeneration on the next ingest.',
      };
    case 'REINDEX_LOCK_HELD':
      return {
        code,
        category: 'lock',
        message: err.message,
        next_action:
          'Another `kb reindex` is in progress on this model. Wait for it to finish, then retry.',
      };
    case 'REINDEX_BUDGET_EXCEEDED':
      return {
        code,
        category: 'input',
        message: err.message,
        next_action:
          'The estimated reindex runtime would cross the LRA cron window (06:00-10:30 UTC). Schedule the run for the quiet window or pass `--force`.',
      };
    // #645 — disk-space preflight refusal. Not reachable from the search
    // path (it originates in the reindex/ingest entry path), but wired in to
    // keep the exhaustiveness check honest when the code is added.
    case 'INSUFFICIENT_DISK_SPACE':
      return {
        code,
        category: 'input',
        message: err.message,
        next_action:
          'Free disk space under `$FAISS_INDEX_PATH` (or lower `KB_MIN_FREE_DISK_BYTES`) and retry; the reindex/ingest refused before writing.',
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
  return formatClassifiedFailureStderr('kb search', failure);
}

/** JSON renderer for `--format=json` so agents can branch on `error.category`/`error.code`. */
export function formatKbSearchFailureJson(failure: SearchFailure): string {
  return formatClassifiedFailureJson(failure);
}

/** Stderr renderer for `kb ask` classified failures. Always ends with a trailing newline. */
export function formatKbAskFailureStderr(failure: SearchFailure): string {
  return formatClassifiedFailureStderr('kb ask', failure);
}

/**
 * JSON renderer for `kb ask --format=json` classified failures.
 *
 * `error_text` intentionally preserves the former one-line string shape for
 * display-oriented callers while `error` becomes the stable classified object.
 */
export function formatKbAskFailureJson(failure: SearchFailure): string {
  return formatClassifiedFailureJson(failure, {
    legacyErrorText: `kb ask: ${failure.message}`,
  });
}

function formatClassifiedFailureStderr(command: string, failure: SearchFailure): string {
  const lines = [
    `${command}: ${failure.message}`,
    `  category: ${failure.category} (code: ${failure.code})`,
    `  next: ${failure.next_action}`,
  ];
  if (failure.lock_path !== undefined) {
    lines.push(`  lock: ${failure.lock_path}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatClassifiedFailureJson(
  failure: SearchFailure,
  options: { legacyErrorText?: string } = {},
): string {
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
  // Issue #181 backward-compat: `error.retry_hint` was the original
  // lock-contention contract. Keep it as an alias of `next_action` for
  // lock failures so existing agents that branch on `REFRESH_LOCK_BUSY`
  // and read `retry_hint` keep working under the unified envelope.
  if (failure.category === 'lock') {
    error.retry_hint = failure.next_action;
  }
  return `${JSON.stringify({
    error,
    ...(options.legacyErrorText !== undefined ? { error_text: options.legacyErrorText } : {}),
  }, null, 2)}\n`;
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

function classifyAskLlmError(err: unknown, message: string): SearchFailure {
  if (err instanceof LlmClientError) {
    if (err.status === 401 || err.status === 403) {
      return {
        code: 'ASK_LLM_AUTH',
        category: 'configuration',
        message,
        next_action:
          'Fix the LLM provider credentials in the environment used to launch `kb`, then run `kb llm probe --endpoint=<url>`.',
      };
    }
    if (err.status === 429) {
      return {
        code: 'ASK_LLM_RATE_LIMITED',
        category: 'external',
        message,
        next_action:
          'Wait for the LLM provider rate limit to clear, then retry `kb ask`; check provider quota if this repeats.',
      };
    }
    if (err.transient === true || err.status === undefined || err.status >= 500) {
      return {
        code: 'ASK_LLM_ENDPOINT_UNREACHABLE',
        category: 'external',
        message,
        next_action:
          'Start or fix the configured LLM endpoint, then run `kb llm probe --endpoint=<url>` from the same shell.',
      };
    }
    return {
      code: 'ASK_LLM_RESPONSE_INVALID',
      category: 'external',
      message,
      next_action:
        'Probe the LLM endpoint with `kb llm probe --endpoint=<url>` and verify it returns OpenAI-compatible chat completions.',
    };
  }

  return {
    code: 'ASK_LLM_REQUEST_FAILED',
    category: 'external',
    message,
    next_action:
      'Check the configured LLM endpoint with `kb llm status --format=json` and `kb llm probe --endpoint=<url>`, then retry.',
  };
}

function classifyAskTranscriptError(err: unknown, message: string): SearchFailure {
  if (message.includes('refusing to overwrite existing transcript')) {
    return {
      code: 'ASK_TRANSCRIPT_EXISTS',
      category: 'input',
      message,
      next_action: 'Choose a different `--title` or remove the existing transcript note, then retry.',
    };
  }

  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return {
      code: 'ASK_TRANSCRIPT_PERMISSION_DENIED',
      category: 'permissions',
      message,
      next_action:
        'Grant the running user write access to the target knowledge base directory, then retry `kb ask --save-transcript`.',
    };
  }

  return {
    code: 'ASK_TRANSCRIPT_WRITE_FAILED',
    category: 'unknown',
    message,
    next_action:
      'Check the target knowledge base path and disk state, then retry `kb ask --save-transcript`.',
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
