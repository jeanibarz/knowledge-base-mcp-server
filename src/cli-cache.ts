import {
  applyExtractionCachePrune,
  planExtractionCachePrune,
  type ExtractionCachePruneApplyResult,
  type ExtractionCachePrunePlan,
} from './extraction-cache.js';

export const CACHE_HELP = `kb cache — inspect and prune local cache surfaces

Usage:
  kb cache extracted-text [--max-age-days=<n>] [--max-size-mb=<n>] [--dry-run|--yes] [--format=md|json]
  kb cache extracted-text [--cache-dir=<path>] [--max-age-days=<n>] [--max-size-mb=<n>] [--dry-run|--yes]

The extracted-text cache stores parsed PDF/HTML text under
\`${'${FAISS_INDEX_PATH}'}/extracted-text\` (or \`EXTRACTION_TEXT_CACHE_DIR\`).
By default this command is a read-only dry-run. Passing \`--yes\` applies the
planned deletion, and deletion is limited to expected 64-hex \`.txt\` cache files.

Options:
  --max-age-days=<n>    Mark entries whose mtime is at least this many days old.
  --max-size-mb=<n>     Mark oldest entries until the retained cache fits this
                        size budget.
  --dry-run             Preview only (default).
  --yes                 Apply the planned deletion. Requires at least one limit.
  --cache-dir=<path>    Override the extracted-text cache directory.
  --format=md|json      Output format (default: md).
  --help, -h            Show this help.

Examples:
  kb cache extracted-text --max-age-days=30
  kb cache extracted-text --max-size-mb=512 --format=json
  kb cache extracted-text --max-age-days=30 --max-size-mb=512 --yes
`;

interface CacheArgs {
  surface: 'extracted-text';
  cacheDir?: string;
  maxAgeDays?: number;
  maxSizeBytes?: number;
  maxSizeMb?: number;
  dryRun: boolean;
  format: 'md' | 'json';
}

export interface RunCacheDeps {
  planExtractionCachePrune: typeof planExtractionCachePrune;
  applyExtractionCachePrune: typeof applyExtractionCachePrune;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPS: RunCacheDeps = {
  planExtractionCachePrune,
  applyExtractionCachePrune,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCache(
  rest: string[],
  deps: RunCacheDeps = DEFAULT_DEPS,
): Promise<number> {
  let parsed: CacheArgs;
  try {
    parsed = parseCacheArgs(rest);
  } catch (err) {
    deps.stderr(`kb cache: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const plan = await deps.planExtractionCachePrune({
      cacheDir: parsed.cacheDir,
      maxAgeDays: parsed.maxAgeDays,
      maxSizeBytes: parsed.maxSizeBytes,
    });
    if (parsed.dryRun) {
      writeCacheResult(plan, parsed.format, deps);
      return plan.inventory.error_count > 0 ? 1 : 0;
    }

    const result = await deps.applyExtractionCachePrune(plan);
    writeCacheResult(result, parsed.format, deps);
    return result.summary.failed_count > 0 ? 1 : 0;
  } catch (err) {
    deps.stderr(`kb cache: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseCacheArgs(rest: string[]): CacheArgs {
  const [surface, ...args] = rest;
  if (surface === undefined) throw new Error('missing surface: extracted-text');
  if (surface !== 'extracted-text') throw new Error(`unknown surface: ${surface}`);

  const out: CacheArgs = {
    surface,
    dryRun: true,
    format: 'md',
  };
  let sawDryRun = false;
  let sawYes = false;
  for (const raw of args) {
    if (raw.startsWith('--max-age-days=')) {
      out.maxAgeDays = parseNonNegativeNumber(raw, '--max-age-days');
      continue;
    }
    if (raw.startsWith('--max-size-mb=')) {
      out.maxSizeMb = parseNonNegativeNumber(raw, '--max-size-mb');
      out.maxSizeBytes = Math.floor(out.maxSizeMb * 1024 * 1024);
      continue;
    }
    if (raw === '--dry-run') {
      sawDryRun = true;
      out.dryRun = true;
      continue;
    }
    if (raw === '--yes') {
      sawYes = true;
      out.dryRun = false;
      continue;
    }
    if (raw.startsWith('--cache-dir=')) {
      const value = raw.slice('--cache-dir='.length);
      if (value === '') throw new Error('empty --cache-dir value');
      out.cacheDir = value;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  if (sawDryRun && sawYes) throw new Error('--dry-run and --yes cannot be combined');
  if (!out.dryRun && out.maxAgeDays === undefined && out.maxSizeBytes === undefined) {
    throw new Error('--yes requires --max-age-days or --max-size-mb');
  }
  return out;
}

function parseNonNegativeNumber(raw: string, flag: string): number {
  const value = raw.slice(`${flag}=`.length);
  if (value === '') throw new Error(`empty ${flag} value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid ${flag}: ${raw}`);
  }
  return parsed;
}

function writeCacheResult(
  result: ExtractionCachePrunePlan | ExtractionCachePruneApplyResult,
  format: 'md' | 'json',
  deps: Pick<RunCacheDeps, 'stdout'>,
): void {
  if (format === 'json') {
    deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  deps.stdout(
    result.dry_run
      ? formatExtractionCachePlanMarkdown(result)
      : formatExtractionCacheApplyMarkdown(result),
  );
}

export function formatExtractionCachePlanMarkdown(plan: ExtractionCachePrunePlan): string {
  const lines = [
    '# Extracted Text Cache',
    '',
    `Mode: dry-run`,
    `Cache dir: \`${plan.cache_dir}\``,
    `Limits: ${formatLimits(plan)}`,
    `Inventory: ${plan.inventory.entry_count} entr${plan.inventory.entry_count === 1 ? 'y' : 'ies'}, ` +
      `${formatBytes(plan.inventory.total_bytes)} total`,
    `Prunable: ${plan.summary.prunable_count} entr${plan.summary.prunable_count === 1 ? 'y' : 'ies'}, ` +
      `${formatBytes(plan.summary.prunable_bytes)}`,
    `Retained: ${plan.summary.kept_count} entr${plan.summary.kept_count === 1 ? 'y' : 'ies'}, ` +
      `${formatBytes(plan.summary.kept_bytes)}`,
  ];
  if (plan.inventory.ignored_entry_count > 0) {
    lines.push(`Ignored non-cache entries: ${plan.inventory.ignored_entry_count}`);
  }
  if (plan.inventory.error_count > 0) {
    lines.push(`Errors: ${plan.inventory.error_count}`);
  }
  if (plan.prunable_entries.length > 0) {
    lines.push('');
    lines.push('| File | Size | Modified | Reasons |');
    lines.push('| --- | ---: | --- | --- |');
    for (const entry of plan.prunable_entries.slice(0, 20)) {
      lines.push(
        `| ${escapeCell(entry.filename)} | ${formatBytes(entry.size_bytes)} | ` +
        `${entry.mtime} | ${entry.reasons.join(', ')} |`,
      );
    }
    if (plan.prunable_entries.length > 20) {
      lines.push(`| ... | ... | ... | ${plan.prunable_entries.length - 20} more |`);
    }
  }
  lines.push('');
  lines.push(plan.summary.prunable_count === 0
    ? 'No entries would be deleted.'
    : 'Pass `--yes` with the same limits to delete these cache files.');
  return `${lines.join('\n')}\n`;
}

export function formatExtractionCacheApplyMarkdown(result: ExtractionCachePruneApplyResult): string {
  const lines = [
    '# Extracted Text Cache',
    '',
    'Mode: applied',
    `Cache dir: \`${result.cache_dir}\``,
    `Deleted: ${result.summary.deleted_count} entr${result.summary.deleted_count === 1 ? 'y' : 'ies'}, ` +
      `${formatBytes(result.summary.deleted_bytes)}`,
    `Failed: ${result.summary.failed_count}`,
  ];
  if (result.failed_entries.length > 0) {
    lines.push('');
    lines.push('| File | Error |');
    lines.push('| --- | --- |');
    for (const entry of result.failed_entries) {
      lines.push(`| ${escapeCell(entry.filename)} | ${escapeCell(entry.message)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatLimits(plan: ExtractionCachePrunePlan): string {
  const limits: string[] = [];
  if (plan.limits.max_age_days !== null) limits.push(`max-age-days=${plan.limits.max_age_days}`);
  if (plan.limits.max_size_bytes !== null) limits.push(`max-size=${formatBytes(plan.limits.max_size_bytes)}`);
  return limits.length === 0 ? 'none (inventory only)' : limits.join(', ');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${bytes} B`;
  return `${value.toFixed(1)} ${units[unit]}`;
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
