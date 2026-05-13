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
