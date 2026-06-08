import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
  type BeirMode,
} from './run.js';
import { ensureDirectory, gitSha, writeJsonFile } from '../utils.js';

export const RERANKER_BAKEOFF_REPORT_SCHEMA_VERSION = 'kb.beir.reranker-bakeoff-report.v1';

type VariantStatus = 'ok' | 'error' | 'skipped';

interface BakeoffVariant {
  id: string;
  label: string;
  mode: BeirMode;
  model: string | null;
  env?: Record<string, string>;
  skipReason?: string;
}

interface BakeoffCell {
  dataset: string;
  variant: string;
  label: string;
  mode: BeirMode;
  status: VariantStatus;
  model: string | null;
  ndcgAt10: number | null;
  mapAt100: number | null;
  recallAt10: number | null;
  recallAt100: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  candidatesMeanIn: number | null;
  candidatesMeanReranked: number | null;
  skippedQueries: number | null;
  jsonPath: string | null;
  reportPath: string | null;
  error: string | null;
}

interface BakeoffWinLoss {
  dataset: string;
  variant: string;
  ndcgDelta: number | null;
  mapDelta: number | null;
  recall10Delta: number | null;
  recall100Delta: number | null;
  latencyP95DeltaMs: number | null;
  outcome: 'win' | 'loss' | 'tie' | 'missing';
}

export interface RerankerBakeoffReport {
  schema_version: typeof RERANKER_BAKEOFF_REPORT_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  datasets: string[];
  variants: Array<{ id: string; label: string; mode: BeirMode; model: string | null; status_hint: string | null }>;
  cells: BakeoffCell[];
  win_loss: BakeoffWinLoss[];
  recommendation: {
    default_change: 'none';
    quality: string;
    latency: string;
    resource_feasibility: string;
  };
}

export interface RerankerBakeoffOptions {
  datasets: string[];
  provider?: string;
  model?: string;
  split: string;
  outputDir: string;
  cacheDir: string;
  workspaceRoot: string;
  maxQueries?: number;
}

export interface RerankerBakeoffDependencies {
  runBenchmark(argv: string[], env?: Record<string, string>): Promise<BeirBenchmarkRunResult>;
  gitSha(repoRoot: string): Promise<string>;
  now(): Date;
}

const defaultDependencies: RerankerBakeoffDependencies = {
  runBenchmark: (argv, env) => withTemporaryEnv(env ?? {}, () => runBeirBenchmark(parseBeirArgs(argv))),
  gitSha,
  now: () => new Date(),
};

export async function runRerankerBakeoff(
  options: RerankerBakeoffOptions,
  dependencies: RerankerBakeoffDependencies = defaultDependencies,
): Promise<{ reportPath: string; markdownPath: string; report: RerankerBakeoffReport }> {
  await ensureDirectory(options.outputDir);
  const variants = resolveVariants(process.env);
  const cells: BakeoffCell[] = [];

  for (const dataset of options.datasets) {
    for (const variant of variants) {
      cells.push(await runBakeoffCell(options, dataset, variant, dependencies));
    }
  }

  const report: RerankerBakeoffReport = {
    schema_version: RERANKER_BAKEOFF_REPORT_SCHEMA_VERSION,
    generated_at: dependencies.now().toISOString(),
    git_sha: await dependencies.gitSha(process.cwd()),
    datasets: [...options.datasets],
    variants: variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      mode: variant.mode,
      model: variant.model,
      status_hint: variant.skipReason ?? null,
    })),
    cells,
    win_loss: buildWinLoss(cells),
    recommendation: {
      default_change: 'none',
      quality: 'Use this as a diagnostic bakeoff; promote only a variant that beats hybrid on hard domains without an ArguAna-style regression.',
      latency: 'Separate model quality from latency: cross-encoder/Qwen/Prism variants need real local model timing, while deterministic listwise/head variants report CPU-only overhead.',
      resource_feasibility: 'Qwen3/Prism rows are skipped unless explicitly configured with local model ids; skipped rows are not quality evidence.',
    },
  };

  const reportPath = path.join(options.outputDir, 'reranker-bakeoff.json');
  const markdownPath = path.join(options.outputDir, 'reranker-bakeoff.md');
  await writeJsonFile(reportPath, report);
  await fsp.writeFile(markdownPath, formatRerankerBakeoffMarkdown(report), 'utf-8');
  return { reportPath, markdownPath, report };
}

function resolveVariants(env: NodeJS.ProcessEnv): BakeoffVariant[] {
  const qwen3Model = nonEmpty(env.KB_RERANK_QWEN3_MODEL);
  const prismModel = nonEmpty(env.KB_RERANK_PRISM_MODEL);
  const variants: BakeoffVariant[] = [
    { id: 'hybrid-baseline', label: 'Hybrid baseline (no rerank)', mode: 'hybrid', model: null },
    { id: 'current-cross-encoder', label: 'Current cross-encoder', mode: 'hybrid+rerank', model: env.KB_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2' },
    {
      id: 'qwen3-reranker',
      label: 'Qwen3 reranker override',
      mode: 'hybrid+rerank',
      model: qwen3Model ?? null,
      env: qwen3Model === undefined ? undefined : { KB_RERANK_MODEL: qwen3Model },
      skipReason: qwen3Model === undefined ? 'set KB_RERANK_QWEN3_MODEL to a locally available transformers.js-compatible reranker' : undefined,
    },
    {
      id: 'prism-reranker',
      label: 'Prism-style reranker override',
      mode: 'hybrid+rerank',
      model: prismModel ?? null,
      env: prismModel === undefined ? undefined : { KB_RERANK_MODEL: prismModel },
      skipReason: prismModel === undefined ? 'set KB_RERANK_PRISM_MODEL to a locally available transformers.js-compatible reranker' : undefined,
    },
    { id: 'listwise-attention', label: 'QR-style listwise attention scorer', mode: 'hybrid+listwise-rerank', model: 'qr-style-token-attention-v1' },
    { id: 'hard-negative-head', label: 'Lightweight hard-negative boundary head', mode: 'hybrid+hard-negative-rerank', model: 'hard-negative-boundary-head-sim-v1' },
    { id: 'adaptive-listwise', label: 'Adaptive skip-rerank + listwise scorer', mode: 'hybrid+adaptive-rerank', model: 'adaptive-qr-style-token-attention-v1' },
  ];
  return variants;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

async function runBakeoffCell(
  options: RerankerBakeoffOptions,
  dataset: string,
  variant: BakeoffVariant,
  dependencies: RerankerBakeoffDependencies,
): Promise<BakeoffCell> {
  const base = {
    dataset,
    variant: variant.id,
    label: variant.label,
    mode: variant.mode,
    model: variant.model,
  };
  if (variant.skipReason !== undefined) {
    return emptyCell(base, 'skipped', variant.skipReason);
  }
  try {
    const result = await dependencies.runBenchmark(buildBeirArgv(options, dataset, variant), variant.env);
    const bakeoff = result.report.reranker_bakeoff;
    return {
      ...base,
      status: 'ok',
      ndcgAt10: result.report.metrics.ndcgAt10,
      mapAt100: result.report.metrics.mapAt100,
      recallAt10: result.report.metrics.recallAt10,
      recallAt100: result.report.metrics.recallAt100,
      latencyP50Ms: result.report.latency.p50Ms,
      latencyP95Ms: result.report.latency.p95Ms,
      candidatesMeanIn: bakeoff?.mean_candidates_in ?? null,
      candidatesMeanReranked: bakeoff?.mean_candidates_reranked ?? null,
      skippedQueries: bakeoff?.skipped_queries ?? null,
      jsonPath: relativeOrAbsolute(result.jsonPath),
      reportPath: relativeOrAbsolute(result.reportPath),
      error: null,
    };
  } catch (error) {
    return emptyCell(base, 'error', error instanceof Error ? error.message : String(error));
  }
}

function buildBeirArgv(options: RerankerBakeoffOptions, dataset: string, variant: BakeoffVariant): string[] {
  const outDir = path.join(options.outputDir, dataset, variant.id);
  const argv = [
    `--dataset=${dataset}`,
    `--split=${options.split}`,
    `--mode=${variant.mode}`,
    `--output-dir=${outDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
    '--candidate-pool-k=100',
    '--chunk-k=100',
  ];
  if (variant.mode !== 'lexical' && variant.mode !== 'late') {
    if (options.provider !== undefined) argv.push(`--provider=${options.provider}`);
    if (options.model !== undefined) argv.push(`--model=${options.model}`);
  }
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

function emptyCell(
  base: Pick<BakeoffCell, 'dataset' | 'variant' | 'label' | 'mode' | 'model'>,
  status: 'error' | 'skipped',
  error: string,
): BakeoffCell {
  return {
    ...base,
    status,
    ndcgAt10: null,
    mapAt100: null,
    recallAt10: null,
    recallAt100: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
    candidatesMeanIn: null,
    candidatesMeanReranked: null,
    skippedQueries: null,
    jsonPath: null,
    reportPath: null,
    error,
  };
}

function buildWinLoss(cells: readonly BakeoffCell[]): BakeoffWinLoss[] {
  const out: BakeoffWinLoss[] = [];
  for (const cell of cells) {
    if (cell.variant === 'hybrid-baseline') continue;
    const baseline = cells.find((candidate) =>
      candidate.dataset === cell.dataset &&
      candidate.variant === 'hybrid-baseline' &&
      candidate.status === 'ok'
    );
    if (baseline === undefined || cell.status !== 'ok') {
      out.push({
        dataset: cell.dataset,
        variant: cell.variant,
        ndcgDelta: null,
        mapDelta: null,
        recall10Delta: null,
        recall100Delta: null,
        latencyP95DeltaMs: null,
        outcome: 'missing',
      });
      continue;
    }
    const ndcgDelta = delta(cell.ndcgAt10, baseline.ndcgAt10);
    const mapDelta = delta(cell.mapAt100, baseline.mapAt100);
    const recall10Delta = delta(cell.recallAt10, baseline.recallAt10);
    const recall100Delta = delta(cell.recallAt100, baseline.recallAt100);
    out.push({
      dataset: cell.dataset,
      variant: cell.variant,
      ndcgDelta,
      mapDelta,
      recall10Delta,
      recall100Delta,
      latencyP95DeltaMs: delta(cell.latencyP95Ms, baseline.latencyP95Ms),
      outcome: ndcgDelta === null
        ? 'missing'
        : ndcgDelta > 0.000001
          ? 'win'
          : ndcgDelta < -0.000001
            ? 'loss'
            : 'tie',
    });
  }
  return out;
}

export function formatRerankerBakeoffMarkdown(report: RerankerBakeoffReport): string {
  const lines = [
    '# Reranker upgrade bakeoff',
    '',
    'Local diagnostic bakeoff for issue #579. This report never fabricates missing rows:',
    'failed or unconfigured variants are marked `error` or `skipped` and excluded from win/loss evidence.',
    '',
    `- Generated: ${report.generated_at}`,
    `- Commit: \`${report.git_sha}\``,
    `- Datasets: ${report.datasets.join(', ')}`,
    '- Required baseline: every dataset includes `hybrid-baseline` when the cell can run.',
    '',
    '## Cells',
    '',
    '| Dataset | Variant | Status | nDCG@10 | MAP@100 | R@10 | R@100 | p95 ms | candidates reranked | error |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const cell of report.cells) {
    lines.push(
      `| ${cell.dataset} | ${cell.variant} | ${cell.status} | ${fmt(cell.ndcgAt10)} | ${fmt(cell.mapAt100)} | ` +
        `${fmt(cell.recallAt10)} | ${fmt(cell.recallAt100)} | ${fmt(cell.latencyP95Ms)} | ` +
        `${fmt(cell.candidatesMeanReranked)} | ${cell.error ?? ''} |`,
    );
  }
  lines.push('', '## Win/loss vs hybrid baseline', '');
  lines.push('| Dataset | Variant | Outcome | Δ nDCG@10 | Δ MAP@100 | Δ R@10 | Δ R@100 | Δ p95 ms |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.win_loss) {
    lines.push(
      `| ${row.dataset} | ${row.variant} | ${row.outcome} | ${fmtDelta(row.ndcgDelta)} | ` +
        `${fmtDelta(row.mapDelta)} | ${fmtDelta(row.recall10Delta)} | ${fmtDelta(row.recall100Delta)} | ` +
        `${fmtDelta(row.latencyP95DeltaMs)} |`,
    );
  }
  lines.push('', '## Recommendation', '');
  lines.push(`- Default change: ${report.recommendation.default_change}`);
  lines.push(`- Quality: ${report.recommendation.quality}`);
  lines.push(`- Latency: ${report.recommendation.latency}`);
  lines.push(`- Resource feasibility: ${report.recommendation.resource_feasibility}`);
  return `${lines.join('\n')}\n`;
}

function delta(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Number((left - right).toFixed(6));
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function fmtDelta(value: number | null): string {
  if (value === null) return 'n/a';
  return value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
}

function relativeOrAbsolute(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

async function withTemporaryEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function parseRerankerBakeoffArgs(argv: string[]): RerankerBakeoffOptions {
  const repoRoot = process.cwd();
  const options: RerankerBakeoffOptions = {
    datasets: ['scifact', 'arguana', 'scidocs', 'hotpotqa'],
    split: 'test',
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'beir', 'reranker-bakeoff'),
    cacheDir: process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    workspaceRoot: path.join(os.tmpdir(), `kb-beir-reranker-bakeoff-${process.pid}`),
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
      process.stdout.write(helpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function splitList(raw: string): string[] {
  return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function helpText(): string {
  return `kb BEIR reranker bakeoff (issue #579)

Usage:
  npm run bench:beir:reranker-bakeoff -- --provider=ollama --model=nomic-embed-text:latest

Options:
  --datasets=<a,b,c>   Diagnostic datasets. Default: scifact,arguana,scidocs,hotpotqa.
  --provider=<name>    Embedding provider for hybrid candidate generation.
  --model=<name>       Embedding model for hybrid candidate generation.
  --split=<name>       Qrels split. Default: test.
  --output-dir=<path>  Report directory.
  --max-queries=<n>    Deterministic quick sample.

Optional stronger model rows:
  KB_RERANK_QWEN3_MODEL=<model-id>   Enables qwen3-reranker row.
  KB_RERANK_PRISM_MODEL=<model-id>   Enables prism-reranker row.
`;
}

async function main(): Promise<void> {
  const { reportPath, markdownPath, report } = await runRerankerBakeoff(parseRerankerBakeoffArgs(process.argv.slice(2)));
  process.stdout.write(`${report.cells.filter((cell) => cell.status === 'ok').length}/${report.cells.length} cells ok\n`);
  process.stdout.write(`${reportPath}\n${markdownPath}\n`);
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'reranker-bakeoff.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'reranker-bakeoff.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
