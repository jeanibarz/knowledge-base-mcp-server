import * as fsp from 'fs/promises';
import * as path from 'path';
import type { BenchmarkReport, BatchQueryRunResult } from './types.js';

type BudgetDirection = 'higher' | 'lower';
export type BudgetStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface BudgetThreshold {
  failAbsolute?: number;
  failRelative?: number;
  warnAbsolute?: number;
  warnRelative?: number;
}

interface BudgetMetric {
  id: string;
  direction: BudgetDirection;
  label: string;
  read: (report: BenchmarkReport) => number | undefined;
  threshold: BudgetThreshold;
  unit: 'bytes' | 'bytes-per-vector' | 'ms' | 'qps' | 'score';
}

export interface BudgetRow {
  baseline?: number;
  current?: number;
  delta?: number;
  deltaRelative?: number;
  direction: BudgetDirection;
  id: string;
  label: string;
  note?: string;
  status: BudgetStatus;
  thresholdLabel: string;
  unit: BudgetMetric['unit'];
}

interface RenderOptions {
  baselineLabel: string;
  currentLabel: string;
  enforceFailures: boolean;
  rows: BudgetRow[];
}

interface CliOptions {
  baselinePath?: string;
  currentPath?: string;
  enforceFailures: boolean;
  repoRoot: string;
  summaryPath?: string;
}

const BYTE = 1;
const MIB = 1024 * 1024;

const BASE_METRICS: BudgetMetric[] = [
  {
    id: 'cold-index-ms',
    direction: 'lower',
    label: 'Cold index',
    read: (report) => report.scenarios.cold_index.ms,
    threshold: { warnAbsolute: 1_000, warnRelative: 0.1, failAbsolute: 2_000, failRelative: 0.2 },
    unit: 'ms',
  },
  {
    id: 'warm-query-p50-ms',
    direction: 'lower',
    label: 'Warm query p50',
    read: (report) => report.scenarios.warm_query.p50_ms,
    threshold: { warnAbsolute: 10, warnRelative: 0.1, failAbsolute: 25, failRelative: 0.25 },
    unit: 'ms',
  },
  {
    id: 'warm-query-p95-ms',
    direction: 'lower',
    label: 'Warm query p95',
    read: (report) => report.scenarios.warm_query.p95_ms,
    threshold: { warnAbsolute: 10, warnRelative: 0.1, failAbsolute: 25, failRelative: 0.25 },
    unit: 'ms',
  },
  {
    id: 'warm-query-p99-ms',
    direction: 'lower',
    label: 'Warm query p99',
    read: (report) => report.scenarios.warm_query.p99_ms,
    threshold: { warnAbsolute: 15, warnRelative: 0.1, failAbsolute: 30, failRelative: 0.25 },
    unit: 'ms',
  },
  {
    id: 'memory-peak-rss-bytes',
    direction: 'lower',
    label: 'Peak RSS',
    read: (report) => report.scenarios.memory_peak.rss_bytes,
    threshold: { warnAbsolute: 16 * MIB, warnRelative: 0.1, failAbsolute: 32 * MIB, failRelative: 0.25 },
    unit: 'bytes',
  },
  {
    id: 'retrieval-recall-at-10',
    direction: 'higher',
    label: 'Retrieval recall@10',
    read: (report) => report.scenarios.retrieval_quality.default_recall_at_10,
    threshold: { warnAbsolute: 0.01, failAbsolute: 0.03 },
    unit: 'score',
  },
];

export function buildBudgetRows(baseline: BenchmarkReport, current: BenchmarkReport): BudgetRow[] {
  const metrics = [...BASE_METRICS];

  metrics.push({
    id: 'index-storage-total-bytes',
    direction: 'lower',
    label: 'Index storage total',
    read: (report) => report.scenarios.index_storage?.total_bytes,
    threshold: { warnAbsolute: 1 * MIB, warnRelative: 0.05, failAbsolute: 5 * MIB, failRelative: 0.15 },
    unit: 'bytes',
  });
  metrics.push({
    id: 'index-storage-bytes-per-vector',
    direction: 'lower',
    label: 'Index bytes/vector',
    read: (report) => report.scenarios.index_storage?.bytes_per_vector,
    threshold: { warnAbsolute: 16 * BYTE, warnRelative: 0.05, failAbsolute: 48 * BYTE, failRelative: 0.15 },
    unit: 'bytes-per-vector',
  });

  const batchConcurrency = highestCommonBatchConcurrency(baseline, current);
  metrics.push({
    id: 'batch-query-qps-p50',
    direction: 'higher',
    label: batchConcurrency === undefined ? 'Batch throughput p50' : `Batch throughput p50 (c=${batchConcurrency})`,
    read: (report) => {
      if (batchConcurrency === undefined) return undefined;
      return report.scenarios.batch_query?.runs.find((run) => run.concurrency === batchConcurrency)?.qps_p50;
    },
    threshold: { warnRelative: 0.1, failRelative: 0.2 },
    unit: 'qps',
  });

  return metrics.map((metric) => buildBudgetRow(metric, baseline, current));
}

export function summarizeBudgetRows(rows: BudgetRow[]): {
  fail: number;
  pass: number;
  skip: number;
  warn: number;
  worstStatus: BudgetStatus;
} {
  const counts = {
    fail: rows.filter((row) => row.status === 'fail').length,
    pass: rows.filter((row) => row.status === 'pass').length,
    skip: rows.filter((row) => row.status === 'skip').length,
    warn: rows.filter((row) => row.status === 'warn').length,
  };

  return {
    ...counts,
    worstStatus: counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.skip === rows.length ? 'skip' : 'pass',
  };
}

export function renderBudgetMarkdown(options: RenderOptions): string {
  const summary = summarizeBudgetRows(options.rows);
  const lines = [
    '## Benchmark regression summary',
    '',
    `Current: \`${options.currentLabel}\``,
    `Baseline: \`${options.baselineLabel}\``,
    `Mode: ${options.enforceFailures ? 'enforcing FAIL rows' : 'advisory'}`,
    `Overall: ${summary.worstStatus.toUpperCase()} (${summary.fail} fail, ${summary.warn} warn, ${summary.pass} pass, ${summary.skip} skipped)`,
    '',
    '| Status | Budget | Baseline | Current | Delta | Threshold |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];

  for (const row of options.rows) {
    lines.push([
      row.status.toUpperCase(),
      row.label,
      formatMaybeValue(row.baseline, row.unit),
      formatMaybeValue(row.current, row.unit),
      formatDelta(row),
      row.status === 'skip' && row.note ? row.note : row.thresholdLabel,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', 'FAIL rows only fail the job when `BENCH_BUDGET_FAIL=1` or the workflow input enables budget enforcement.');
  return `${lines.join('\n')}\n`;
}

export function defaultBaselinePath(repoRoot: string, report: BenchmarkReport): string {
  const nodeLabel = nodeMajorLabel(report.node_version);
  return path.join(
    repoRoot,
    'benchmarks',
    'results',
    `baseline-${report.provider}-${nodeLabel}-${report.os}-${report.arch}.json`,
  );
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (!options.currentPath) {
    throw new Error('Missing --current <path> argument.');
  }

  const current = await readBenchmarkReport(options.currentPath);
  const baselinePath = options.baselinePath ?? defaultBaselinePath(options.repoRoot, current);
  let markdown: string;
  let hasFailRows = false;

  try {
    const baseline = await readBenchmarkReport(baselinePath);
    const rows = buildBudgetRows(baseline, current);
    hasFailRows = summarizeBudgetRows(rows).fail > 0;
    markdown = renderBudgetMarkdown({
      baselineLabel: path.relative(options.repoRoot, baselinePath),
      currentLabel: path.relative(options.repoRoot, options.currentPath),
      enforceFailures: options.enforceFailures,
      rows,
    });
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    markdown = [
      '## Benchmark regression summary',
      '',
      `Current: \`${path.relative(options.repoRoot, options.currentPath)}\``,
      `Baseline: \`${path.relative(options.repoRoot, baselinePath)}\``,
      'Overall: SKIP (matching baseline not found)',
      '',
      'Add or refresh the committed baseline for this provider/node/os/arch before interpreting regression budgets.',
      '',
    ].join('\n');
  }

  process.stdout.write(markdown);
  if (options.summaryPath) {
    await fsp.appendFile(options.summaryPath, markdown, 'utf-8');
  }

  if (options.enforceFailures && hasFailRows) {
    process.exitCode = 1;
  }
}

function buildBudgetRow(metric: BudgetMetric, baselineReport: BenchmarkReport, currentReport: BenchmarkReport): BudgetRow {
  const baseline = metric.read(baselineReport);
  const current = metric.read(currentReport);
  const thresholdLabel = formatThreshold(metric.threshold, metric.unit, metric.direction);

  if (baseline === undefined || current === undefined) {
    return {
      baseline,
      current,
      direction: metric.direction,
      id: metric.id,
      label: metric.label,
      note: skipNote(metric.id),
      status: 'skip',
      thresholdLabel,
      unit: metric.unit,
    };
  }

  const delta = Number((current - baseline).toFixed(6));
  const deltaRelative = baseline === 0 ? undefined : delta / baseline;
  const regression = metric.direction === 'lower' ? current - baseline : baseline - current;
  const regressionRelative = baseline === 0 ? undefined : regression / baseline;
  const status = regression <= 0
    ? 'pass'
    : thresholdReached(metric.threshold, regression, regressionRelative, 'fail')
      ? 'fail'
      : thresholdReached(metric.threshold, regression, regressionRelative, 'warn')
        ? 'warn'
        : 'pass';

  return {
    baseline,
    current,
    delta,
    deltaRelative,
    direction: metric.direction,
    id: metric.id,
    label: metric.label,
    status,
    thresholdLabel,
    unit: metric.unit,
  };
}

function thresholdReached(
  threshold: BudgetThreshold,
  absoluteRegression: number,
  relativeRegression: number | undefined,
  severity: 'fail' | 'warn',
): boolean {
  const absolute = severity === 'fail' ? threshold.failAbsolute : threshold.warnAbsolute;
  const relative = severity === 'fail' ? threshold.failRelative : threshold.warnRelative;

  if (absolute !== undefined && relative !== undefined) {
    return absoluteRegression >= absolute && relativeRegression !== undefined && relativeRegression >= relative;
  }
  if (absolute !== undefined) {
    return absoluteRegression >= absolute;
  }
  if (relative !== undefined) {
    return relativeRegression !== undefined && relativeRegression >= relative;
  }
  return false;
}

function highestCommonBatchConcurrency(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
): number | undefined {
  const baselineRuns = baseline.scenarios.batch_query?.runs ?? [];
  const currentRuns = current.scenarios.batch_query?.runs ?? [];
  const currentConcurrencies = new Set(currentRuns.map((run) => run.concurrency));
  const common = baselineRuns
    .filter((run): run is BatchQueryRunResult => currentConcurrencies.has(run.concurrency))
    .map((run) => run.concurrency)
    .sort((left, right) => right - left);
  return common[0];
}

function formatMaybeValue(value: number | undefined, unit: BudgetMetric['unit']): string {
  if (value === undefined) return '-';
  return formatValue(value, unit);
}

function formatValue(value: number, unit: BudgetMetric['unit']): string {
  switch (unit) {
    case 'bytes':
      return `${(value / MIB).toFixed(1)} MiB`;
    case 'bytes-per-vector':
      return `${value.toFixed(1)} B/vector`;
    case 'ms':
      return `${value.toFixed(1)} ms`;
    case 'qps':
      return `${value.toFixed(2)} qps`;
    case 'score':
      return value.toFixed(3);
  }
}

function formatDelta(row: BudgetRow): string {
  if (row.delta === undefined) return '-';
  const sign = row.delta > 0 ? '+' : '';
  const relative = row.deltaRelative === undefined
    ? ''
    : ` (${row.deltaRelative > 0 ? '+' : ''}${(row.deltaRelative * 100).toFixed(1)}%)`;
  return `${sign}${formatValue(row.delta, row.unit)}${relative}`;
}

function formatThreshold(
  threshold: BudgetThreshold,
  unit: BudgetMetric['unit'],
  direction: BudgetDirection,
): string {
  return [
    formatSeverityThreshold('warn', threshold.warnRelative, threshold.warnAbsolute, unit, direction),
    formatSeverityThreshold('fail', threshold.failRelative, threshold.failAbsolute, unit, direction),
  ].filter(Boolean).join('; ');
}

function formatSeverityThreshold(
  severity: 'fail' | 'warn',
  relative: number | undefined,
  absolute: number | undefined,
  unit: BudgetMetric['unit'],
  direction: BudgetDirection,
): string | undefined {
  if (relative === undefined && absolute === undefined) return undefined;
  const parts = [];
  if (relative !== undefined) {
    parts.push(direction === 'lower' ? `+${(relative * 100).toFixed(1)}%` : `${(relative * 100).toFixed(1)}% lower`);
  }
  if (absolute !== undefined) {
    parts.push(formatThresholdValue(absolute, unit, direction));
  }
  return `${severity} >= ${parts.join(' and ')}`;
}

function formatThresholdValue(value: number, unit: BudgetMetric['unit'], direction: BudgetDirection): string {
  const formatted = formatValue(value, unit).replace('-', '');
  if (direction === 'higher') {
    return `${formatted} lower`;
  }
  return unit === 'score' ? formatted : `+${formatted}`;
}

function skipNote(id: string): string {
  if (id === 'batch-query-qps-p50') {
    return 'No common batch-query concurrency in baseline and current report.';
  }
  return 'Metric is missing from the baseline or current report.';
}

function nodeMajorLabel(nodeVersion: string): string {
  const match = /^v?(\d+)/.exec(nodeVersion);
  return `node${match?.[1] ?? 'unknown'}`;
}

async function readBenchmarkReport(filePath: string): Promise<BenchmarkReport> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<BenchmarkReport>;
  if (parsed.version !== 1 || !parsed.provider || !parsed.node_version || !parsed.os || !parsed.arch || !parsed.scenarios) {
    throw new Error(`Invalid benchmark report: ${filePath}`);
  }
  return parsed as BenchmarkReport;
}

function parseArgs(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const options: CliOptions = {
    currentPath: env.BENCH_CURRENT_PATH,
    enforceFailures: parseBool(env.BENCH_BUDGET_FAIL),
    repoRoot: process.cwd(),
    summaryPath: env.GITHUB_STEP_SUMMARY,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--baseline') {
      options.baselinePath = requireValue(args, ++index, arg);
    } else if (arg === '--current') {
      options.currentPath = requireValue(args, ++index, arg);
    } else if (arg === '--fail-on-regression') {
      options.enforceFailures = true;
    } else if (arg === '--repo-root') {
      options.repoRoot = requireValue(args, ++index, arg);
    } else if (arg === '--summary') {
      options.summaryPath = requireValue(args, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.currentPath) {
    options.currentPath = path.resolve(options.repoRoot, options.currentPath);
  }
  if (options.baselinePath) {
    options.baselinePath = path.resolve(options.repoRoot, options.baselinePath);
  }
  if (options.summaryPath) {
    options.summaryPath = path.resolve(options.repoRoot, options.summaryPath);
  }
  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

function isDirectRun(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  return path.basename(argvPath) === 'budget-diff.js';
}

if (isDirectRun(process.argv[1])) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
