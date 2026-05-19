// RFC 017 M0b — `kb reindex --with-context` CLI subcommand.
//
// Thin argv-parsing wrapper around `runReindex` in
// `src/reindex-runner.ts`. Keep this module small: option parsing,
// help text, exit-code mapping. All orchestration logic (guards,
// run-state file, PID liveness, dispatch into `updateIndex`) lives
// in the runner so it's unit-testable without spawning a child
// process.

import { runReindex, type ReindexResult } from './reindex-runner.js';
import { isContextualRetrievalEnabled } from './config/contextual-preface.js';
import { logger } from './logger.js';

export const REINDEX_HELP = `kb reindex — rebuild FAISS indexes (RFC 017)

Usage:
  kb reindex --with-context [--kb=<name>...] [--force]

The \`--with-context\` flag is REQUIRED in this milestone (M0b). It
triggers a full rebuild of every in-scope KB through the contextual-
retrieval ingest path: per-chunk LLM-generated prefaces are prepended
for embedding while the docstore content stays byte-identical. The
\`KB_CONTEXTUAL_RETRIEVAL=on\` environment variable must also be set;
the CLI emits a warning otherwise.

Behavior:
  - Refuses to start inside the LRA cron window (06:00-10:30 UTC) or
    when the estimated runtime would cross it; pass --force to bypass
    both guards.
  - Writes a run-state file at \`$FAISS_INDEX_PATH/.reindex.run.json\`
    so the trigger watcher (RFC 014) defers its own updates until the
    reindex finishes. The file is deleted on exit (and zombie-cleaned
    by any later observer that finds its PID dead).
  - Delegates the actual rebuild to
    \`FaissIndexManager.updateIndex(undefined, { force: true })\` —
    same machinery the existing \`kb search --refresh\` path uses, so
    sidecar invalidation, error handling, and atomic FAISS swaps come
    for free.
  - When \`KB_CONTEXTUAL_RETRIEVAL=on\`, prints a \`contextual:\` line
    summarising preface coverage and failures (covered / failed /
    retry-pending chunks, with an error-code breakdown) read back from
    the sidecars the run persisted. \`kb stats\` reports the same per-KB.

Options:
  --with-context        Required in M0b. Required for the CLI to do
                        anything; without it, exit code 2.
  --kb=<name>           Limit reindex to this KB. Repeat the flag for
                        multiple KBs. Default: every registered KB.
  --force               Bypass the LRA cron window guard AND the
                        self-runtime-budget guard. Required to start
                        a reindex inside 06:00-10:30 UTC or when the
                        run is estimated to cross that window.
  --help, -h            Show this help.

Exit codes:
  0   success — index swapped, sidecars persisted
  1   updateIndex reported partial or failed status
  2   argv / env error (e.g. --kb=<missing>)
  3   guard blocked the run (inside or crossing the LRA window)
  4   another reindex is already running on the same model
`;

interface ReindexArgs {
  withContext: boolean;
  knowledgeBases: string[];
  force: boolean;
}

function parseReindexArgs(rest: string[]): ReindexArgs {
  const out: ReindexArgs = {
    withContext: false,
    knowledgeBases: [],
    force: false,
  };
  for (const arg of rest) {
    if (arg === '--with-context') {
      out.withContext = true;
      continue;
    }
    if (arg === '--force') {
      out.force = true;
      continue;
    }
    if (arg.startsWith('--kb=')) {
      const value = arg.slice('--kb='.length);
      if (value.length === 0) {
        throw new Error(`empty --kb=<name> value`);
      }
      out.knowledgeBases.push(value);
      continue;
    }
    throw new Error(`unknown option '${arg}'`);
  }
  return out;
}

export async function runReindexCli(rest: string[]): Promise<number> {
  let parsed: ReindexArgs;
  try {
    parsed = parseReindexArgs(rest);
  } catch (err) {
    process.stderr.write(`kb reindex: ${(err as Error).message}\n`);
    return 2;
  }

  if (!parsed.withContext) {
    process.stderr.write(
      'kb reindex: --with-context is required in this release (RFC 017 M0b). ' +
        'Other reindex modes are deferred to a follow-up.\n',
    );
    return 2;
  }

  if (!isContextualRetrievalEnabled()) {
    process.stderr.write(
      'kb reindex: KB_CONTEXTUAL_RETRIEVAL is not set to "on". ' +
        'The reindex will run, but newly-embedded chunks will not carry contextual prefaces — ' +
        'i.e. it would behave like a force-rebuild without the feature. Set the env var first if that is unintended.\n',
    );
  }

  let result: ReindexResult;
  try {
    result = await runReindex({
      knowledgeBases: parsed.knowledgeBases,
      force: parsed.force,
    });
  } catch (err) {
    const message = (err as Error).message;
    const code = (err as { code?: unknown }).code;
    if (code === 'KB_NOT_FOUND') {
      process.stderr.write(`kb reindex: ${message}\n`);
      return 2;
    }
    process.stderr.write(`kb reindex: ${message}\n`);
    return 1;
  }

  process.stdout.write(formatHumanResult(result));

  switch (result.outcome) {
    case 'completed':
      return 0;
    case 'partial':
    case 'failed':
      return 1;
    case 'guard_blocked':
      return 3;
    case 'lock_held':
      return 4;
  }
}

function formatHumanResult(result: ReindexResult): string {
  const lines: string[] = [];
  lines.push(`kb reindex: ${result.outcome}`);
  lines.push(`  kbs_attempted:        ${result.kbs_attempted}`);
  lines.push(`  total_chunks_estimate: ${result.total_chunks_estimate}`);
  lines.push(`  estimated_seconds:    ${result.estimated_seconds}`);
  lines.push(`  took_ms:              ${result.took_ms}`);
  if (result.reason !== null) {
    lines.push(`  reason: ${result.reason}`);
  }
  if (result.summary !== null) {
    lines.push(
      `  summary: files_scanned=${result.summary.files_scanned ?? 0} ` +
        `files_changed=${result.summary.files_changed ?? 0} ` +
        `files_unchanged=${result.summary.files_unchanged ?? 0} ` +
        `failures=${result.summary.failure_count ?? 0}`,
    );
  }
  if (result.contextual !== null) {
    // #409 — surface contextual-preface cache / failure counters so the
    // operator sees rollout health without grepping debug logs.
    const c = result.contextual;
    const errors = Object.entries(c.failures_by_error_code)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .map(([code, count]) => `${code}=${count}`)
      .join(', ');
    lines.push(
      `  contextual: covered=${c.covered_chunks} ` +
        `failed=${c.null_preface_chunks} ` +
        `retry_pending=${c.retry_pending_chunks}` +
        (errors.length > 0 ? ` errors=[${errors}]` : ''),
    );
  }
  return lines.join('\n') + '\n';
}

// Compatibility re-export for the CLI registry (matches the
// `run<Subcommand>` naming convention used in cli.ts).
export const runReindex_cli = runReindexCli;
