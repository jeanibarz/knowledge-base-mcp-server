// `kb search` freshness-footer helpers driven by the per-KB time-based
// age budget (issue #218).
//
// Content-modification staleness (`modified_files` / `new_files`) is
// handled by `cli-search.ts:formatFreshnessFooter`; this module is a
// separate, orthogonal layer that surfaces a wall-clock age breach
// when `KB_AGE_BUDGET_HOURS_<KB>` (or the unsuffixed global default)
// is configured. The two layers compose: a KB can be content-fresh
// but age-budget-stale, or vice versa.

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  AgeBudgetConfigError,
  computeAgeBudgetStatus,
  formatAgeHours,
  type AgeBudgetStatus,
} from './age-budget.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config.js';
import { mapBounded, resolveFsConcurrency } from './bounded-concurrency.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';

export const REFRESH_PREFLIGHT_FILE_THRESHOLD = 100;
export const REFRESH_PREFLIGHT_BYTE_THRESHOLD = 100 * 1024 * 1024;
export const REFRESH_PREFLIGHT_TOP_K = 5;

export interface AgeBudgetFooterInput {
  /** KB name scoped by the search. The footer is per-KB, so callers
   *  in the unscoped (all-KBs) path should iterate and emit one
   *  line per breached KB. */
  kb: string;
  /** Last-index timestamp for the scoped KB in epoch milliseconds.
   *  Typically derived from sidecar mtimes under `<kb>/.index/`; pass
   *  `null` when the KB has never been indexed. */
  lastIndexAtMs: number | null;
  /** Injectable clock for testing. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Injectable env for testing. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface AgeBudgetFooterResult {
  status: AgeBudgetStatus;
  /** The footer line to append to `kb search` markdown output, or
   *  `null` when there is nothing to surface (no budget configured,
   *  KB never indexed, or within budget). */
  line: string | null;
  /** Set when env-var parsing failed (e.g. `KB_AGE_BUDGET_HOURS_<KB>=0`).
   *  Callers can surface this as a warning footer line. The
   *  underlying `status` falls back to "no budget configured". */
  configError: AgeBudgetConfigError | null;
}

export type RefreshPreflightProviderClass = 'local' | 'paid';

export interface RefreshPreflightActiveModel {
  modelId: string;
  provider: string;
  modelName: string;
}

export interface RefreshPreflightKbEstimate {
  kb: string;
  modifiedFiles: number;
  newFiles: number;
  staleFiles: number;
  estimatedBytes: number;
  stalePdfFiles: number;
}

export interface RefreshPreflightEstimate {
  activeModel: RefreshPreflightActiveModel & {
    providerClass: RefreshPreflightProviderClass;
  };
  scopedKb?: string;
  thresholdFiles: number;
  thresholdBytes: number;
  exceedsThreshold: boolean;
  totalModifiedFiles: number;
  totalNewFiles: number;
  totalStaleFiles: number;
  estimatedBytes: number;
  estimatedChunks: null;
  stalePdfFiles: number;
  kbs: RefreshPreflightKbEstimate[];
  topKbs: RefreshPreflightKbEstimate[];
}

export interface BuildRefreshPreflightEstimateInput {
  activeModel: RefreshPreflightActiveModel;
  indexMtimeMs: number | null;
  scopedKb?: string;
  kbRootDir?: string;
  thresholdFiles?: number;
  thresholdBytes?: number;
  topK?: number;
}

export async function buildRefreshPreflightEstimate(
  input: BuildRefreshPreflightEstimateInput,
): Promise<RefreshPreflightEstimate> {
  const kbRootDir = input.kbRootDir ?? KNOWLEDGE_BASES_ROOT_DIR;
  const thresholdFiles = input.thresholdFiles ?? REFRESH_PREFLIGHT_FILE_THRESHOLD;
  const thresholdBytes = input.thresholdBytes ?? REFRESH_PREFLIGHT_BYTE_THRESHOLD;
  const topK = input.topK ?? REFRESH_PREFLIGHT_TOP_K;
  const kbNames = input.scopedKb
    ? [input.scopedKb]
    : await listKnowledgeBases(kbRootDir);
  const enumerations = await enumerateIngestableKbFiles(kbRootDir, kbNames, {
    extraExtensions: INGEST_EXTRA_EXTENSIONS,
    excludePaths: INGEST_EXCLUDE_PATHS,
  });

  const kbs: RefreshPreflightKbEstimate[] = [];
  for (const { kbName, kbPath, filePaths } of enumerations) {
    const fileEstimates = await mapBounded(
      filePaths,
      resolveFsConcurrency(),
      async (filePath) => classifyRefreshPreflightFile(kbPath, filePath, input.indexMtimeMs),
    );
    const row = fileEstimates.reduce<RefreshPreflightKbEstimate>(
      (acc, file) => ({
        kb: acc.kb,
        modifiedFiles: acc.modifiedFiles + (file.kind === 'modified' ? 1 : 0),
        newFiles: acc.newFiles + (file.kind === 'new' ? 1 : 0),
        staleFiles: acc.staleFiles + (file.kind === 'fresh' ? 0 : 1),
        estimatedBytes: acc.estimatedBytes + file.estimatedBytes,
        stalePdfFiles: acc.stalePdfFiles + (file.isPdf && file.kind !== 'fresh' ? 1 : 0),
      }),
      {
        kb: kbName,
        modifiedFiles: 0,
        newFiles: 0,
        staleFiles: 0,
        estimatedBytes: 0,
        stalePdfFiles: 0,
      },
    );
    if (row.staleFiles > 0) kbs.push(row);
  }

  kbs.sort((a, b) => a.kb.localeCompare(b.kb));
  const topKbs = [...kbs]
    .sort((a, b) =>
      (b.estimatedBytes - a.estimatedBytes) ||
      (b.staleFiles - a.staleFiles) ||
      a.kb.localeCompare(b.kb))
    .slice(0, topK);
  const totals = kbs.reduce(
    (acc, row) => ({
      modifiedFiles: acc.modifiedFiles + row.modifiedFiles,
      newFiles: acc.newFiles + row.newFiles,
      staleFiles: acc.staleFiles + row.staleFiles,
      estimatedBytes: acc.estimatedBytes + row.estimatedBytes,
      stalePdfFiles: acc.stalePdfFiles + row.stalePdfFiles,
    }),
    { modifiedFiles: 0, newFiles: 0, staleFiles: 0, estimatedBytes: 0, stalePdfFiles: 0 },
  );

  return {
    activeModel: {
      ...input.activeModel,
      providerClass: classifyRefreshProvider(input.activeModel.provider),
    },
    ...(input.scopedKb ? { scopedKb: input.scopedKb } : {}),
    thresholdFiles,
    thresholdBytes,
    exceedsThreshold:
      totals.staleFiles > thresholdFiles ||
      totals.estimatedBytes > thresholdBytes,
    totalModifiedFiles: totals.modifiedFiles,
    totalNewFiles: totals.newFiles,
    totalStaleFiles: totals.staleFiles,
    estimatedBytes: totals.estimatedBytes,
    estimatedChunks: null,
    stalePdfFiles: totals.stalePdfFiles,
    kbs,
    topKbs,
  };
}

export function maybeWriteRefreshPreflight(
  estimate: RefreshPreflightEstimate,
  options: {
    format?: 'md' | 'json' | 'vimgrep';
    write?: (text: string) => void;
  } = {},
): boolean {
  if (!estimate.exceedsThreshold) return false;
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  write(formatRefreshPreflightEstimate(estimate));
  return true;
}

export function formatRefreshPreflightEstimate(
  estimate: RefreshPreflightEstimate,
): string {
  const lines = [
    `kb search refresh preflight: ${estimate.totalModifiedFiles} modified, ` +
      `${estimate.totalNewFiles} new file(s), ${formatBytes(estimate.estimatedBytes)} ` +
      `estimated stale bytes; thresholds: ${estimate.thresholdFiles} files or ` +
      `${formatBytes(estimate.thresholdBytes)}.`,
    `Active model: ${estimate.activeModel.modelId} ` +
      `(provider=${estimate.activeModel.provider}, model=${estimate.activeModel.modelName}, ` +
      `provider_class=${estimate.activeModel.providerClass})`,
    `Scope: ${estimate.scopedKb ? `--kb=${estimate.scopedKb}` : 'all KBs'}`,
    'Estimated chunks: unknown until extraction',
    'Changed/new files by KB:',
  ];

  for (const row of estimate.kbs) {
    lines.push(
      `- ${row.kb}: ${row.modifiedFiles} modified, ${row.newFiles} new, ` +
        `${formatBytes(row.estimatedBytes)} estimated stale bytes`,
    );
  }

  lines.push('Top stale KBs:');
  for (const row of estimate.topKbs) {
    lines.push(`- ${row.kb}: ${formatBytes(row.estimatedBytes)} across ${row.staleFiles} file(s)`);
  }

  lines.push('Suggestions:');
  if (estimate.scopedKb) {
    lines.push(`- Already scoped to \`--kb=${estimate.scopedKb}\`; omit --kb only when a full refresh is intentional.`);
  } else if (estimate.topKbs.length > 0) {
    lines.push(`- Start with \`kb search "<query>" --refresh --kb=${estimate.topKbs[0].kb}\` to refresh the largest stale KB first.`);
  }
  if (estimate.stalePdfFiles > 0) {
    lines.push('- Exclude bulky PDFs with `INGEST_EXCLUDE_PATHS=pdfs/**` when they are not needed for this run.');
  }
  lines.push('- This preflight is informational: TTY and non-TTY runs continue without prompting.');
  return `${lines.join('\n')}\n`;
}

function classifyRefreshProvider(provider: string): RefreshPreflightProviderClass {
  return provider === 'ollama' || provider === 'fake' ? 'local' : 'paid';
}

async function classifyRefreshPreflightFile(
  kbPath: string,
  filePath: string,
  indexMtimeMs: number | null,
): Promise<{ kind: 'fresh' | 'modified' | 'new'; estimatedBytes: number; isPdf: boolean }> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { kind: 'fresh', estimatedBytes: 0, isPdf: false };
  }
  const relativePath = path.relative(kbPath, filePath);
  const sidecarPath = path.join(kbPath, '.index', path.dirname(relativePath), path.basename(filePath));
  const hasSidecar = indexMtimeMs !== null && await sidecarExists(sidecarPath);
  const kind = !hasSidecar
    ? 'new'
    : stat.mtimeMs > indexMtimeMs
      ? 'modified'
      : 'fresh';
  return {
    kind,
    estimatedBytes: kind === 'fresh' ? 0 : stat.size,
    isPdf: path.extname(filePath).toLowerCase() === '.pdf',
  };
}

async function sidecarExists(sidecarPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(sidecarPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded.replace(/\.0$/, '')} ${unit}`;
}

// -- Empty-result inline guidance (issue #335) -------------------------------
//
// When `kb search` returns zero results, the legacy CLI markdown body was just
// `_No similar results found._` and any stale-scope hint lived only in the
// trailing freshness footer. Operators reading top-down missed the footer and
// re-ran the query without refreshing. This helper renders an inline tip block
// (and a parallel JSON shape) that lands directly under the empty body when
// the scoped or global index is stale.
//
// Markdown form is a single blockquote line so it composes with the existing
// "Disclaimer" blockquote without nested-fence rendering quirks.
//
// JSON form is additive: callers splice it into the dense search JSON payload
// under `empty_result_guidance` without touching the existing freshness fields.

export interface EmptyResultStalenessSnapshot {
  /** ISO-8601 mtime of the FAISS index, or null when the index has never been built. */
  indexMtime: string | null;
  /** Counts for the active scope — either the selected KB or the global index. */
  scoped: {
    modifiedFiles: number;
    newFiles: number;
  };
  /** Global counts when a KB scope is active; null for unscoped runs (scoped already === global). */
  global: {
    modifiedFiles: number;
    newFiles: number;
  } | null;
}

export interface BuildEmptyResultGuidanceInput {
  /** User-typed search query; embedded into the suggested refresh command. */
  query: string;
  /** KB scope selected via `--kb=<name>`; `undefined` for global searches. */
  scopedKb: string | undefined;
  /** True when this CLI invocation already passed `--refresh`. */
  refreshed: boolean;
  /** Compact staleness snapshot. `null` when freshness was skipped (`--no-freshness`). */
  staleness: EmptyResultStalenessSnapshot | null;
}

export interface EmptyResultGuidanceJson {
  refresh_command: string;
  scope: 'global' | 'scoped';
  scope_kb?: string;
  index_mtime: string | null;
  index_built: boolean;
  refreshed: boolean;
  scoped_stale: boolean;
  scoped_modified_files: number;
  scoped_new_files: number;
  global_stale: boolean;
  global_modified_files: number;
  global_new_files: number;
}

export interface EmptyResultGuidance {
  /** Markdown blockquote tip to inline under `_No similar results found._`, or null when nothing actionable to surface. */
  markdown: string | null;
  /** Additive JSON fragment for the dense search payload, or null when freshness was skipped. */
  json: EmptyResultGuidanceJson | null;
}

/**
 * Compute the inline empty-result guidance block (markdown + JSON) for a
 * `kb search` run that returned zero matches.
 *
 * Returns `markdown: null` when there is nothing actionable to say — i.e.
 * the run was already refreshed, or both scope and global are fresh. In those
 * cases the CLI falls back to the plain "no similar results found" body and
 * the existing freshness footer (which itself becomes "_Index up-to-date_"
 * or "_Index refreshed_"); no behaviour change for fresh runs.
 *
 * Returns `json: null` only when freshness was skipped entirely (`--no-freshness`).
 */
export function buildEmptyResultGuidance(
  input: BuildEmptyResultGuidanceInput,
): EmptyResultGuidance {
  if (input.staleness === null) {
    return { markdown: null, json: null };
  }
  const refreshCommand = buildRefreshCommand(input.query, input.scopedKb);
  const indexBuilt = input.staleness.indexMtime !== null;
  const scopedCounts = input.staleness.scoped;
  const globalCounts = input.staleness.global ?? input.staleness.scoped;
  const scopedStale = scopedCounts.modifiedFiles + scopedCounts.newFiles > 0;
  const globalStale = globalCounts.modifiedFiles + globalCounts.newFiles > 0;
  const scope: 'global' | 'scoped' = input.scopedKb ? 'scoped' : 'global';
  const json: EmptyResultGuidanceJson = {
    refresh_command: refreshCommand,
    scope,
    ...(input.scopedKb ? { scope_kb: input.scopedKb } : {}),
    index_mtime: input.staleness.indexMtime,
    index_built: indexBuilt,
    refreshed: input.refreshed,
    scoped_stale: scopedStale,
    scoped_modified_files: scopedCounts.modifiedFiles,
    scoped_new_files: scopedCounts.newFiles,
    global_stale: globalStale,
    global_modified_files: globalCounts.modifiedFiles,
    global_new_files: globalCounts.newFiles,
  };
  const markdown = renderEmptyGuidanceMarkdown({
    indexBuilt,
    refreshed: input.refreshed,
    scopedKb: input.scopedKb,
    query: input.query,
    scopedCounts,
    globalCounts,
    scopedStale,
    globalStale,
    refreshCommand,
    indexMtime: input.staleness.indexMtime,
  });
  return { markdown, json };
}

function renderEmptyGuidanceMarkdown(input: {
  indexBuilt: boolean;
  refreshed: boolean;
  scopedKb: string | undefined;
  query: string;
  scopedCounts: { modifiedFiles: number; newFiles: number };
  globalCounts: { modifiedFiles: number; newFiles: number };
  scopedStale: boolean;
  globalStale: boolean;
  refreshCommand: string;
  indexMtime: string | null;
}): string | null {
  if (!input.indexBuilt) {
    return (
      `> **Tip:** No results found, and the index has not been built yet. ` +
      `Run \`${input.refreshCommand}\` to create it, then re-run the query.`
    );
  }
  if (input.refreshed) {
    // The user already paid the refresh cost on this invocation; emitting
    // another "run --refresh" tip would just be noise.
    return null;
  }
  if (input.scopedKb) {
    if (input.scopedStale) {
      const stamp = input.indexMtime ?? 'index mtime unknown';
      return (
        `> **Tip:** No results found, and the "${input.scopedKb}" KB scope is stale ` +
        `(${input.scopedCounts.modifiedFiles} modified, ${input.scopedCounts.newFiles} new file(s) since ${stamp}). ` +
        `Try \`${input.refreshCommand}\` to update the index and re-run.`
      );
    }
    if (input.globalStale) {
      const globalRefresh = buildRefreshCommand(input.query, undefined);
      return (
        `> **Tip:** No results found. The "${input.scopedKb}" KB scope is up-to-date, but the global ` +
        `index has drift outside this scope (${input.globalCounts.modifiedFiles} modified, ` +
        `${input.globalCounts.newFiles} new file(s)). If the answer might live in another KB, drop ` +
        `\`--kb=${input.scopedKb}\` and run \`${globalRefresh}\` to refresh and search the full index.`
      );
    }
    return null;
  }
  if (input.scopedStale) {
    const stamp = input.indexMtime ?? 'index mtime unknown';
    return (
      `> **Tip:** No results found, and the index is stale ` +
      `(${input.scopedCounts.modifiedFiles} modified, ${input.scopedCounts.newFiles} new file(s) since ${stamp}). ` +
      `Try \`${input.refreshCommand}\` to update the index and re-run.`
    );
  }
  return null;
}

function buildRefreshCommand(query: string, scopedKb: string | undefined): string {
  const kbFlag = scopedKb ? ` --kb=${scopedKb}` : '';
  if (query === '') {
    return `kb search${kbFlag} --refresh`;
  }
  return `kb search ${shellQuoteQuery(query)}${kbFlag} --refresh`;
}

function shellQuoteQuery(query: string): string {
  // The suggested refresh command lands in markdown blockquotes / JSON
  // payloads, so we need a deterministic, copy-pasteable representation that
  // round-trips through `sh -c`. Double-quote and escape internal `"` / `\` /
  // `$` / backticks — the same set bash would interpret inside double quotes.
  const escaped = query.replace(/(["\\$`])/g, '\\$1');
  return `"${escaped}"`;
}

/**
 * Compute the age-budget footer line for a scoped `kb search` run.
 *
 * Returns `{ status, line, configError }`. When no budget is
 * configured, when the KB has never been indexed, or when the KB is
 * within budget, `line` is `null`. When a budget is configured and
 * the wall-clock age exceeds it, `line` is the rendered footer line.
 * When env-var parsing throws `AgeBudgetConfigError`, the error is
 * returned in `configError` and `line` carries a malformed-config
 * warning so the operator notices.
 */
export function buildAgeBudgetFooter(
  input: AgeBudgetFooterInput,
): AgeBudgetFooterResult {
  const nowMs = input.nowMs ?? Date.now();
  const env = input.env ?? process.env;
  let status: AgeBudgetStatus;
  let configError: AgeBudgetConfigError | null = null;
  try {
    status = computeAgeBudgetStatus(input.kb, input.lastIndexAtMs, nowMs, env);
  } catch (err) {
    if (!(err instanceof AgeBudgetConfigError)) throw err;
    configError = err;
    status = {
      kb: input.kb,
      configuredHours: null,
      currentAgeHours:
        input.lastIndexAtMs === null
          ? null
          : Math.max(0, (nowMs - input.lastIndexAtMs) / 3_600_000),
      breach: false,
    };
  }
  if (configError !== null) {
    return {
      status,
      line:
        `> _Age-budget config error: ${configError.envVar}=` +
        `${JSON.stringify(configError.rawValue)} is not a positive ` +
        `integer; age budget for KB "${input.kb}" is disabled until ` +
        `the value is fixed._`,
      configError,
    };
  }
  if (!status.breach) {
    return { status, line: null, configError: null };
  }
  const ageH = formatAgeHours(status.currentAgeHours);
  return {
    status,
    line:
      `> _Served from index aged ${ageH}h, budget ${status.configuredHours}h. ` +
      `Run \`kb search --refresh\` to update._`,
    configError: null,
  };
}
