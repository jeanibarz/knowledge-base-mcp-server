// RFC 017 M0b — `kb reindex --with-context` CLI subcommand.
//
// Thin argv-parsing wrapper around `runReindex` in
// `src/reindex-runner.ts`. Keep this module small: option parsing,
// help text, exit-code mapping. All orchestration logic (guards,
// run-state file, PID liveness, dispatch into `updateIndex`) lives
// in the runner so it's unit-testable without spawning a child
// process.

import { runReindex, type ReindexResult } from './reindex-runner.js';
import {
  computeReindexProgress,
  reindexProgressFilePath,
  writeReindexProgress,
  type ReindexProgress,
} from './reindex-progress.js';
import { isContextualRetrievalEnabled } from './config/contextual-preface.js';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { assertSufficientDiskSpace } from './disk-preflight.js';
import { KBError } from './errors.js';
import { logger } from './logger.js';

export const REINDEX_HELP = `kb reindex — rebuild FAISS indexes (RFC 017)

Usage:
  kb reindex --with-context [--kb=<name>...] [--force]
  kb reindex status [--kb=<name>...] [--format=md|json]

The \`--with-context\` flag is REQUIRED in this milestone (M0b). It runs
the contextual-retrieval ingest path: per-chunk LLM-generated prefaces
are prepended for embedding while the docstore content stays
byte-identical. The initial cold backfill rebuilds the full active FAISS
index so existing vectors become contextual. After the contextual
sidecar cache is warm, follow-up runs use the normal incremental refresh
path and only re-embed changed/appended chunks unless FAISS deletion
limits require a full rebuild. The \`KB_CONTEXTUAL_RETRIEVAL=on\`
environment variable must also be set; the CLI emits a warning
otherwise.

Behavior:
  - Refuses to start inside the LRA cron window (06:00-10:30 UTC) or
    when the estimated runtime would cross it; pass --force to bypass
    both guards.
  - The runtime estimate is cache-aware: only chunks without a valid
    contextual-preface sidecar are priced at the 8s cold-LLM ceiling, so
    a reindex resumed after a partial run is not blocked for work it
    would skip. The breakdown is reported as \`contextual_estimate\`.
  - Writes a run-state file at \`$FAISS_INDEX_PATH/.reindex.run.json\`
    so the trigger watcher (RFC 014) defers its own updates until the
    reindex finishes. The file is deleted on exit (and zombie-cleaned
    by any later observer that finds its PID dead).
  - Delegates the actual refresh to \`FaissIndexManager.updateIndex()\`
    using \`force: true\` only while contextual-preface chunks are cold.
    Warm follow-up runs use \`force: false\`, the same incremental
    machinery as \`kb search --refresh\`. The \`undefined\` scope argument
    is deliberate for forced backfills: the rebuild is global and
    \`--kb\` never narrows it (see below).
  - When \`KB_CONTEXTUAL_RETRIEVAL=on\`, prints a \`contextual:\` line
    summarising preface coverage and failures (covered / failed /
    retry-pending chunks, with an error-code breakdown) read back from
    the sidecars the run persisted. \`kb stats\` reports the same per-KB.

Notes:
  The \`status\` subcommand reports contextual-preface progress derived
  from the durable per-source sidecars under
  \`$FAISS_INDEX_PATH/.contextual-prefaces/\`. Run it after a SIGINT,
  crash, or host reboot to see which files completed their LLM preface
  work, which failed, and which still need it. It does not touch the
  index; it also materializes the rollup to
  \`$FAISS_INDEX_PATH/.reindex.progress.json\`. To resume an interrupted
  reindex, re-run \`kb reindex --with-context\`: completed files are
  served from the sidecar cache and only pending / failed chunks call
  the LLM.

Options:
  --with-context        Required in M0b. Required for the CLI to do
                        anything except the \`status\` subcommand;
                        without it, exit code 2.
  --kb=<name>           Guard/estimator hint only — NOT a scoped
                        rebuild. The FAISS index is single-index-per-
                        model with every KB co-located, so a partial
                        forced rebuild would orphan the other shelves'
                        vectors; cold backfills therefore remain global.
                        --kb only narrows the chunk-count estimate and
                        the cron-window guard arithmetic, and is
                        validated against registered KBs (unknown name
                        -> exit 2). Repeat for multiple KBs. Default:
                        every registered KB. Status: limit the report to
                        this KB.
  --force               Bypass the LRA cron window guard AND the
                        self-runtime-budget guard. Required to start
                        a reindex inside 06:00-10:30 UTC or when the
                        run is estimated to cross that window.
  --format=md|json      Output format for \`status\` (default: md).
  --help, -h            Show this help.

Exit codes:
  0   success — index swapped / status reported
  1   updateIndex reported partial or failed status
  2   argv / env error (e.g. --kb=<missing>, missing --with-context)
  3   guard blocked the run (inside or crossing the LRA window)
  4   another reindex is already running on the same model
  5   disk-space preflight failed (estimated write exceeds free space
      minus the KB_MIN_FREE_DISK_BYTES margin); nothing was written (#645)
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
  // `kb reindex status` is a separate read-only subcommand (#407) — it
  // does not run a rebuild and does not need `--with-context`.
  if (rest[0] === 'status') {
    return runReindexStatusCli(rest.slice(1));
  }

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

  // #645 — disk-space preflight. A reindex writes a fresh FAISS index
  // version, docstore, sidecars, and lexical indexes under
  // $FAISS_INDEX_PATH before the atomic swap; refuse up front when the
  // volume cannot hold the estimate (+ margin) instead of failing with a
  // raw ENOSPC partway through an expensive run.
  try {
    await assertSufficientDiskSpace(FAISS_INDEX_PATH);
  } catch (err) {
    if (err instanceof KBError && err.code === 'INSUFFICIENT_DISK_SPACE') {
      process.stderr.write(`kb reindex: ${err.message}\n`);
      return 5;
    }
    throw err;
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
  const est = result.contextual_estimate;
  lines.push(`kb reindex: ${result.outcome}`);
  lines.push(`  kbs_attempted:         ${result.kbs_attempted}`);
  lines.push(`  total_chunks_estimate: ${result.total_chunks_estimate}`);
  lines.push(
    `  contextual_estimate:   cold=${est.cold_chunks} ` +
      `cache_hits=${est.cache_hits} retry_skips=${est.retry_skips}`,
  );
  lines.push(`  estimated_seconds:     ${result.estimated_seconds}`);
  lines.push(`  took_ms:               ${result.took_ms}`);
  if (result.reason !== null) {
    lines.push(`  reason: ${result.reason}`);
  }
  if (result.summary !== null) {
    lines.push(
      `  summary: files_scanned=${result.summary.files_scanned ?? 0} ` +
        `files_changed=${result.summary.files_changed ?? 0} ` +
        `files_unchanged=${result.summary.files_unchanged ?? 0} ` +
        `warnings=${result.summary.warning_count ?? 0} ` +
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

// ---------------------------------------------------------------------------
// `kb reindex status` — contextual-preface progress ledger (#407)
// ---------------------------------------------------------------------------

interface ReindexStatusArgs {
  knowledgeBases: string[];
  format: 'md' | 'json';
}

function parseReindexStatusArgs(rest: string[]): ReindexStatusArgs {
  const out: ReindexStatusArgs = { knowledgeBases: [], format: 'md' };
  for (const arg of rest) {
    if (arg.startsWith('--kb=')) {
      const value = arg.slice('--kb='.length);
      if (value.length === 0) throw new Error('empty --kb=<name> value');
      out.knowledgeBases.push(value);
      continue;
    }
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format: ${arg} (expected md or json)`);
      }
      out.format = value;
      continue;
    }
    throw new Error(`unknown option '${arg}'`);
  }
  return out;
}

/** Test seam: stdout / stderr sinks. Production uses the process streams. */
export interface ReindexStatusDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_STATUS_DEPS: ReindexStatusDeps = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runReindexStatusCli(
  rest: string[],
  deps: ReindexStatusDeps = DEFAULT_STATUS_DEPS,
): Promise<number> {
  let parsed: ReindexStatusArgs;
  try {
    parsed = parseReindexStatusArgs(rest);
  } catch (err) {
    deps.stderr(`kb reindex status: ${(err as Error).message}\n`);
    return 2;
  }

  let progress: ReindexProgress;
  try {
    progress = await computeReindexProgress({ knowledgeBases: parsed.knowledgeBases });
  } catch (err) {
    deps.stderr(`kb reindex status: ${(err as Error).message}\n`);
    return 1;
  }

  // Materialize the durable ledger. Best-effort: a write failure must
  // not fail the report — the computed snapshot is the primary output.
  let ledgerPath: string | null = null;
  try {
    await writeReindexProgress(progress);
    ledgerPath = reindexProgressFilePath();
  } catch (err) {
    logger.warn(`#407: failed to write reindex progress ledger: ${(err as Error).message}`);
  }

  if (parsed.format === 'json') {
    deps.stdout(`${JSON.stringify(progress, null, 2)}\n`);
  } else {
    deps.stdout(formatReindexProgressMarkdown(progress, ledgerPath));
  }
  return 0;
}

// Cap the per-KB incomplete-file listing so a large damaged corpus does
// not flood the terminal; the full list is always in --format=json.
const MAX_LISTED_INCOMPLETE_FILES = 20;

export function formatReindexProgressMarkdown(
  progress: ReindexProgress,
  ledgerPath: string | null,
): string {
  const lines: string[] = [];
  lines.push('kb reindex status — contextual-preface progress');
  lines.push('');

  if (progress.run_active && progress.run !== null) {
    lines.push(
      `Reindex run: IN PROGRESS — PID ${progress.run.pid}, started ${progress.run.started_at}`,
    );
    const scope = progress.run.kbs_in_scope;
    lines.push(`  scope: ${scope.length === 0 ? 'every KB' : scope.join(', ')}`);
  } else {
    lines.push('Reindex run: not running');
  }
  lines.push('');

  if (progress.kbs.length === 0) {
    lines.push('No contextual-preface sidecars found.');
    lines.push('Nothing has been reindexed with KB_CONTEXTUAL_RETRIEVAL=on yet, or the');
    lines.push('sidecar cache under $FAISS_INDEX_PATH/.contextual-prefaces is empty.');
  } else {
    for (const kb of progress.kbs) {
      lines.push(kb.knowledge_base);
      lines.push(
        `  files:  ${kb.files_complete} complete, ${kb.files_incomplete} incomplete, ` +
          `${kb.files_pending} pending  (${kb.files_indexed} indexed, ` +
          `${kb.files_with_sidecar} with sidecars)`,
      );
      lines.push(`  chunks: ${kb.chunks_resolved} resolved, ${kb.chunks_failed} failed`);
      const incomplete = kb.files.filter((f) => f.status === 'incomplete');
      if (incomplete.length > 0) {
        lines.push('  incomplete files:');
        for (const file of incomplete.slice(0, MAX_LISTED_INCOMPLETE_FILES)) {
          const codes =
            file.error_codes.length > 0 ? `, errors: ${file.error_codes.join('/')}` : '';
          lines.push(
            `    - ${file.source}  ` +
              `(${file.chunks_resolved}/${file.chunks_total} chunks${codes})`,
          );
        }
        if (incomplete.length > MAX_LISTED_INCOMPLETE_FILES) {
          lines.push(
            `    … and ${incomplete.length - MAX_LISTED_INCOMPLETE_FILES} ` +
              'more (see --format=json)',
          );
        }
      }
      lines.push('');
    }

    const t = progress.totals;
    lines.push(
      `Totals: ${t.knowledge_bases} KB(s) — ${t.files_complete} complete, ` +
        `${t.files_incomplete} incomplete, ${t.files_pending} pending; ` +
        `${t.chunks_resolved} chunks resolved, ${t.chunks_failed} failed`,
    );
    lines.push('');

    if (t.files_with_sidecar === 0 && t.files_pending === 0) {
      lines.push('No contextual-preface work is recorded for the reported KB(s).');
    } else if (t.files_incomplete + t.files_pending === 0) {
      lines.push('Every sidecar-covered file has a complete set of contextual prefaces.');
    } else if (progress.run_active) {
      lines.push('A reindex is in progress; re-run `kb reindex status` to refresh.');
    } else {
      lines.push('To resume, re-run `kb reindex --with-context`. Files with complete');
      lines.push('sidecars are served from the preface cache; only pending and failed');
      lines.push('chunks call the LLM.');
    }
  }

  if (ledgerPath !== null) {
    lines.push('');
    lines.push(`Ledger written to ${ledgerPath}`);
  }
  return `${lines.join('\n')}\n`;
}

// Compatibility re-export for the CLI registry (matches the
// `run<Subcommand>` naming convention used in cli.ts).
export const runReindex_cli = runReindexCli;
