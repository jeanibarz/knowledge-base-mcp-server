// RFC 020 §2/§7/§8 M2 — the full BEIR matrix sweep.
//
// The headline deliverable: run the production retrieval pipeline over the
// (dataset × mode) matrix and report, per mode, the **multi-domain mean
// nDCG@10** — the metric the field quotes and the one §6 calls anti-overfitting
// by construction (averaging across domains *lowers* the score of anything that
// overfits a single corpus). One row per (dataset × mode); one mean per mode.
//
// This is the matrix-scale sibling of `baseline.ts` (CI subset) and `sweep.ts`
// (chunk grid): same DI seam (`runBenchmark`), same "all cells share one
// workspace root" discipline (src/config/paths resolves the KB root into a
// module-level const on first import). It composes the dataset registry
// (`registry.ts`), the generalization machinery (`generalization.ts` — per-domain
// breakdown + Δ_g), and the reproducibility ledger (every cell carries the env
// that produced it and is wired into MLflow via observability/mlflow.ts).
//
// Honesty constraints baked in:
//   * A real full-matrix run needs every BEIR dataset downloaded AND a real
//     embedding model. When a dataset is missing or a cell errors, the cell is
//     recorded as a failure (with the error) and EXCLUDED from the mean — the
//     report never fabricates a number for a dataset that did not run.
//   * The mean is reported alongside the dataset count it averaged, so a partial
//     sweep is self-labelling ("mean over 3 of 14 datasets").

import * as os from 'os';
import * as path from 'path';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirMode,
} from './run.js';
import {
  downloadableDatasets,
  getRegistryEntry,
  domainOf,
  assertRegistryInvariants,
} from './registry.js';
import {
  computeGeneralizationReport,
  formatDeltaG,
  type GeneralizationCell,
  type GeneralizationReport,
} from './generalization.js';
import { ensureDirectory, gitSha, writeJsonFile } from '../utils.js';
import {
  logBeirRunToMlflow,
  logBeirMatrixToMlflow,
  type BeirLedgerReport,
} from '../observability/mlflow.js';

export const MATRIX_SCHEMA_VERSION = 'kb.beir-matrix.v1';

const DEFAULT_MATRIX_MODES: readonly BeirMode[] = ['lexical', 'hybrid'];

const MATRIX_MODES: readonly BeirMode[] = [
  'lexical',
  'late',
  'dense',
  'hybrid',
  'hybrid+late',
  'hybrid+rerank',
  'hybrid+rerank+contextual',
  'hybrid+listwise-rerank',
  'hybrid+hard-negative-rerank',
  'hybrid+adaptive-rerank',
];

// RFC 020 §7 reproducibility ledger — the full retrieval env recorded with the
// run so a third party can reproduce the headline from commit + env. Read from
// the same env vars the production config resolvers consume; defaults mirror the
// production constants (RRF c=60 per src/hybrid-retrieval.ts HYBRID_RRF_C).
export interface RetrievalEnvSnapshot {
  embedding_provider: string | null;
  embedding_model: string | null;
  rrf_c: string;
  rerank_model: string;
  rerank_top_n: string;
  chunk_size: string;
  chunk_overlap: string;
  contextual: 'on' | 'off';
  retrieval_views: string | null;
}

const PRODUCTION_RRF_C = '60';
const PRODUCTION_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const PRODUCTION_RERANK_TOP_N = '40';
const PRODUCTION_CHUNK_SIZE = '1000';
const PRODUCTION_CHUNK_OVERLAP = '200';

export function captureRetrievalEnv(
  options: { provider?: string; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): RetrievalEnvSnapshot {
  const provider = options.provider ?? emptyToNull(env.EMBEDDING_PROVIDER);
  return {
    embedding_provider: provider,
    embedding_model: options.model ?? null,
    rrf_c: nonEmpty(env.KB_RRF_C) ?? PRODUCTION_RRF_C,
    rerank_model: nonEmpty(env.KB_RERANK_MODEL) ?? PRODUCTION_RERANK_MODEL,
    rerank_top_n: nonEmpty(env.KB_RERANK_TOP_N) ?? PRODUCTION_RERANK_TOP_N,
    chunk_size: nonEmpty(env.KB_CHUNK_SIZE) ?? PRODUCTION_CHUNK_SIZE,
    chunk_overlap: nonEmpty(env.KB_CHUNK_OVERLAP) ?? PRODUCTION_CHUNK_OVERLAP,
    contextual: isOn(env.KB_CONTEXTUAL_RETRIEVAL) ? 'on' : 'off',
    retrieval_views: nonEmpty(env.KB_RETRIEVAL_VIEWS) ?? null,
  };
}

export interface MatrixCellResult {
  dataset: string;
  domain: string;
  mode: BeirMode;
  status: 'ok' | 'error';
  ndcgAt10: number;
  precisionAt10: number;
  mapAt100: number;
  recallAt10: number;
  recallAt100: number;
  queriesEvaluated: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  /** Relative paths to the per-cell artifacts (run report JSON + TREC run). */
  jsonPath: string | null;
  trecPath: string | null;
  /** Set only when status === 'error'. */
  error?: string;
}

export interface MatrixModeSummary {
  mode: BeirMode;
  /** Datasets that produced a usable cell (the mean's denominator). */
  datasetsEvaluated: number;
  datasetsRequested: number;
  /** THE HEADLINE METRIC — mean nDCG@10 across the evaluated datasets. */
  multiDomainMeanNdcgAt10: number | null;
  multiDomainMeanPrecisionAt10: number | null;
  multiDomainMeanRecallAt10: number | null;
}

export interface MatrixReport {
  schema_version: typeof MATRIX_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  modes: BeirMode[];
  datasets: string[];
  env: RetrievalEnvSnapshot;
  cells: MatrixCellResult[];
  perMode: MatrixModeSummary[];
  generalization: GeneralizationReport;
  contamination: Array<{ dataset: string; knownInPretraining: boolean; qrels: string; note: string }>;
}

export interface MatrixOptions {
  datasets: string[];
  modes: BeirMode[];
  provider?: string;
  model?: string;
  retrievalViews?: string;
  split: string;
  outputDir: string;
  cacheDir: string;
  workspaceRoot: string;
  maxQueries?: number;
  /** Continue the sweep when one cell throws (default true). */
  continueOnError: boolean;
}

export interface MatrixDependencies {
  runBenchmark(beirArgv: string[]): Promise<BeirBenchmarkRunResult>;
  gitSha(repoRoot: string): Promise<string>;
  now(): Date;
  /**
   * Wire one finished cell into the MLflow ledger (RFC 020 §7). Defaults to the
   * real MLflow logger, which is a no-op unless BENCH_MLFLOW_* is configured;
   * tests stub it to assert "every run is logged" without spawning Python.
   */
  logRun(report: BeirLedgerReport, jsonPath: string, trecPath: string): Promise<void>;
  /** Wire the matrix headline (per-mode means + Δ_g) into the ledger. */
  logMatrix(report: MatrixReport, jsonPath: string, markdownPath: string): Promise<void>;
}

const defaultMatrixDependencies: MatrixDependencies = {
  runBenchmark: (beirArgv) => runBeirBenchmark(parseBeirArgs(beirArgv)),
  gitSha,
  now: () => new Date(),
  logRun: (report, jsonPath, trecPath) =>
    logBeirRunToMlflow({ report, jsonPath, trecPath, repoRoot: process.cwd() }),
  logMatrix: (report, jsonPath, markdownPath) =>
    logBeirMatrixToMlflow({
      report: {
        git_sha: report.git_sha,
        modes: report.modes,
        datasets: report.datasets,
        env: Object.fromEntries(Object.entries(report.env)),
        perMode: report.perMode,
        generalization: report.generalization,
      },
      jsonPath,
      markdownPath,
      repoRoot: process.cwd(),
    }),
};

export async function runBeirMatrix(
  options: MatrixOptions,
  dependencies: MatrixDependencies = defaultMatrixDependencies,
): Promise<{ reportPath: string; markdownPath: string; report: MatrixReport }> {
  assertRegistryInvariants();
  await ensureDirectory(options.outputDir);

  const cells: MatrixCellResult[] = [];
  // Mode-major: every dataset for one mode, then the next mode. Keeps a mode's
  // cells contiguous in the report and means a half-finished sweep still has a
  // complete mode to report on.
  for (const mode of options.modes) {
    for (const dataset of options.datasets) {
      cells.push(await runCell(options, dataset, mode, dependencies));
    }
  }

  const okCells = cells.filter((c) => c.status === 'ok');
  const perMode = options.modes.map((mode) => summarizeMode(mode, options.datasets.length, okCells));
  const generalizationCells: GeneralizationCell[] = okCells.map((c) => ({
    dataset: c.dataset,
    mode: c.mode,
    ndcgAt10: c.ndcgAt10,
    precisionAt10: c.precisionAt10,
    queriesEvaluated: c.queriesEvaluated,
  }));
  const generalization = computeGeneralizationReport(generalizationCells, options.modes);

  const report: MatrixReport = {
    schema_version: MATRIX_SCHEMA_VERSION,
    generated_at: dependencies.now().toISOString(),
    git_sha: await dependencies.gitSha(process.cwd()),
    modes: [...options.modes],
    datasets: [...options.datasets],
    env: captureRetrievalEnv({ provider: options.provider, model: options.model }),
    cells,
    perMode,
    generalization,
    contamination: options.datasets.map((dataset) => {
      const entry = getRegistryEntry(dataset);
      return {
        dataset,
        knownInPretraining: entry?.contamination.knownInPretraining ?? false,
        qrels: entry?.contamination.qrels ?? 'unknown',
        note: entry?.contamination.note ?? 'not in registry',
      };
    }),
  };

  const reportPath = path.join(options.outputDir, 'beir-matrix.json');
  await writeJsonFile(reportPath, report);
  const markdownPath = path.join(options.outputDir, 'beir-matrix.md');
  const { writeFile } = await import('fs/promises');
  await writeFile(markdownPath, formatMatrixMarkdown(report), 'utf-8');
  await dependencies.logMatrix(report, reportPath, markdownPath);
  return { reportPath, markdownPath, report };
}

async function runCell(
  options: MatrixOptions,
  dataset: string,
  mode: BeirMode,
  dependencies: MatrixDependencies,
): Promise<MatrixCellResult> {
  const base: Omit<MatrixCellResult, 'status' | 'ndcgAt10' | 'precisionAt10' | 'mapAt100' | 'recallAt10' | 'recallAt100' | 'queriesEvaluated' | 'latencyP50Ms' | 'latencyP95Ms' | 'latencyP99Ms' | 'jsonPath' | 'trecPath'> = {
    dataset,
    domain: domainOf(dataset),
    mode,
  };
  try {
    const result = await dependencies.runBenchmark(buildBeirArgv(options, dataset, mode));
    const { metrics, latency } = result.report;
    // RFC 020 §7 — wire EVERY run into the ledger as it finishes.
    await dependencies.logRun(result.report, result.jsonPath, result.trecPath);
    return {
      ...base,
      status: 'ok',
      ndcgAt10: metrics.ndcgAt10,
      precisionAt10: metrics.precisionAt10,
      mapAt100: metrics.mapAt100,
      recallAt10: metrics.recallAt10,
      recallAt100: metrics.recallAt100,
      queriesEvaluated: result.report.dataset.queries_evaluated,
      latencyP50Ms: latency.p50Ms,
      latencyP95Ms: latency.p95Ms,
      latencyP99Ms: latency.p99Ms,
      jsonPath: relativeOrAbsolute(result.jsonPath),
      trecPath: relativeOrAbsolute(result.trecPath),
    };
  } catch (error) {
    if (!options.continueOnError) throw error;
    return {
      ...base,
      status: 'error',
      ndcgAt10: 0,
      precisionAt10: 0,
      mapAt100: 0,
      recallAt10: 0,
      recallAt100: 0,
      queriesEvaluated: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      latencyP99Ms: 0,
      jsonPath: null,
      trecPath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeMode(
  mode: BeirMode,
  datasetsRequested: number,
  okCells: readonly MatrixCellResult[],
): MatrixModeSummary {
  const modeCells = okCells.filter((c) => c.mode === mode);
  return {
    mode,
    datasetsEvaluated: modeCells.length,
    datasetsRequested,
    multiDomainMeanNdcgAt10: meanOrNull(modeCells.map((c) => c.ndcgAt10)),
    multiDomainMeanPrecisionAt10: meanOrNull(modeCells.map((c) => c.precisionAt10)),
    multiDomainMeanRecallAt10: meanOrNull(modeCells.map((c) => c.recallAt10)),
  };
}

function buildBeirArgv(options: MatrixOptions, dataset: string, mode: BeirMode): string[] {
  const argv = [
    `--dataset=${dataset}`,
    `--split=${options.split}`,
    `--mode=${mode}`,
    `--output-dir=${options.outputDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
  ];
  if (mode !== 'lexical' && mode !== 'late') {
    if (options.provider !== undefined) argv.push(`--provider=${options.provider}`);
    if (options.model !== undefined) argv.push(`--model=${options.model}`);
    if (options.retrievalViews !== undefined) argv.push(`--retrieval-views=${options.retrievalViews}`);
  }
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return Number((sum / values.length).toFixed(6));
}

function relativeOrAbsolute(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function emptyToNull(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== '' ? value.trim() : null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function isOn(value: string | undefined): boolean {
  const raw = (value ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function formatMatrixMarkdown(report: MatrixReport): string {
  const lines: string[] = [
    '# BEIR full-matrix sweep',
    '',
    'Local BEIR matrix run, not an official leaderboard submission. The headline',
    'is the per-mode **multi-domain mean nDCG@10** — averaging across domains is',
    'the anti-overfitting metric (RFC 020 §2/§6).',
    '',
    `- Generated: ${report.generated_at}`,
    `- Commit: \`${report.git_sha}\``,
    `- Embedding: ${report.env.embedding_provider ?? '(lexical/none)'} / ${report.env.embedding_model ?? '(default)'}`,
    `- RRF c=${report.env.rrf_c}, rerank=${report.env.rerank_model} topN=${report.env.rerank_top_n}, ` +
      `chunk=${report.env.chunk_size}/${report.env.chunk_overlap}, contextual=${report.env.contextual}`,
    '',
    '## Headline — multi-domain mean nDCG@10',
    '',
    '| Mode | datasets | mean nDCG@10 | mean P@10 | mean R@10 |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const summary of report.perMode) {
    lines.push(
      `| ${summary.mode} | ${summary.datasetsEvaluated}/${summary.datasetsRequested} | ` +
        `${fmt(summary.multiDomainMeanNdcgAt10)} | ${fmt(summary.multiDomainMeanPrecisionAt10)} | ` +
        `${fmt(summary.multiDomainMeanRecallAt10)} |`,
    );
  }
  lines.push('', '## Per-(dataset × mode) nDCG@10', '');
  lines.push(...renderCellTable(report));
  lines.push('', '## Per-domain breakdown & Δ_g (generalization, §6)', '');
  lines.push(...renderGeneralization(report.generalization));
  lines.push('', '## Contamination notes (§6.6)', '');
  lines.push('| Dataset | known-in-pretraining | qrels | note |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of report.contamination) {
    lines.push(`| ${row.dataset} | ${row.knownInPretraining ? 'yes' : 'no'} | ${row.qrels} | ${row.note} |`);
  }
  const failures = report.cells.filter((c) => c.status === 'error');
  if (failures.length > 0) {
    lines.push('', '## Excluded cells (errors — not in any mean)', '');
    for (const cell of failures) {
      lines.push(`- \`${cell.dataset} × ${cell.mode}\`: ${cell.error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderCellTable(report: MatrixReport): string[] {
  const header = ['dataset', ...report.modes.map(String)];
  const rows: string[][] = [];
  for (const dataset of report.datasets) {
    const row = [dataset];
    for (const mode of report.modes) {
      const cell = report.cells.find((c) => c.dataset === dataset && c.mode === mode);
      row.push(cell === undefined ? '—' : cell.status === 'error' ? 'ERR' : cell.ndcgAt10.toFixed(4));
    }
    rows.push(row);
  }
  const toRow = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [toRow(header), toRow(header.map(() => '---')), ...rows.map(toRow)];
}

function renderGeneralization(generalization: GeneralizationReport): string[] {
  const lines: string[] = [
    `Δ_g = (seen − unseen) / seen. Seen (tuned): ${generalization.tunedDatasets.join(', ') || '(none)'}. ` +
      `Unseen (reserved): ${generalization.unseenGeneralityDatasets.join(', ') || '(none)'}.`,
    '',
    '| Mode | seen mean nDCG@10 | unseen mean nDCG@10 | Δ_g |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const modeGen of generalization.modes) {
    const dg = modeGen.deltaG;
    lines.push(
      `| ${modeGen.mode} | ${fmt(dg.seenMeanNdcgAt10)} | ${fmt(dg.unseenMeanNdcgAt10)} | ${formatDeltaG(dg.deltaG)} |`,
    );
  }
  for (const modeGen of generalization.modes) {
    if (modeGen.domains.length === 0) continue;
    lines.push('', `### ${modeGen.mode} — per-domain`, '');
    lines.push('| Domain | datasets | mean nDCG@10 | mean P@10 |');
    lines.push('| --- | --- | ---: | ---: |');
    for (const domainRow of modeGen.domains) {
      lines.push(
        `| ${domainRow.domain} | ${domainRow.datasets.join(', ')} | ` +
          `${domainRow.meanNdcgAt10.toFixed(4)} | ${domainRow.meanPrecisionAt10.toFixed(4)} |`,
      );
    }
  }
  return lines;
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseMatrixArgs(argv: string[]): MatrixOptions {
  const repoRoot = process.cwd();
  const options: MatrixOptions = {
    // Default to the auto-downloadable full set (CQADupStack has no single zip).
    datasets: downloadableDatasets(),
    modes: [...DEFAULT_MATRIX_MODES],
    split: 'test',
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'beir', 'matrix'),
    cacheDir: process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    workspaceRoot: path.join(os.tmpdir(), `kb-beir-matrix-${process.pid}`),
    continueOnError: true,
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
      options.datasets = splitList(readValue());
    } else if (flag === '--modes') {
      options.modes = splitList(readValue()).map(parseMatrixMode);
    } else if (flag === '--provider') {
      options.provider = readValue();
    } else if (flag === '--model') {
      options.model = readValue();
    } else if (flag === '--retrieval-views') {
      options.retrievalViews = readValue();
    } else if (flag === '--split') {
      options.split = readValue();
    } else if (flag === '--output-dir') {
      options.outputDir = path.resolve(readValue());
    } else if (flag === '--cache-dir') {
      options.cacheDir = path.resolve(readValue());
    } else if (flag === '--workspace-root') {
      options.workspaceRoot = path.resolve(readValue());
    } else if (flag === '--max-queries') {
      options.maxQueries = parsePositiveInt(readValue(), '--max-queries');
    } else if (flag === '--fail-fast') {
      options.continueOnError = false;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(matrixHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function splitList(raw: string): string[] {
  return raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseMatrixMode(raw: string): BeirMode {
  if ((MATRIX_MODES as readonly string[]).includes(raw)) return raw as BeirMode;
  throw new Error(`--modes entries must be one of: ${MATRIX_MODES.join(', ')}`);
}

function matrixHelpText(): string {
  return `kb BEIR full-matrix sweep (RFC 020 M2)

Usage:
  npm run bench:beir:matrix -- --provider=ollama --model=nomic-embed-text \\
      --modes=lexical,hybrid,hybrid+rerank

Output: benchmarks/results/beir/matrix/beir-matrix.{json,md}. The headline is the
per-mode multi-domain mean nDCG@10 plus the per-domain breakdown and Δ_g (§6).

Options:
  --datasets=<a,b,c>   Datasets to sweep. Default: all auto-downloadable BEIR sets.
  --modes=<...>        Comma list of ${MATRIX_MODES.join('|')}. Default: lexical,hybrid.
  --provider=<name>    Embedding provider for non-lexical modes. Default: $EMBEDDING_PROVIDER.
  --model=<name>       Embedding model. Real model required for meaningful numbers.
  --retrieval-views=<v> Opt-in multi-view retrieval views for non-lexical modes.
  --split=<name>       Qrels split. Default: test.
  --output-dir=<path>  Matrix report directory.
  --max-queries=<n>    Deterministic subset for a quick smoke.
  --fail-fast          Abort on the first cell error instead of recording + skipping.

A real full-matrix run needs every BEIR dataset cached AND a real embedding
model; missing/failed cells are recorded and excluded from the mean — the report
never fabricates a number for a dataset that did not run.
`;
}

async function main(): Promise<void> {
  const options = parseMatrixArgs(process.argv.slice(2));
  const { reportPath, markdownPath, report } = await runBeirMatrix(options);
  for (const summary of report.perMode) {
    process.stdout.write(
      `${summary.mode}\tmean nDCG@10=${fmt(summary.multiDomainMeanNdcgAt10)}\t` +
        `(${summary.datasetsEvaluated}/${summary.datasetsRequested} datasets)\n`,
    );
  }
  process.stdout.write(`${reportPath}\n${markdownPath}\n`);
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'matrix.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'matrix.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
