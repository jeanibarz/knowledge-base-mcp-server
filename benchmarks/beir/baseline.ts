// RFC 020 §4 — committed CI-subset baselines.
//
// Records one BEIR report per (dataset × mode) for the CI subset (SciFact,
// NFCorpus, FiQA) under benchmarks/results/beir/baseline/. Each baseline file
// is the full run report, which already carries the commit (git_sha), the
// runtime env, and the embedding (provider/model) + chunking that produced it —
// so a baseline is self-describing and reproducible. Baseline updates are an
// explicit, reviewed commit, never automatic (same discipline as the latency
// budget baselines).
//
// As with the sweep, dense/hybrid baselines require a real embedding provider
// (the fake provider has no semantic geometry). All runs share one workspace
// root so src/config/paths' module-level KB-root const stays valid across the
// in-process loop.

import * as os from 'os';
import * as path from 'path';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirMode,
} from './run.js';
import { ensureDirectory, writeJsonFile } from '../utils.js';

export const CI_SUBSET = ['scifact', 'nfcorpus', 'fiqa'] as const;
const DEFAULT_MODES: readonly BeirMode[] = ['lexical', 'hybrid'];

/**
 * Stable baseline file name for a (dataset, mode) pair. Kept flat and
 * git-diffable so a baseline update shows up as a focused change.
 */
export function baselineFileName(dataset: string, mode: BeirMode): string {
  return `${dataset}-${mode}.json`;
}

export interface BaselineOptions {
  datasets: string[];
  modes: BeirMode[];
  provider?: string;
  model?: string;
  split: string;
  baselineDir: string;
  cacheDir: string;
  workspaceRoot: string;
  maxQueries?: number;
}

export interface BaselineDependencies {
  runBenchmark(beirArgv: string[]): Promise<BeirBenchmarkRunResult>;
}

const defaultBaselineDependencies: BaselineDependencies = {
  runBenchmark: (beirArgv) => runBeirBenchmark(parseBeirArgs(beirArgv)),
};

export interface BaselineEntry {
  dataset: string;
  mode: BeirMode;
  file: string;
  ndcgAt10: number;
  precisionAt10: number;
}

export async function recordBaselines(
  options: BaselineOptions,
  dependencies: BaselineDependencies = defaultBaselineDependencies,
): Promise<BaselineEntry[]> {
  await ensureDirectory(options.baselineDir);
  const entries: BaselineEntry[] = [];
  for (const dataset of options.datasets) {
    for (const mode of options.modes) {
      const result = await dependencies.runBenchmark(buildBeirArgv(options, dataset, mode));
      const file = baselineFileName(dataset, mode);
      await writeJsonFile(path.join(options.baselineDir, file), result.report);
      entries.push({
        dataset,
        mode,
        file,
        ndcgAt10: result.report.metrics.ndcgAt10,
        precisionAt10: result.report.metrics.precisionAt10,
      });
    }
  }
  return entries;
}

function buildBeirArgv(options: BaselineOptions, dataset: string, mode: BeirMode): string[] {
  const argv = [
    `--dataset=${dataset}`,
    `--split=${options.split}`,
    `--mode=${mode}`,
    `--output-dir=${options.baselineDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
  ];
  if (mode !== 'lexical') {
    if (options.provider !== undefined) argv.push(`--provider=${options.provider}`);
    if (options.model !== undefined) argv.push(`--model=${options.model}`);
  }
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

export function parseBaselineArgs(argv: string[]): BaselineOptions {
  const repoRoot = process.cwd();
  const options: BaselineOptions = {
    datasets: [...CI_SUBSET],
    modes: [...DEFAULT_MODES],
    split: 'test',
    baselineDir: path.join(repoRoot, 'benchmarks', 'results', 'beir', 'baseline'),
    cacheDir: process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    workspaceRoot: path.join(os.tmpdir(), `kb-beir-baseline-${process.pid}`),
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
      options.modes = readValue().split(',').map((v) => parseMode(v.trim()));
    } else if (flag === '--provider') {
      options.provider = readValue();
    } else if (flag === '--model') {
      options.model = readValue();
    } else if (flag === '--split') {
      options.split = readValue();
    } else if (flag === '--baseline-dir') {
      options.baselineDir = path.resolve(readValue());
    } else if (flag === '--cache-dir') {
      options.cacheDir = path.resolve(readValue());
    } else if (flag === '--workspace-root') {
      options.workspaceRoot = path.resolve(readValue());
    } else if (flag === '--max-queries') {
      const parsed = Number(readValue());
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--max-queries must be a positive integer');
      options.maxQueries = parsed;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(baselineHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

const BASELINE_MODES: readonly BeirMode[] = [
  'lexical',
  'dense',
  'hybrid',
  'hybrid+rerank',
  'hybrid+rerank+contextual',
];

function parseMode(raw: string): BeirMode {
  if ((BASELINE_MODES as readonly string[]).includes(raw)) return raw as BeirMode;
  throw new Error(`--modes entries must be one of: ${BASELINE_MODES.join(', ')}`);
}

function baselineHelpText(): string {
  return `kb BEIR CI-subset baseline recorder (RFC 020 M0)

Usage:
  npm run bench:beir:baseline -- --provider=ollama --model=nomic-embed-text \\
      --modes=lexical,hybrid

Options:
  --datasets=<a,b,c>   CI subset. Default: scifact,nfcorpus,fiqa.
  --modes=<...>        Comma list of lexical|dense|hybrid. Default: lexical,hybrid.
  --provider=<name>    Embedding provider for dense/hybrid. Default: $EMBEDDING_PROVIDER.
  --model=<name>       Embedding model. Real model required for dense/hybrid.
  --split=<name>       Qrels split. Default: test.
  --baseline-dir=<p>   Output dir. Default: benchmarks/results/beir/baseline.
  --max-queries=<n>    Deterministic subset for a quick smoke.

Baseline updates must be reviewed commits (chore(bench): update BEIR baseline).
`;
}

async function main(): Promise<void> {
  const options = parseBaselineArgs(process.argv.slice(2));
  const entries = await recordBaselines(options);
  for (const entry of entries) {
    process.stdout.write(
      `${entry.file}\tnDCG@10=${entry.ndcgAt10}\tP@10=${entry.precisionAt10}\n`,
    );
  }
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'baseline.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'baseline.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
