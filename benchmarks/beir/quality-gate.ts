// RFC 020 §4 (milestone M3) — the CI retrieval quality gate.
//
// The quality sibling of the latency `budget-diff.ts` gate. On every PR that
// touches retrieval code it re-runs the CI-subset sweep (lexical always; dense
// via the deterministic `fake` provider so the gate is hermetic — no network,
// no credentials) and compares the fresh nDCG@10 against the committed
// `(dataset × mode)` baselines under `benchmarks/results/beir/baseline/`.
//
// The gate FAILS a `(dataset × mode)` cell only when BOTH conditions hold:
//
//   1. nDCG@10 drops below `baseline − tolerance`, where the tolerance is a
//      relative fraction of the baseline with an absolute floor for tiny
//      datasets (RFC §4 / Open-question 2); AND
//   2. the drop is **statistically significant** per `significance.ts` — the
//      paired bootstrap CI on the per-query ΔnDCG@10 excludes zero and the
//      paired t-test rejects at α.
//
// A dip that clears the tolerance, or one that is within noise (not
// significant), is reported as PASS/WARN, never failed — this is the explicit
// anti-flake property the RFC calls for ("a non-significant dip is reported, not
// failed — avoids flaky gates").
//
// Like the latency baselines, BEIR baselines are only ever updated by an
// explicit, reviewed commit (`chore(bench): update BEIR baseline`); this gate
// never rewrites them. It mirrors `budget-diff.ts`'s structure: pure row
// builders + a summarizer + a markdown renderer + a thin CLI, all separately
// testable, with the run orchestration behind an injectable dependency.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  compareScores,
  DEFAULT_ALPHA,
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  type PerQueryScore,
  type Verdict,
} from '../significance.js';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirMode,
} from './run.js';
import { baselineFileName, CI_SUBSET } from './baseline.js';

export type QualityGateStatus = 'pass' | 'warn' | 'fail' | 'skip';

// Default tolerance: a relative fraction of the baseline nDCG@10, with an
// absolute floor so a tiny baseline cannot make the band collapse to ~0 (RFC §4,
// Open-question 2 — "relative %, with an absolute floor on tiny datasets").
export const DEFAULT_RELATIVE_TOLERANCE = 0.02;
export const DEFAULT_ABSOLUTE_TOLERANCE = 0.01;

// The gate is hermetic by default: lexical is credential-free BM25; dense runs
// through the production retrieval path with the deterministic `fake` provider.
export const DEFAULT_GATE_MODES: readonly BeirMode[] = ['lexical', 'dense'];
export const DEFAULT_GATE_PROVIDER = 'fake';

export interface QualityGateThresholds {
  relativeTolerance: number;
  absoluteTolerance: number;
  alpha: number;
  resamples: number;
  seed: number;
}

export const DEFAULT_GATE_THRESHOLDS: QualityGateThresholds = {
  relativeTolerance: DEFAULT_RELATIVE_TOLERANCE,
  absoluteTolerance: DEFAULT_ABSOLUTE_TOLERANCE,
  alpha: DEFAULT_ALPHA,
  resamples: DEFAULT_BOOTSTRAP_RESAMPLES,
  seed: DEFAULT_BOOTSTRAP_SEED,
};

/**
 * The minimal slice of a BEIR run report the gate reads. Both the committed
 * baseline files and the fresh run results satisfy this shape, so the gate is
 * agnostic to the report's other provenance blocks.
 */
export interface GateRunReport {
  dataset: { name: string; queries_evaluated?: number };
  mode: BeirMode;
  embedding: { provider: string; model: string } | null;
  metrics: { ndcgAt10: number };
  per_query: ReadonlyArray<{ queryId: string; ndcgAt10: number }>;
}

export interface QualityGateRow {
  dataset: string;
  mode: BeirMode;
  status: QualityGateStatus;
  baselineNdcg?: number;
  currentNdcg?: number;
  delta?: number;
  tolerance?: number;
  belowTolerance?: boolean;
  significant?: boolean;
  verdict?: Verdict;
  pValue?: number;
  meanDelta?: number;
  ciLow?: number;
  ciHigh?: number;
  pairedQueries?: number;
  note?: string;
}

/** Tolerance band for a baseline: `max(absolute, relative × baseline)`. */
export function toleranceFor(baselineNdcg: number, thresholds: QualityGateThresholds): number {
  return Math.max(thresholds.absoluteTolerance, thresholds.relativeTolerance * baselineNdcg);
}

function perQueryScores(report: GateRunReport): PerQueryScore[] {
  return report.per_query.map((row) => ({ queryId: row.queryId, ndcgAt10: row.ndcgAt10 }));
}

function providerLabel(report: GateRunReport): string {
  return report.embedding === null ? 'lexical' : report.embedding.provider;
}

/**
 * Evaluate a single `(dataset × mode)` gate cell from its committed baseline and
 * the fresh run. Pure and deterministic (the bootstrap is seeded), so a given
 * pair of reports always yields the same row — the property the unit tests and a
 * reproducible CI summary both depend on.
 */
export function evaluateGateComparison(
  baseline: GateRunReport,
  current: GateRunReport,
  thresholds: QualityGateThresholds = DEFAULT_GATE_THRESHOLDS,
): QualityGateRow {
  const dataset = current.dataset.name;
  const mode = current.mode;

  // Compare like-for-like only. A baseline produced by a different embedding
  // provider (e.g. a real `ollama` baseline vs a hermetic `fake` run) is not a
  // meaningful comparison and is skipped, not failed — the gate would otherwise
  // flag a provider swap as a quality regression.
  if (providerLabel(baseline) !== providerLabel(current)) {
    return {
      dataset,
      mode,
      status: 'skip',
      baselineNdcg: baseline.metrics.ndcgAt10,
      currentNdcg: current.metrics.ndcgAt10,
      note: `baseline provider "${providerLabel(baseline)}" != current "${providerLabel(current)}"; gate compares like-for-like only`,
    };
  }

  let comparison;
  try {
    comparison = compareScores(perQueryScores(baseline), perQueryScores(current), {
      label: `${dataset}/${mode}`,
      alpha: thresholds.alpha,
      resamples: thresholds.resamples,
      seed: thresholds.seed,
    });
  } catch (error) {
    return {
      dataset,
      mode,
      status: 'skip',
      baselineNdcg: baseline.metrics.ndcgAt10,
      currentNdcg: current.metrics.ndcgAt10,
      note: `cannot pair per-query nDCG@10 (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const baselineNdcg = baseline.metrics.ndcgAt10;
  const currentNdcg = current.metrics.ndcgAt10;
  const delta = Number((currentNdcg - baselineNdcg).toFixed(6));
  const tolerance = toleranceFor(baselineNdcg, thresholds);
  const belowTolerance = currentNdcg < baselineNdcg - tolerance;
  const significant = comparison.verdict === 'regression';

  // Fail only on a tolerance-clearing AND statistically-significant drop. A dip
  // within tolerance passes; a below-tolerance dip that is not significant warns
  // (reported, never failed) so the gate does not flake on noise.
  const status: QualityGateStatus = !belowTolerance
    ? 'pass'
    : significant
      ? 'fail'
      : 'warn';

  return {
    dataset,
    mode,
    status,
    baselineNdcg,
    currentNdcg,
    delta,
    tolerance: Number(tolerance.toFixed(6)),
    belowTolerance,
    significant,
    verdict: comparison.verdict,
    pValue: comparison.pValue,
    meanDelta: comparison.meanDelta,
    ciLow: comparison.bootstrap.ciLow,
    ciHigh: comparison.bootstrap.ciHigh,
    pairedQueries: comparison.n,
    note: status === 'warn'
      ? 'below tolerance but not statistically significant — reported, not failed'
      : undefined,
  };
}

export function summarizeGateRows(rows: readonly QualityGateRow[]): {
  fail: number;
  pass: number;
  skip: number;
  warn: number;
  worstStatus: QualityGateStatus;
} {
  const counts = {
    fail: rows.filter((row) => row.status === 'fail').length,
    pass: rows.filter((row) => row.status === 'pass').length,
    skip: rows.filter((row) => row.status === 'skip').length,
    warn: rows.filter((row) => row.status === 'warn').length,
  };
  return {
    ...counts,
    worstStatus: counts.fail > 0
      ? 'fail'
      : counts.warn > 0
        ? 'warn'
        : counts.skip === rows.length
          ? 'skip'
          : 'pass',
  };
}

export interface RenderGateOptions {
  rows: readonly QualityGateRow[];
  enforceFailures: boolean;
  thresholds: QualityGateThresholds;
  baselineLabel?: string;
}

export function renderGateMarkdown(options: RenderGateOptions): string {
  const summary = summarizeGateRows(options.rows);
  const { thresholds } = options;
  const lines = [
    '## Retrieval quality gate',
    '',
    options.baselineLabel ? `Baseline: \`${options.baselineLabel}\`` : 'Baseline: committed BEIR CI-subset baselines',
    `Tolerance: −${(thresholds.relativeTolerance * 100).toFixed(1)}% (abs floor ${thresholds.absoluteTolerance.toFixed(3)}); significance at α=${thresholds.alpha}`,
    `Mode: ${options.enforceFailures ? 'enforcing FAIL rows' : 'advisory'}`,
    `Overall: ${summary.worstStatus.toUpperCase()} (${summary.fail} fail, ${summary.warn} warn, ${summary.pass} pass, ${summary.skip} skipped)`,
    '',
    '| Status | Dataset | Mode | Baseline | Current | Δ nDCG@10 | Tolerance | Significance | Verdict |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];

  for (const row of options.rows) {
    lines.push([
      row.status.toUpperCase(),
      row.dataset,
      row.mode,
      formatScore(row.baselineNdcg),
      formatScore(row.currentNdcg),
      formatDelta(row.delta),
      row.tolerance === undefined ? '-' : `−${row.tolerance.toFixed(4)}`,
      formatSignificance(row),
      row.verdict ?? (row.note ?? '-'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push(
    '',
    'A cell FAILS only when nDCG@10 drops below `baseline − tolerance` **and** the',
    'drop is statistically significant; a non-significant dip is reported, not failed',
    '(RFC 020 §4). FAIL rows fail the job only when `BENCH_QUALITY_GATE_FAIL=1`.',
    'Baseline updates are an explicit, reviewed commit — never automatic.',
  );
  return `${lines.join('\n')}\n`;
}

function formatScore(value: number | undefined): string {
  return value === undefined ? '-' : value.toFixed(4);
}

function formatDelta(delta: number | undefined): string {
  if (delta === undefined) return '-';
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`;
}

function formatSignificance(row: QualityGateRow): string {
  if (row.pValue === undefined) return row.note ?? '-';
  const p = row.pValue < 1e-4 && row.pValue > 0 ? '<0.0001' : row.pValue.toFixed(4);
  const ci = row.ciLow !== undefined && row.ciHigh !== undefined
    ? ` CI[${row.ciLow.toFixed(4)}, ${row.ciHigh.toFixed(4)}]`
    : '';
  return `p=${p}${ci}`;
}

// ---------------------------------------------------------------------------
// Run orchestration
// ---------------------------------------------------------------------------

export interface QualityGateOptions {
  datasets: string[];
  modes: BeirMode[];
  provider: string;
  model?: string;
  split: string;
  baselineDir: string;
  cacheDir: string;
  // One shared workspace root for every cell on purpose: `src/config/paths`
  // resolves the KB root into a module-level const on first import, so a stable
  // path keeps every cell (lexical then dense, in one process) pointing at the
  // same re-materialised corpus directory — the same discipline as baseline.ts.
  workspaceRoot: string;
  // The run output dir. Must live OUTSIDE workspaceRoot, which is wiped after
  // each cell (assertSafeWorkspaceRoot enforces this).
  outputDir: string;
  datasetDir?: string;
  maxQueries?: number;
  thresholds: QualityGateThresholds;
}

export interface QualityGateDependencies {
  runBenchmark(beirArgv: string[]): Promise<BeirBenchmarkRunResult>;
  readBaseline(filePath: string): Promise<GateRunReport | null>;
}

const defaultGateDependencies: QualityGateDependencies = {
  runBenchmark: (beirArgv) => runBeirBenchmark(parseBeirArgs(beirArgv)),
  readBaseline: async (filePath) => {
    try {
      return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as GateRunReport;
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  },
};

export interface QualityGateResult {
  rows: QualityGateRow[];
  worstStatus: QualityGateStatus;
}

/**
 * Run the gate over `(dataset × mode)`: run each cell hermetically, load its
 * committed baseline, and evaluate the row. A cell whose run fails (e.g. an
 * undownloadable dataset on a network-restricted runner) or whose baseline is
 * missing is recorded as SKIP — never a build failure — so the gate is robust:
 * it gates on what it can actually measure and stays silent on the rest.
 */
export async function runQualityGate(
  options: QualityGateOptions,
  dependencies: QualityGateDependencies = defaultGateDependencies,
): Promise<QualityGateResult> {
  const rows: QualityGateRow[] = [];
  for (const dataset of options.datasets) {
    for (const mode of options.modes) {
      const baselinePath = path.join(options.baselineDir, baselineFileName(dataset, mode));
      const baseline = await dependencies.readBaseline(baselinePath);
      if (baseline === null) {
        rows.push({
          dataset,
          mode,
          status: 'skip',
          note: `no committed baseline (${baselineFileName(dataset, mode)})`,
        });
        continue;
      }

      let current: GateRunReport;
      try {
        const result = await dependencies.runBenchmark(buildGateBeirArgv(options, dataset, mode));
        current = result.report as unknown as GateRunReport;
      } catch (error) {
        rows.push({
          dataset,
          mode,
          status: 'skip',
          baselineNdcg: baseline.metrics.ndcgAt10,
          note: `run failed (${error instanceof Error ? error.message : String(error)})`,
        });
        continue;
      }

      rows.push(evaluateGateComparison(baseline, current, options.thresholds));
    }
  }
  return { rows, worstStatus: summarizeGateRows(rows).worstStatus };
}

function buildGateBeirArgv(options: QualityGateOptions, dataset: string, mode: BeirMode): string[] {
  const argv = [
    `--dataset=${dataset}`,
    `--split=${options.split}`,
    `--mode=${mode}`,
    `--output-dir=${options.outputDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
  ];
  if (options.datasetDir !== undefined) {
    argv.push(`--dataset-dir=${path.join(options.datasetDir, dataset)}`);
  }
  if (mode !== 'lexical') {
    argv.push(`--provider=${options.provider}`);
    if (options.model !== undefined) argv.push(`--model=${options.model}`);
  }
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions extends QualityGateOptions {
  enforceFailures: boolean;
  summaryPath?: string;
  repoRoot: string;
}

export function parseQualityGateArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const repoRoot = process.cwd();
  const options: CliOptions = {
    datasets: [...CI_SUBSET],
    modes: [...DEFAULT_GATE_MODES],
    provider: env.EMBEDDING_PROVIDER ?? DEFAULT_GATE_PROVIDER,
    split: 'test',
    baselineDir: path.join(repoRoot, 'benchmarks', 'results', 'beir', 'baseline'),
    cacheDir: env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    workspaceRoot: path.join(os.tmpdir(), `kb-beir-gate-${process.pid}`),
    outputDir: path.join(os.tmpdir(), `kb-beir-gate-out-${process.pid}`),
    thresholds: { ...DEFAULT_GATE_THRESHOLDS },
    enforceFailures: parseBool(env.BENCH_QUALITY_GATE_FAIL),
    summaryPath: env.GITHUB_STEP_SUMMARY,
    repoRoot,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === '--datasets') {
      options.datasets = readValue().split(',').map((v) => v.trim()).filter(Boolean);
    } else if (flag === '--modes') {
      options.modes = readValue().split(',').map((v) => parseGateMode(v.trim()));
    } else if (flag === '--provider') {
      options.provider = readValue();
    } else if (flag === '--model') {
      options.model = readValue();
    } else if (flag === '--split') {
      options.split = readValue();
    } else if (flag === '--baseline-dir') {
      options.baselineDir = path.resolve(readValue());
    } else if (flag === '--dataset-dir') {
      options.datasetDir = path.resolve(readValue());
    } else if (flag === '--cache-dir') {
      options.cacheDir = path.resolve(readValue());
    } else if (flag === '--workspace-root') {
      options.workspaceRoot = path.resolve(readValue());
    } else if (flag === '--output-dir') {
      options.outputDir = path.resolve(readValue());
    } else if (flag === '--tolerance') {
      options.thresholds.relativeTolerance = parseUnitInterval(readValue(), '--tolerance');
    } else if (flag === '--abs-tolerance') {
      options.thresholds.absoluteTolerance = parseNonNegative(readValue(), '--abs-tolerance');
    } else if (flag === '--alpha') {
      options.thresholds.alpha = parseUnitInterval(readValue(), '--alpha');
    } else if (flag === '--bootstrap') {
      options.thresholds.resamples = parsePositiveInt(readValue(), '--bootstrap');
    } else if (flag === '--seed') {
      options.thresholds.seed = parsePositiveInt(readValue(), '--seed');
    } else if (flag === '--max-queries') {
      options.maxQueries = parsePositiveInt(readValue(), '--max-queries');
    } else if (flag === '--fail-on-regression') {
      options.enforceFailures = true;
    } else if (flag === '--summary') {
      options.summaryPath = path.resolve(readValue());
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(gateHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

const GATE_MODES: readonly BeirMode[] = ['lexical', 'dense', 'hybrid', 'hybrid+rerank', 'hybrid+rerank+contextual'];

function parseGateMode(raw: string): BeirMode {
  if ((GATE_MODES as readonly string[]).includes(raw)) return raw as BeirMode;
  throw new Error(`--modes entries must be one of: ${GATE_MODES.join(', ')}`);
}

function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseUnitInterval(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error(`${flag} must be in (0, 1)`);
  return parsed;
}

function parseNonNegative(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

function gateHelpText(): string {
  return `kb BEIR CI quality gate (RFC 020 §4, milestone M3)

Usage:
  npm run bench:beir:quality-gate -- --modes=lexical,dense --provider=fake

Runs the CI-subset sweep (lexical always; dense via the deterministic fake
provider) and compares fresh nDCG@10 against the committed (dataset × mode)
baselines. A cell FAILS only when nDCG@10 drops below baseline − tolerance AND
the drop is statistically significant (per significance.ts); a non-significant
dip is reported, not failed. Baseline updates are an explicit, reviewed commit.

Options:
  --datasets=<a,b,c>   CI subset. Default: ${CI_SUBSET.join(',')}.
  --modes=<...>        Comma list of ${GATE_MODES.join('|')}. Default: lexical,dense.
  --provider=<name>    Embedding provider for dense. Default: fake (hermetic).
  --model=<name>       Embedding model for dense. Default: provider default.
  --split=<name>       Qrels split. Default: test.
  --baseline-dir=<p>   Committed baseline dir. Default: benchmarks/results/beir/baseline.
  --dataset-dir=<p>    Parent dir of per-dataset BEIR folders (offline/fixtures).
  --tolerance=<f>      Relative tolerance (0,1). Default: ${DEFAULT_RELATIVE_TOLERANCE}.
  --abs-tolerance=<f>  Absolute floor. Default: ${DEFAULT_ABSOLUTE_TOLERANCE}.
  --alpha=<p>          Significance level. Default: ${DEFAULT_ALPHA}.
  --max-queries=<n>    Deterministic subset for a quick smoke.
  --fail-on-regression Exit 1 when any cell is FAIL (env: BENCH_QUALITY_GATE_FAIL=1).
  --summary=<path>     Append markdown to this file (CI step summary).
`;
}

async function main(): Promise<void> {
  const options = parseQualityGateArgs(process.argv.slice(2), process.env);
  const { rows, worstStatus } = await runQualityGate(options);
  const markdown = renderGateMarkdown({
    rows,
    enforceFailures: options.enforceFailures,
    thresholds: options.thresholds,
    baselineLabel: path.relative(options.repoRoot, options.baselineDir),
  });
  process.stdout.write(markdown);
  if (options.summaryPath !== undefined) {
    await fsp.appendFile(options.summaryPath, markdown, 'utf-8');
  }
  if (options.enforceFailures && worstStatus === 'fail') {
    process.exitCode = 1;
  }
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'quality-gate.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'quality-gate.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
