// error-codes-doc.ts
//
// Pure rendering for docs/reference/error-codes.md. Kept separate from
// scripts/gen-error-codes-doc.mjs (which owns file I/O and the CLI/--check
// entry point) so the rendering can be unit-tested directly against the
// in-source registries without a build or a child process.
//
// The `KBErrorCode` union in src/errors.ts is the source of truth for *which*
// codes exist; KB_ERROR_CODE_DOCS below is the source of truth for each code's
// operator-facing documentation. Typing the registry as
// `Record<KBErrorCode, KBErrorCodeDoc>` makes the compiler reject a doc row for
// an unknown code and require a row for every code — the same completeness the
// old regex-based src/errors-docs.test.ts checked, now enforced at build time.
// The generate-and-diff gate (scripts/gen-error-codes-doc.mjs --check) then
// catches drift in the rendered prose itself.

import type { KBErrorCode } from './errors.js';

export const ERROR_CODES_REFERENCE_PATH = 'docs/reference/error-codes.md';

export interface KBErrorCodeDoc {
  /** What the code means, one operator-facing sentence. */
  meaning: string;
  /** The typical conditions that raise it. */
  cause: string;
  /** The first action an operator should take. */
  remedy: string;
  /** Whether a retry after fixing the condition is a candidate. */
  transient: boolean;
}

// Ordered to match the `KBErrorCode` union in src/errors.ts so the rendered
// table is deterministic. The `Record<KBErrorCode, …>` type guarantees this
// map stays exhaustive and free of stray codes.
export const KB_ERROR_CODE_DOCS: Record<KBErrorCode, KBErrorCodeDoc> = {
  INDEX_NOT_INITIALIZED: {
    meaning: 'The active FAISS index is missing from memory or has not been built.',
    cause:
      'Search ran before `initialize` / `updateIndex`, or the active model was registered without an index refresh.',
    remedy:
      'Build the index with `kb search --refresh`; if no active model exists, register one with `kb models add`.',
    transient: false,
  },
  PROVIDER_UNAVAILABLE: {
    meaning: 'The embedding provider cannot be reached or returned an availability failure.',
    cause:
      'Ollama is stopped, a managed provider endpoint is down, DNS/proxy routing is broken, or a non-context Ollama 4xx was classified as unavailable.',
    remedy:
      'Run `kb doctor --format=json`, confirm the configured backend and endpoint, start/fix the provider, then retry.',
    transient: true,
  },
  PROVIDER_TIMEOUT: {
    meaning: 'The embedding provider did not complete within the request timeout.',
    cause: 'Slow provider response, network/proxy latency, overload, or a timed-out provider SDK call.',
    remedy:
      'Retry once; if it repeats, check provider health and network/proxy settings from the same environment that launches `kb`.',
    transient: true,
  },
  PROVIDER_AUTH: {
    meaning: 'Provider credentials are missing or invalid.',
    cause: '`OPENAI_API_KEY` or `HUGGINGFACE_API_KEY` is absent, expired, or not visible to the service process.',
    remedy:
      'Set the provider key in the launching environment and confirm `kb doctor` sees the expected provider configuration.',
    transient: false,
  },
  KB_NOT_FOUND: {
    meaning: 'The requested knowledge base does not exist or is not registered.',
    cause:
      'A misspelled `--kb` value, stale client configuration, missing KB root, or a document mutation targeted an unknown KB.',
    remedy: 'Run `kb list`, choose a registered KB, or restore/register the missing KB root before retrying.',
    transient: false,
  },
  PERMISSION_DENIED: {
    meaning: 'The running user cannot read or write a required KB or index path.',
    cause:
      'Filesystem errors such as `EACCES`, `EPERM`, or `EROFS` on `$FAISS_INDEX_PATH`, a KB root, or a `.index` directory.',
    remedy:
      'Grant the service user access to the affected path, remount writable storage if needed, then retry the original command.',
    transient: false,
  },
  CORRUPT_INDEX: {
    meaning: 'A committed index or lexical index artifact cannot be parsed or has an invalid shape.',
    cause: 'Truncated files, partial writes, incompatible artifact contents, or invalid JSON in lexical index data.',
    remedy:
      "Rebuild with `kb search --refresh`; if corruption repeats, run `kb doctor` and inspect the model's FAISS and lexical-index artifacts.",
    transient: false,
  },
  VALIDATION: {
    meaning: 'Caller input or derived request data failed validation before the operation could proceed.',
    cause: 'Empty paths, null bytes, path traversal, invalid KB names, unsupported arguments, or provider context-length validation.',
    remedy:
      'Fix the field named in the message and retry; for context-length failures, reduce chunk/query size or change model settings.',
    transient: false,
  },
  INTERNAL: {
    meaning: 'The server reached an unexpected or unclassified failure path.',
    cause:
      'A bug, unknown thrown value, malformed internal state, or an error that reached a boundary without a more specific `KBErrorCode`.',
    remedy:
      'Run `kb doctor --format=json`, capture canonical logs for the request, and file an issue with the command and environment details.',
    transient: false,
  },
  PREFACE_LLM_FAILURE: {
    meaning: 'Contextual-preface generation failed while calling or parsing the LLM.',
    cause:
      '`KB_LLM_ENDPOINT` is unreachable, the LLM returned malformed/refusal/truncated output, or a preface call failed during ingest/reindex.',
    remedy:
      'Probe the LLM endpoint from the service environment, fix the endpoint or model, then rerun ingest or contextual reindex.',
    transient: true,
  },
  PREFACE_SIDECAR_CORRUPT: {
    meaning: 'A contextual-preface sidecar is unreadable or inconsistent.',
    cause:
      'Corrupt sidecar JSON, partial sidecar writes, or sidecar content that no longer matches expected contextual-retrieval schema.',
    remedy:
      'Delete the offending sidecar under `$FAISS_INDEX_PATH/.contextual-prefaces/` so the next ingest can regenerate it.',
    transient: false,
  },
  REINDEX_LOCK_HELD: {
    meaning: 'A contextual reindex cannot start because another reindex owns the model lock.',
    cause: 'A live `kb reindex --with-context` run is active, or a previous run left a state file that still appears live.',
    remedy:
      'Check `kb reindex status --format=json`; wait for the active run or follow the incident runbook before removing any lock/state file.',
    transient: true,
  },
  REINDEX_BUDGET_EXCEEDED: {
    meaning: 'The contextual reindex estimate exceeds the configured quiet-window budget.',
    cause: 'The estimated runtime would cross the LRA cron window or configured reindex budget guard.',
    remedy:
      'Schedule the run inside the quiet window, reduce scope where supported, or pass `--force` only when the operator accepts the risk.',
    transient: false,
  },
  INSUFFICIENT_DISK_SPACE: {
    meaning:
      'A write-heavy preflight (reindex, backup, or restore) estimated more bytes than the target volume can hold.',
    cause:
      'Estimated source footprint times the operation factor, plus the `KB_MIN_FREE_DISK_BYTES` margin, exceeds the `statfs`-reported free space on the target directory (`$FAISS_INDEX_PATH` for reindex/restore, backup `--output` parent for backup); the run refused before writing.',
    remedy:
      'Free disk space on the target volume (prune old index versions, clear caches, choose a roomier `--output`) or lower `KB_MIN_FREE_DISK_BYTES`, then retry.',
    transient: false,
  },
};

export interface AskCliErrorCodeDoc {
  code: string;
  category: string;
  meaning: string;
  remedy: string;
  /** Display value: `Yes`, `No`, or `Unknown`. */
  transient: string;
}

// Command-local classified codes emitted by `kb ask --format=json`, defined in
// src/search-errors-core.ts. Hand-maintained here (they are not enumerated in a
// single exported registry the way KBErrorCode is); keep in sync with that file
// when adding an ask-local code. Tracked as a follow-up to wire these to their
// source. Rendered as a second table below the shared taxonomy.
export const ASK_CLI_ERROR_CODES: AskCliErrorCodeDoc[] = [
  {
    code: 'ASK_ARGUMENT_INVALID',
    category: 'input',
    meaning: 'The ask command line is missing or rejects an argument.',
    remedy: 'Fix the argv shown in `error.message`; run `kb ask --help` for usage.',
    transient: 'No',
  },
  {
    code: 'ASK_CONTEXT_BUDGET_INVALID',
    category: 'input',
    meaning: '`--context-budget-tokens` is not an integer at or above the minimum.',
    remedy: 'Pass `--context-budget-tokens=<int>` with a value of at least 64.',
    transient: 'No',
  },
  {
    code: 'ASK_LLM_PROFILE_INVALID',
    category: 'configuration',
    meaning: 'The selected or active `kb llm` profile is malformed or unreadable.',
    remedy: 'Run `kb llm status --format=json`, repair the profile, or choose a valid `--llm-profile`.',
    transient: 'No',
  },
  {
    code: 'ASK_LLM_AUTH',
    category: 'configuration',
    meaning: 'The LLM provider rejected credentials.',
    remedy: 'Fix provider credentials in the environment used to launch `kb`, then probe the endpoint.',
    transient: 'No',
  },
  {
    code: 'ASK_LLM_RATE_LIMITED',
    category: 'external',
    meaning: 'The LLM provider returned HTTP 429.',
    remedy: 'Wait for quota/rate limit recovery, then retry.',
    transient: 'Yes',
  },
  {
    code: 'ASK_LLM_ENDPOINT_UNREACHABLE',
    category: 'external',
    meaning: 'The answer LLM endpoint is unreachable, timed out, or returned a transient/server failure.',
    remedy: 'Start or fix the configured endpoint, then run `kb llm probe --endpoint=<url>`.',
    transient: 'Yes',
  },
  {
    code: 'ASK_LLM_RESPONSE_INVALID',
    category: 'external',
    meaning: 'The endpoint answered but not with a usable OpenAI-compatible chat completion.',
    remedy: 'Probe the endpoint and fix the service/model response shape.',
    transient: 'No',
  },
  {
    code: 'ASK_LLM_REQUEST_FAILED',
    category: 'external',
    meaning: 'The LLM call failed outside a recognized `LlmClientError` path.',
    remedy: 'Check `kb llm status --format=json` and probe the configured endpoint.',
    transient: 'Unknown',
  },
  {
    code: 'ASK_TRANSCRIPT_EXISTS',
    category: 'input',
    meaning: '`--save-transcript` would overwrite an existing note.',
    remedy: 'Choose a different `--title` or remove the existing transcript note.',
    transient: 'No',
  },
  {
    code: 'ASK_TRANSCRIPT_PERMISSION_DENIED',
    category: 'permissions',
    meaning: 'Transcript write failed with a filesystem permission/read-only error.',
    remedy: 'Grant write access to the target KB directory, then retry.',
    transient: 'No',
  },
  {
    code: 'ASK_TRANSCRIPT_WRITE_FAILED',
    category: 'unknown',
    meaning: 'Transcript write failed without a more specific errno classification.',
    remedy: 'Check the target KB path and disk state, then retry.',
    transient: 'Unknown',
  },
];

// Markdown table cells cannot contain a raw `|`; escape it. Newlines are folded
// so a multi-line source string still renders as one row.
function tableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

export function renderErrorCodesMarkdown(
  codeDocs: Record<string, KBErrorCodeDoc> = KB_ERROR_CODE_DOCS,
  askCodes: AskCliErrorCodeDoc[] = ASK_CLI_ERROR_CODES,
): string {
  const lines: string[] = [
    '# KB Error Codes',
    '',
    '<!-- This file is generated by scripts/gen-error-codes-doc.mjs. Do not edit by hand. -->',
    '',
    'The shared taxonomy table is generated from the `KBErrorCode` union in',
    '`src/errors.ts` and the per-code documentation registry `KB_ERROR_CODE_DOCS`',
    'in `src/error-codes-doc.ts`. Run `npm run docs:gen-error-codes` after adding or',
    'changing a code and commit the result; the `docs:check-error-codes` gate (part',
    'of `npm run check`) fails if this file drifts.',
    '',
    'This reference documents the stable `KBErrorCode` values emitted by the server',
    'and CLI, plus command-local classified CLI codes where a command has a stable',
    'JSON error envelope. Operators can see these codes in classified CLI JSON',
    'failures under `error.code`, MCP tool error payloads, and canonical logs from',
    'server-side and reindex paths that preserve `KBError` details. Some CLI wrappers',
    'log only their process exit class, such as `EXIT_1` or `EXIT_2`, so prefer the',
    "command's JSON error payload when available. Contextual-retrieval ingest can",
    'also surface related per-chunk sidecar `error_code` values; those are',
    'lower-level diagnostics, while the first table below is the operator-facing',
    'taxonomy from `src/errors.ts`.',
    '',
    'Use the code to decide the first response. Message text is diagnostic prose and',
    'can change between releases.',
    '',
    '## Reference',
    '',
    '| Code | Meaning | Typical Cause | Operator Remedy | Transient? |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(codeDocs).map(
      ([code, doc]) =>
        `| \`${code}\` | ${tableCell(doc.meaning)} | ${tableCell(doc.cause)} | ${tableCell(doc.remedy)} | ${doc.transient ? 'Yes' : 'No'} |`,
    ),
    '',
    '## Response Guidance',
    '',
    'Treat `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PREFACE_LLM_FAILURE`, and',
    '`REINDEX_LOCK_HELD` as retry candidates after the underlying condition is fixed',
    'or the competing process exits. The remaining codes are terminal for the',
    'current request: change input, configuration, credentials, permissions, or index',
    'state before retrying.',
    '',
    'For symptom-first triage, start with',
    '[`docs/operations/incident-response.md`](../operations/incident-response.md).',
    'For JSON output shapes, see',
    '[`docs/cli-json-contracts.md`](../cli-json-contracts.md).',
    '',
    '## `kb ask` CLI Codes',
    '',
    '`kb ask --format=json` uses the same classified envelope shape as dense',
    '`kb search`: `error.code`, `error.category`, `error.message`, and',
    '`error.next_action`. It can emit the shared `KBErrorCode` values above for',
    'retrieval/index/model failures and the ask-local codes below for argument, LLM,',
    'and transcript paths.',
    '',
    '| Code | Category | Meaning | Operator Remedy | Transient? |',
    '| --- | --- | --- | --- | --- |',
    ...askCodes.map(
      (entry) =>
        `| <code>${entry.code}</code> | \`${entry.category}\` | ${tableCell(entry.meaning)} | ${tableCell(entry.remedy)} | ${entry.transient} |`,
    ),
  ];

  return `${lines.join('\n')}\n`;
}
