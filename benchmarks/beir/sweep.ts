// RFC 020 M0 (Tier-0, front-loaded) — chunk-size / overlap sweep.
//
// "Chunk size is a first-order retrieval lever yet cheap to test (reindex
// only, no new retrieval code). The current 1000/200 split has never been
// measured against alternatives." This runner sweeps
// `chunk_size ∈ {500,1000,1500,2000} × overlap ∈ {100,200,300}` over the CI
// subset, reporting nDCG@10 AND precision@10 for each cell — precision exposes
// the chunk-boundary ↔ qrel-span mismatch that nDCG/recall alone hide.
//
// The sweep MUST run on a real embedding model: the `fake` provider is a
// deterministic hash-bag with no semantic geometry, so its nDCG curve is
// meaningless for chunking decisions (it only proves the plumbing). Use
// `--provider=ollama` locally.
//
// Each cell sets KB_CHUNK_SIZE / KB_CHUNK_OVERLAP (read at index-build time by
// the production `resolveChunkSize`) and re-runs the BEIR benchmark. All cells
// share ONE workspace root on purpose: `src/config/paths` resolves the KB root
// into a module-level const on first import, so a stable path keeps every cell
// pointing at the same (re-materialized) corpus directory.

import * as os from 'os';
import * as path from 'path';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirMode,
} from './run.js';
import { ensureDirectory, gitSha, writeJsonFile } from '../utils.js';

const CHUNK_SWEEP_SCHEMA_VERSION = 'kb.beir-chunk-sweep.v1';
const DEFAULT_CI_SUBSET = ['scifact', 'nfcorpus', 'fiqa'] as const;
const DEFAULT_CHUNK_SIZES = [500, 1000, 1500, 2000] as const;
const DEFAULT_CHUNK_OVERLAPS = [100, 200, 300] as const;

export interface ChunkSweepCell {
  chunkSize: number;
  chunkOverlap: number;
}

/**
 * Cross-product of chunk sizes × overlaps, dropping cells where the overlap is
 * not strictly smaller than the chunk size (a degenerate splitter config).
 * Stable order: size-major, then overlap.
 */
export function buildChunkSweepGrid(
  sizes: readonly number[],
  overlaps: readonly number[],
): ChunkSweepCell[] {
  const cells: ChunkSweepCell[] = [];
  for (const chunkSize of sizes) {
    for (const chunkOverlap of overlaps) {
      if (chunkOverlap >= chunkSize) continue;
      cells.push({ chunkSize, chunkOverlap });
    }
  }
  return cells;
}

export interface ChunkSweepPoint extends ChunkSweepCell {
  dataset: string;
  ndcgAt10: number;
  precisionAt10: number;
  recallAt10: number;
  queriesEvaluated: number;
}

export interface ChunkSweepReport {
  schema_version: typeof CHUNK_SWEEP_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  mode: BeirMode;
  provider: string | null;
  model: string | null;
  datasets: string[];
  chunk_sizes: number[];
  chunk_overlaps: number[];
  points: ChunkSweepPoint[];
}

export interface ChunkSweepOptions {
  datasets: string[];
  chunkSizes: number[];
  chunkOverlaps: number[];
  mode: BeirMode;
  provider?: string;
  model?: string;
  split: string;
  outputDir: string;
  cacheDir: string;
  workspaceRoot: string;
  maxQueries?: number;
}

export interface ChunkSweepDependencies {
  runBenchmark(beirArgv: string[]): Promise<BeirBenchmarkRunResult>;
  gitSha(repoRoot: string): Promise<string>;
  now(): Date;
  setChunkEnv(cell: ChunkSweepCell): void;
}

const defaultSweepDependencies: ChunkSweepDependencies = {
  runBenchmark: (beirArgv) => runBeirBenchmark(parseBeirArgs(beirArgv)),
  gitSha,
  now: () => new Date(),
  setChunkEnv: (cell) => {
    process.env.KB_CHUNK_SIZE = String(cell.chunkSize);
    process.env.KB_CHUNK_OVERLAP = String(cell.chunkOverlap);
  },
};

/**
 * Run the chunk-size/overlap sweep. Each (dataset × cell) re-materializes the
 * corpus, sets the chunk env, and re-runs the BEIR benchmark, collecting
 * nDCG@10 + precision@10. Env mutations are restored afterwards.
 */
export async function runChunkSweep(
  options: ChunkSweepOptions,
  dependencies: ChunkSweepDependencies = defaultSweepDependencies,
): Promise<{ reportPath: string; report: ChunkSweepReport }> {
  const grid = buildChunkSweepGrid(options.chunkSizes, options.chunkOverlaps);
  if (grid.length === 0) {
    throw new Error('chunk sweep grid is empty; check --chunk-sizes / --chunk-overlaps');
  }
  await ensureDirectory(options.outputDir);

  const savedSize = process.env.KB_CHUNK_SIZE;
  const savedOverlap = process.env.KB_CHUNK_OVERLAP;
  const points: ChunkSweepPoint[] = [];
  try {
    for (const dataset of options.datasets) {
      for (const cell of grid) {
        dependencies.setChunkEnv(cell);
        const beirArgv = buildBeirArgv(options, dataset);
        const result = await dependencies.runBenchmark(beirArgv);
        points.push({
          dataset,
          chunkSize: cell.chunkSize,
          chunkOverlap: cell.chunkOverlap,
          ndcgAt10: result.report.metrics.ndcgAt10,
          precisionAt10: result.report.metrics.precisionAt10,
          recallAt10: result.report.metrics.recallAt10,
          queriesEvaluated: result.report.dataset.queries_evaluated,
        });
      }
    }
  } finally {
    restoreEnv('KB_CHUNK_SIZE', savedSize);
    restoreEnv('KB_CHUNK_OVERLAP', savedOverlap);
  }

  const report: ChunkSweepReport = {
    schema_version: CHUNK_SWEEP_SCHEMA_VERSION,
    generated_at: dependencies.now().toISOString(),
    git_sha: await dependencies.gitSha(process.cwd()),
    mode: options.mode,
    provider: options.provider ?? process.env.EMBEDDING_PROVIDER ?? null,
    model: options.model ?? null,
    datasets: options.datasets,
    chunk_sizes: options.chunkSizes,
    chunk_overlaps: options.chunkOverlaps,
    points,
  };

  const reportPath = path.join(options.outputDir, `chunk-sweep-${options.mode}.json`);
  await writeJsonFile(reportPath, report);
  const markdownPath = path.join(options.outputDir, `chunk-sweep-${options.mode}.md`);
  await writeMarkdown(markdownPath, report);
  return { reportPath, report };
}

function buildBeirArgv(options: ChunkSweepOptions, dataset: string): string[] {
  const argv = [
    `--dataset=${dataset}`,
    `--split=${options.split}`,
    `--mode=${options.mode}`,
    `--output-dir=${options.outputDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
  ];
  if (options.provider !== undefined) argv.push(`--provider=${options.provider}`);
  if (options.model !== undefined) argv.push(`--model=${options.model}`);
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Render the sweep as a per-dataset markdown table (rows = chunk size, columns
 * = overlap) for both nDCG@10 and precision@10 — the sensitivity curve.
 */
export function formatChunkSweepMarkdown(report: ChunkSweepReport): string {
  const lines: string[] = [
    '# BEIR chunk-size / overlap sweep',
    '',
    'Local sweep, not an official leaderboard submission. Run on a real embedding',
    'model — the fake provider has no semantic geometry.',
    '',
    `- Mode: ${report.mode}`,
    `- Provider/model: ${report.provider ?? '(unset)'} / ${report.model ?? '(default)'}`,
    `- Chunk sizes: ${report.chunk_sizes.join(', ')}`,
    `- Overlaps: ${report.chunk_overlaps.join(', ')}`,
    '',
  ];
  for (const dataset of report.datasets) {
    const datasetPoints = report.points.filter((p) => p.dataset === dataset);
    if (datasetPoints.length === 0) continue;
    lines.push(`## ${dataset}`, '');
    lines.push(formatMetricTable('nDCG@10', dataset, report, 'ndcgAt10'));
    lines.push('');
    lines.push(formatMetricTable('precision@10', dataset, report, 'precisionAt10'));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function formatMetricTable(
  title: string,
  dataset: string,
  report: ChunkSweepReport,
  metric: 'ndcgAt10' | 'precisionAt10',
): string {
  const header = ['chunk_size \\ overlap', ...report.chunk_overlaps.map(String)];
  const rows: string[][] = [];
  for (const size of report.chunk_sizes) {
    const row = [String(size)];
    for (const overlap of report.chunk_overlaps) {
      const point = report.points.find(
        (p) => p.dataset === dataset && p.chunkSize === size && p.chunkOverlap === overlap,
      );
      row.push(point === undefined ? '—' : point[metric].toFixed(4));
    }
    rows.push(row);
  }
  const toRow = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    `### ${title}`,
    '',
    toRow(header),
    toRow(header.map(() => '---')),
    ...rows.map(toRow),
  ].join('\n');
}

async function writeMarkdown(markdownPath: string, report: ChunkSweepReport): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await writeFile(markdownPath, formatChunkSweepMarkdown(report), 'utf-8');
}

export function parseSweepArgs(argv: string[]): ChunkSweepOptions {
  const repoRoot = process.cwd();
  const options: ChunkSweepOptions = {
    datasets: [...DEFAULT_CI_SUBSET],
    chunkSizes: [...DEFAULT_CHUNK_SIZES],
    chunkOverlaps: [...DEFAULT_CHUNK_OVERLAPS],
    mode: 'hybrid',
    split: 'test',
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'beir', 'chunk-sweep'),
    cacheDir: process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    // One stable workspace for every cell (see file header).
    workspaceRoot: path.join(os.tmpdir(), `kb-beir-sweep-${process.pid}`),
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
    } else if (flag === '--chunk-sizes') {
      options.chunkSizes = splitList(readValue()).map((v) => parsePositiveInt(v, '--chunk-sizes'));
    } else if (flag === '--chunk-overlaps') {
      options.chunkOverlaps = splitList(readValue()).map((v) => parseNonNegativeInt(v, '--chunk-overlaps'));
    } else if (flag === '--mode') {
      options.mode = parseSweepMode(readValue());
    } else if (flag === '--provider') {
      options.provider = readValue();
    } else if (flag === '--model') {
      options.model = readValue();
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
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(sweepHelpText());
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
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be positive integers`);
  return parsed;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flag} must be non-negative integers`);
  return parsed;
}

const SWEEP_MODES: readonly BeirMode[] = [
  'lexical',
  'dense',
  'hybrid',
  'hybrid+rerank',
  'hybrid+rerank+contextual',
];

function parseSweepMode(raw: string): BeirMode {
  if ((SWEEP_MODES as readonly string[]).includes(raw)) return raw as BeirMode;
  throw new Error(`--mode must be one of: ${SWEEP_MODES.join(', ')}`);
}

function sweepHelpText(): string {
  return `kb BEIR chunk-size sweep (RFC 020 M0, Tier-0)

Usage:
  npm run bench:beir:sweep -- --provider=ollama --model=nomic-embed-text \\
      --datasets=scifact,nfcorpus,fiqa --mode=hybrid

Options:
  --datasets=<a,b,c>       CI subset to sweep. Default: scifact,nfcorpus,fiqa.
  --chunk-sizes=<...>      Comma list. Default: 500,1000,1500,2000.
  --chunk-overlaps=<...>   Comma list. Default: 100,200,300.
  --mode=<mode>            lexical|dense|hybrid. Default: hybrid.
  --provider=<name>        Embedding provider (dense/hybrid). Default: $EMBEDDING_PROVIDER.
  --model=<name>           Embedding model. Real model required — fake has no semantics.
  --split=<name>           Qrels split. Default: test.
  --output-dir=<path>      Sweep report directory.
  --max-queries=<n>        Deterministic subset for a quick smoke.
`;
}

async function main(): Promise<void> {
  const options = parseSweepArgs(process.argv.slice(2));
  const { reportPath } = await runChunkSweep(options);
  process.stdout.write(`${reportPath}\n`);
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'sweep.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'sweep.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
