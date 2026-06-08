// RFC 020 §8 (milestone M3) — the BRIGHT runner.
//
// Drives BRIGHT through the EXACT BEIR runner seam: for each (task × mode) it
// loads the BRIGHT task, converts + materialises it into a BEIR `--dataset-dir`
// (adapter.ts), and runs `runBeirBenchmark` — the same production src/ retrieval
// path BEIR exercises. The only BRIGHT-specific code is the format adapter; the
// retrieval, scoring, and provenance are shared with BEIR by construction (the
// "same runner seam" the RFC requires).
//
// Honesty constraints mirror matrix.ts: a real BRIGHT run needs the BRIGHT task
// data AND a real embedding model. A task that cannot be loaded or whose run
// errors is recorded as a failed point (with the error) and excluded from the
// mean — the report never fabricates a number for a task that did not run.
//
// As with baseline.ts/sweep.ts, every (task × mode) cell shares ONE workspace
// root: src/config/paths resolves the KB root into a module-level const on first
// import, so a stable path keeps every in-process cell pointing at the same
// re-materialised corpus directory.

import * as os from 'os';
import * as path from 'path';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirMode,
} from '../beir/run.js';
import { gitSha, writeJsonFile, ensureDirectory } from '../utils.js';
import {
  loadBrightTaskDir,
  brightToBeirDataset,
  materializeBrightDataset,
  type BrightTaskData,
} from './adapter.js';
import {
  buildBrightReport,
  formatBrightMarkdown,
  type BrightRunPoint,
} from './report.js';
import { brightTaskNames, getBrightTask } from './registry.js';

const DEFAULT_MODES: readonly BeirMode[] = ['dense', 'hybrid+rerank'];

export interface BrightRunOptions {
  tasks: string[];
  modes: BeirMode[];
  brightDir?: string;
  provider?: string;
  model?: string;
  retrievalViews?: string;
  split: string;
  outputDir: string;
  datasetsDir: string;
  workspaceRoot: string;
  cacheDir: string;
  maxQueries?: number;
}

export interface BrightRunDependencies {
  loadTask(brightDir: string, task: string): Promise<BrightTaskData>;
  runBenchmark(beirArgv: string[]): Promise<BeirBenchmarkRunResult>;
  gitSha(repoRoot: string): Promise<string>;
  now(): Date;
}

const defaultRunDependencies: BrightRunDependencies = {
  loadTask: loadBrightTaskDir,
  runBenchmark: (beirArgv) => runBeirBenchmark(parseBeirArgs(beirArgv)),
  gitSha,
  now: () => new Date(),
};

export interface BrightRunResult {
  reportPath: string;
  points: BrightRunPoint[];
}

export async function runBright(
  options: BrightRunOptions,
  dependencies: BrightRunDependencies = defaultRunDependencies,
): Promise<BrightRunResult> {
  await ensureDirectory(options.outputDir);
  await ensureDirectory(options.datasetsDir);
  const points: BrightRunPoint[] = [];

  for (const task of options.tasks) {
    let datasetDir: string | undefined;
    let loadError: string | undefined;
    if (options.brightDir !== undefined) {
      try {
        const data = await dependencies.loadTask(options.brightDir, task);
        const conversion = brightToBeirDataset(data.documents, data.examples);
        datasetDir = await materializeBrightDataset(
          path.join(options.datasetsDir, task),
          conversion,
          options.split,
        );
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error);
      }
    } else {
      loadError = 'no --bright-dir provided (BRIGHT task data not available)';
    }

    for (const mode of options.modes) {
      if (datasetDir === undefined) {
        points.push(failedPoint(task, mode, loadError ?? 'task not materialised'));
        continue;
      }
      try {
        const result = await dependencies.runBenchmark(buildBeirArgv(options, task, datasetDir, mode));
        const metrics = result.report.metrics;
        points.push({
          task,
          mode,
          ndcgAt10: metrics.ndcgAt10,
          precisionAt10: metrics.precisionAt10,
          recallAt10: metrics.recallAt10,
          queriesEvaluated: result.report.dataset.queries_evaluated,
        });
      } catch (error) {
        points.push(failedPoint(task, mode, error instanceof Error ? error.message : String(error)));
      }
    }
  }

  const report = buildBrightReport({
    generatedAt: dependencies.now().toISOString(),
    gitSha: await dependencies.gitSha(process.cwd()),
    provider: options.provider ?? process.env.EMBEDDING_PROVIDER ?? null,
    model: options.model ?? null,
    split: options.split,
    tasks: options.tasks,
    modes: options.modes,
    points,
  });

  const reportPath = path.join(options.outputDir, 'bright-report.json');
  await writeJsonFile(reportPath, report);
  const markdownPath = path.join(options.outputDir, 'bright-report.md');
  const { writeFile } = await import('fs/promises');
  await writeFile(markdownPath, formatBrightMarkdown(report), 'utf-8');
  return { reportPath, points };
}

function failedPoint(task: string, mode: BeirMode, error: string): BrightRunPoint {
  return { task, mode, ndcgAt10: 0, precisionAt10: 0, recallAt10: 0, queriesEvaluated: 0, error };
}

function buildBeirArgv(options: BrightRunOptions, task: string, datasetDir: string, mode: BeirMode): string[] {
  const argv = [
    `--dataset=${task}`,
    `--dataset-dir=${datasetDir}`,
    `--split=${options.split}`,
    `--mode=${mode}`,
    `--output-dir=${options.outputDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
  ];
  if (mode !== 'lexical') {
    if (options.provider !== undefined) argv.push(`--provider=${options.provider}`);
    if (options.model !== undefined) argv.push(`--model=${options.model}`);
    if (options.retrievalViews !== undefined) argv.push(`--retrieval-views=${options.retrievalViews}`);
  }
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

const BRIGHT_MODES: readonly BeirMode[] = ['lexical', 'dense', 'hybrid', 'hybrid+rerank', 'hybrid+rerank+contextual'];

export function parseBrightArgs(argv: string[]): BrightRunOptions {
  const repoRoot = process.cwd();
  const options: BrightRunOptions = {
    tasks: brightTaskNames(),
    modes: [...DEFAULT_MODES],
    split: 'test',
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'bright'),
    datasetsDir: path.join(os.tmpdir(), `kb-bright-datasets-${process.pid}`),
    workspaceRoot: path.join(os.tmpdir(), `kb-bright-${process.pid}`),
    cacheDir: process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
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
    if (flag === '--task' || flag === '--tasks') {
      options.tasks = readValue().split(',').map((v) => v.trim()).filter(Boolean).map(parseTask);
    } else if (flag === '--modes') {
      options.modes = readValue().split(',').map((v) => parseMode(v.trim()));
    } else if (flag === '--bright-dir') {
      options.brightDir = path.resolve(readValue());
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
    } else if (flag === '--datasets-dir') {
      options.datasetsDir = path.resolve(readValue());
    } else if (flag === '--workspace-root') {
      options.workspaceRoot = path.resolve(readValue());
    } else if (flag === '--cache-dir') {
      options.cacheDir = path.resolve(readValue());
    } else if (flag === '--max-queries') {
      const parsed = Number(readValue());
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--max-queries must be a positive integer');
      options.maxQueries = parsed;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(brightHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function parseTask(raw: string): string {
  if (getBrightTask(raw) === undefined) {
    throw new Error(`unknown BRIGHT task "${raw}"; known: ${brightTaskNames().join(', ')}`);
  }
  return raw;
}

function parseMode(raw: string): BeirMode {
  if ((BRIGHT_MODES as readonly string[]).includes(raw)) return raw as BeirMode;
  throw new Error(`--modes entries must be one of: ${BRIGHT_MODES.join(', ')}`);
}

function brightHelpText(): string {
  return `kb BRIGHT reasoning-intensive retrieval runner (RFC 020 §8, M3)

Usage:
  npm run bench:bright -- --bright-dir=<dir> --tasks=biology,economics \\
      --modes=dense,hybrid+rerank --provider=ollama --model=nomic-embed-text

BRIGHT task data is loaded from <bright-dir>/<task>/documents.jsonl and
<bright-dir>/<task>/examples.jsonl (see benchmarks/bright/README.md for the
conversion recipe), converted to a BEIR --dataset-dir, and run through the same
production retrieval path as BEIR.

Options:
  --tasks=<a,b,c>      BRIGHT tasks. Default: all 12.
  --modes=<...>        Comma list of ${BRIGHT_MODES.join('|')}. Default: dense,hybrid+rerank.
  --bright-dir=<p>     Directory of converted BRIGHT tasks. Required for a real run.
  --provider=<name>    Embedding provider for dense/hybrid. Default: $EMBEDDING_PROVIDER.
  --model=<name>       Embedding model. Real model required — fake is plumbing only.
  --retrieval-views=<v> Opt-in multi-view retrieval views for dense/hybrid.
  --split=<name>       Qrels split written by the adapter. Default: test.
  --output-dir=<p>     Report dir. Default: benchmarks/results/bright.
  --max-queries=<n>    Deterministic subset for a quick smoke.
`;
}

async function main(): Promise<void> {
  const options = parseBrightArgs(process.argv.slice(2));
  const { reportPath, points } = await runBright(options);
  process.stdout.write(`${reportPath}\n`);
  for (const point of points) {
    const detail = point.error !== undefined ? `ERROR ${point.error}` : `nDCG@10=${point.ndcgAt10}`;
    process.stdout.write(`${point.task}\t${point.mode}\t${detail}\n`);
  }
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'bright', 'run.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'bright', 'run.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
