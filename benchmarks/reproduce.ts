// Issue #944 — one-command entrypoint for the canonical small-model benchmark run.
//
// Reproducing the published dense/nomic BEIR numbers used to mean reassembling
// several `bench:*` invocations with the right flags in the right order. This
// module composes the canonical flow behind a single `npm run bench:reproduce`
// so contributors and evaluators can run it and verify.
//
// Two paths, one canonical config:
//   * SMOKE (default) — dense mode against the committed gate fixture with the
//     deterministic `fake` provider. Offline, credential-free, and fast, so CI
//     stays green and no real embedding provider is ever implied by the default.
//   * FULL (`--full`) — the canonical dense/nomic run recorded by the committed
//     matrix results: `--mode=dense --provider=ollama --model=nomic-embed-text`
//     over the exact published dataset set (scifact, nfcorpus, fiqa, arguana,
//     scidocs — not the full downloadable registry superset). It needs a local
//     Ollama daemon with `nomic-embed-text` pulled and network access to
//     download those datasets, so it is gated behind `--full`. Artifacts default
//     to a temp dir; pass --output-dir to regenerate the committed tree in place.
//
// Both paths drive the exact same production retrieval seam (`runBeirBenchmark`)
// — only the provider, dataset source, and output dir differ — so the smoke run
// exercises the same dense code the full run does, just with hermetic
// embeddings. Fake-provider numbers are self-test smoke only, never a quality
// baseline (see benchmarks/beir/run.ts caveats).

import * as os from 'os';
import * as path from 'path';
import {
  parseArgs as parseBeirArgs,
  runBeirBenchmark,
  type BeirBenchmarkRunResult,
} from './beir/run.js';

// The canonical config, as recorded in the committed matrix runs' `command`
// field (benchmarks/results/beir/matrix/nomic/*-results.json).
const CANONICAL_MODE = 'dense';
const CANONICAL_SPLIT = 'test';
const FULL_PROVIDER = 'ollama';
const FULL_MODEL = 'nomic-embed-text';

// The exact dense datasets committed under benchmarks/results/beir/matrix/nomic —
// the published canonical set this command reproduces. Deliberately NOT the
// registry's downloadableDatasets() (the full ~13-dataset superset that was never
// published, whose extra corpora — nq, hotpotqa, fever, dbpedia-entity, … — are
// multi-GB and would turn a "verify the numbers" run into a many-hour job over
// datasets absent from the published matrix). Order follows the registry's
// canonical report order (tuned set, then the committed unseen-generality slice).
const CANONICAL_DATASETS: readonly string[] = ['scifact', 'nfcorpus', 'fiqa', 'arguana', 'scidocs'];

// The committed published matrix lives under version control at this path. The
// full run does NOT write here by default (it would clobber the committed dense
// artifacts, dirty the working tree, and leave the other-mode files and the
// aggregate beir-matrix.json stale). Operators who want to regenerate the
// published tree in place pass --output-dir=<this> explicitly.
const PUBLISHED_MATRIX_SUBDIR = path.join('benchmarks', 'results', 'beir', 'matrix', 'nomic');

// The smoke leg reuses the committed gate fixture: a tiny, credential-free BEIR
// dataset dir that needs no download, run through the deterministic `fake`
// embedding provider that needs no daemon or network.
const SMOKE_PROVIDER = 'fake';
const SMOKE_DATASET = 'gate-fixture';
const SMOKE_FIXTURE_SUBDIR = path.join('benchmarks', 'beir', 'fixtures', 'gate', 'gate-fixture');

export interface ReproduceOptions {
  /** false = CI-safe smoke (default); true = canonical full dense/nomic run. */
  full: boolean;
  /** Embedding provider passed to the BEIR runner. */
  provider: string;
  /** Embedding model; undefined lets the provider's default apply (fake). */
  model?: string;
  /** Datasets to run, in order. */
  datasets: string[];
  split: string;
  /** Where per-dataset artifacts land. */
  outputDir: string;
  /** BEIR dataset download/extract cache. */
  cacheDir: string;
  /**
   * Stable workspace root shared across every leg. src/config/paths resolves the
   * KB root into a module-level const on first import, so every in-process leg
   * must point at the same workspace path (mirrors benchmarks/bright/run.ts).
   */
  workspaceRoot: string;
  /** Dataset dir for the smoke leg (offline fixture); unset for the full run. */
  smokeFixtureDir?: string;
  /** Deterministic query subset (used by the full run for a quicker pass). */
  maxQueries?: number;
}

export interface ReproduceLegResult {
  dataset: string;
  mode: string;
  jsonPath: string;
  reportPath: string;
  trecPath: string;
  ndcgAt10: number;
}

export interface ReproduceResult {
  mode: 'smoke' | 'full';
  provider: string;
  model?: string;
  outputDir: string;
  legs: ReproduceLegResult[];
}

export interface ReproduceDependencies {
  runBenchmark(beirArgv: string[]): Promise<BeirBenchmarkRunResult>;
}

const defaultDependencies: ReproduceDependencies = {
  runBenchmark: (beirArgv) => runBeirBenchmark(parseBeirArgs(beirArgv)),
};

/**
 * Build the BEIR argv for one dataset leg. The smoke path adds `--dataset-dir`
 * (the offline fixture) and omits `--model` (fake defaults it); the full path
 * downloads the registered dataset and pins the canonical model.
 */
export function buildLegArgv(options: ReproduceOptions, dataset: string): string[] {
  const argv = [
    `--dataset=${dataset}`,
    `--split=${options.split}`,
    `--mode=${CANONICAL_MODE}`,
    `--provider=${options.provider}`,
    `--output-dir=${options.outputDir}`,
    `--cache-dir=${options.cacheDir}`,
    `--workspace-root=${options.workspaceRoot}`,
  ];
  if (options.model !== undefined) argv.push(`--model=${options.model}`);
  if (options.smokeFixtureDir !== undefined) argv.push(`--dataset-dir=${options.smokeFixtureDir}`);
  if (options.maxQueries !== undefined) argv.push(`--max-queries=${options.maxQueries}`);
  return argv;
}

export async function runReproduce(
  options: ReproduceOptions,
  dependencies: ReproduceDependencies = defaultDependencies,
): Promise<ReproduceResult> {
  const legs: ReproduceLegResult[] = [];
  // Sequential by design: legs share one workspace root that the BEIR runner
  // resets on entry, so overlapping runs would corrupt each other's corpus.
  for (const dataset of options.datasets) {
    const result = await dependencies.runBenchmark(buildLegArgv(options, dataset));
    legs.push({
      dataset,
      mode: CANONICAL_MODE,
      jsonPath: result.jsonPath,
      reportPath: result.reportPath,
      trecPath: result.trecPath,
      ndcgAt10: result.report.metrics.ndcgAt10,
    });
  }
  return {
    mode: options.full ? 'full' : 'smoke',
    provider: options.provider,
    model: options.model,
    outputDir: options.outputDir,
    legs,
  };
}

interface ReproduceArgOverrides {
  provider?: string;
  model?: string;
  datasets?: string[];
  split?: string;
  outputDir?: string;
  cacheDir?: string;
  workspaceRoot?: string;
  maxQueries?: number;
}

export function parseReproduceArgs(argv: string[]): ReproduceOptions {
  const repoRoot = process.cwd();
  let full = false;
  const overrides: ReproduceArgOverrides = {};

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
    if (flag === '--full') {
      full = true;
    } else if (flag === '--smoke') {
      full = false;
    } else if (flag === '--provider') {
      overrides.provider = readValue();
    } else if (flag === '--model') {
      overrides.model = readValue();
    } else if (flag === '--datasets' || flag === '--dataset') {
      const parsed = readValue().split(',').map((v) => v.trim()).filter(Boolean);
      if (parsed.length === 0) throw new Error(`${flag} requires at least one dataset name`);
      overrides.datasets = parsed;
    } else if (flag === '--split') {
      overrides.split = readValue();
    } else if (flag === '--output-dir') {
      overrides.outputDir = path.resolve(readValue());
    } else if (flag === '--cache-dir') {
      overrides.cacheDir = path.resolve(readValue());
    } else if (flag === '--workspace-root') {
      overrides.workspaceRoot = path.resolve(readValue());
    } else if (flag === '--max-queries') {
      const parsed = Number(readValue());
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--max-queries must be a positive integer');
      overrides.maxQueries = parsed;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(reproduceHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }

  // Default to a non-tracked temp dir for BOTH paths so a run never dirties the
  // committed results tree; the full run prints where artifacts landed and the
  // operator opts into overwriting the published tree with an explicit
  // --output-dir=benchmarks/results/beir/matrix/nomic.
  const defaultOutputDir = path.join(
    os.tmpdir(),
    `kb-bench-reproduce-${full ? 'full' : 'smoke'}-${process.pid}`,
  );

  return {
    full,
    provider: overrides.provider ?? (full ? FULL_PROVIDER : SMOKE_PROVIDER),
    // A caller-supplied provider without a model still gets the canonical model
    // for the full run; the smoke default leaves it unset so `fake` self-defaults.
    model: overrides.model ?? (full ? FULL_MODEL : undefined),
    datasets: overrides.datasets ?? (full ? [...CANONICAL_DATASETS] : [SMOKE_DATASET]),
    split: overrides.split ?? CANONICAL_SPLIT,
    outputDir: overrides.outputDir ?? defaultOutputDir,
    cacheDir: overrides.cacheDir ?? process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    // `kb-beir-` prefix so a workspace left behind by a crashed prior run is
    // treated as a reusable temp dir (assertSafeWorkspaceRoot) instead of
    // aborting the next run.
    workspaceRoot: overrides.workspaceRoot ?? path.join(os.tmpdir(), `kb-beir-reproduce-${process.pid}`),
    smokeFixtureDir: full ? undefined : path.join(repoRoot, SMOKE_FIXTURE_SUBDIR),
    maxQueries: overrides.maxQueries,
  };
}

function reproduceHelpText(): string {
  return `kb canonical benchmark reproduction

Runs the canonical small-model dense/nomic BEIR flow end to end from one command.

Usage:
  npm run bench:reproduce            # CI-safe smoke (offline, credential-free)
  npm run bench:reproduce -- --full  # canonical dense/nomic run (needs Ollama)

Smoke (default) runs --mode=dense against the committed gate fixture with the
deterministic --provider=fake, so it is offline and requires no credentials.
Fake-provider numbers are self-test smoke only, never a quality baseline.

Full (--full) runs the canonical config recorded by the committed matrix runs
(--mode=dense --provider=ollama --model=nomic-embed-text) over the published
canonical dataset set (${CANONICAL_DATASETS.join(', ')}). It needs a local Ollama
daemon with '${FULL_MODEL}' pulled and network access to fetch the datasets.

Both paths write to a temp dir by default and print where artifacts landed. To
regenerate the committed published dense artifacts in place, pass
--output-dir=${PUBLISHED_MATRIX_SUBDIR} (note: this reproduces only the dense
slice, not the other modes or the aggregate beir-matrix.json).

Options:
  --full               Run the canonical real-provider dense/nomic set.
  --smoke              Force the smoke path (default).
  --provider=<name>    Override the embedding provider.
  --model=<name>       Override the embedding model.
  --datasets=<a,b,c>   Override the dataset list.
  --split=<name>       Qrels split. Default: ${CANONICAL_SPLIT}.
  --output-dir=<p>     Override where artifacts land.
  --cache-dir=<p>      BEIR dataset download/extract cache.
  --workspace-root=<p> Shared per-run workspace root.
  --max-queries=<n>    Deterministic query subset for a quicker pass.
`;
}

function formatSummary(result: ReproduceResult): string {
  const lines: string[] = [];
  const banner = result.mode === 'smoke'
    ? 'bench:reproduce — SMOKE (offline, credential-free; self-test numbers only). Pass --full for the canonical dense/nomic run.'
    : 'bench:reproduce — FULL canonical dense/nomic run.';
  lines.push(banner);
  lines.push(`provider=${result.provider}${result.model !== undefined ? ` model=${result.model}` : ''} mode=${CANONICAL_MODE} split=${CANONICAL_SPLIT}`);
  for (const leg of result.legs) {
    lines.push(`  ${leg.dataset}\t${leg.mode}\tnDCG@10=${leg.ndcgAt10}\t${leg.jsonPath}`);
  }
  lines.push(`Artifacts written under: ${result.outputDir}`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const options = parseReproduceArgs(process.argv.slice(2));
  const result = await runReproduce(options);
  process.stdout.write(formatSummary(result));
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'reproduce.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'reproduce.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
