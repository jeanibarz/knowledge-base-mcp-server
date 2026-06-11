// RFC 020 §5 (milestone M4) — the end-to-end RAG eval runner.
//
// Orchestrates the four-tier cascade over gold-bearing QA and emits a
// reproducible scorecard (JSON + markdown) plus an optional MLflow ledger entry
// (§7). Three honesty-preserving modes:
//
//   --fake            Fully hermetic self-test: deterministic stub Tier-2 models
//                     + 3 stub judge families + stub bias probes. Produces a
//                     COMPLETE scorecard with no network — this is the run the
//                     unit tests exercise and the only one guaranteed here.
//   --answers=<jsonl> Real system answers (one {id,answer,contexts} per line)
//                     produced offline by `kb ask`; scored by whichever tiers
//                     are wired. Unwired tiers leave items PENDING, never faked.
//   --judges=<json>   Wire ≥3 live LLM judge families (run over the compiled
//                     provider abstraction). Requires credentials/endpoints.
//
// A real, fully-populated run needs the datasets, an NLI checkpoint + a
// BERTScore/COMET model (Tier 2), and ≥3 live judge families (Tier 3) — much of
// which is environment-dependent. The runner records exactly which tiers ran in
// the scorecard so a partial run is self-describing, not silently incomplete.

import * as path from 'path';
import { pathToFileURL } from 'url';
import { ensureDirectory, gitSha, writeJsonFile } from '../utils.js';
import { logRagEvalToMlflow } from '../observability/mlflow.js';
import { runCascade, type CascadeConfig, type Tier2Config, type Tier3Config } from './cascade.js';
import { loadGoldQaDataset } from './dataset.js';
import { getRagDataset, ragDatasetNames } from './registry.js';
import {
  buildScorecard,
  formatScorecardMarkdown,
  type PanelComposition,
  type RagScorecard,
  type ScorecardConfigProvenance,
} from './scorecard.js';
import { distinctFamilies, type Judge } from './panel.js';
import { tokenOverlapEntailmentModel, tokenOverlapSimilarityModel } from './model-metrics.js';
import { createLlmJudge, createStubJudge, type ChatCompletionLike } from './judges.js';
import type { GoldQaItem, RagAnswer } from './types.js';
import type { ProbeItem } from './bias-probes.js';

export interface JudgeConfigEntry {
  name: string;
  family: string;
  endpoint: string;
  model?: string;
}

export interface RagEvalOptions {
  datasets: string[];
  dataDir: string;
  answersPath?: string;
  judgesConfigPath?: string;
  provider: string | null;
  model: string | null;
  answererModel: string | null;
  samples: number;
  maxItems?: number;
  fake: boolean;
  outputDir: string;
  buildRoot: string;
  // Tier 1 routing thresholds (token-F1). Items at/above tier1HighF1 are
  // decided correct deterministically; at/below tier1LowF1 decided incorrect;
  // in between escalate. For verbose system answers vs terse gold (e.g.
  // HotpotQA), token-F1 is uninformative, so a low tier1LowF1 sends the residue
  // to the judge panel instead of auto-failing it. Default: cascade defaults.
  tier1LowF1?: number;
  tier1HighF1?: number;
}

export interface RagEvalDependencies {
  loadDataset(filePath: string, dataset: string): Promise<GoldQaItem[]>;
  loadAnswers(filePath: string): Promise<RagAnswer[]>;
  buildJudges(options: RagEvalOptions): Promise<{ judges: Judge[]; probes: ProbeItem[] } | null>;
  gitSha(repoRoot: string): Promise<string>;
  now(): Date;
}

export interface RagEvalResult {
  scorecard: RagScorecard;
  jsonPath: string;
  markdownPath: string;
}

const STUB_JUDGE_FAMILIES = ['stub-alpha', 'stub-beta', 'stub-gamma'];

export async function runRagEval(
  options: RagEvalOptions,
  dependencies: RagEvalDependencies = defaultDependencies(),
): Promise<RagEvalResult> {
  await ensureDirectory(options.outputDir);

  // --- Load gold items. ---
  const items: GoldQaItem[] = [];
  for (const dataset of options.datasets) {
    const filePath = path.join(options.dataDir, `${dataset}.jsonl`);
    let loaded: GoldQaItem[] = [];
    try {
      loaded = await dependencies.loadDataset(filePath, dataset);
    } catch (error) {
      process.stderr.write(`rag-eval: dataset ${dataset} not loaded (${(error as Error).message})\n`);
      continue;
    }
    items.push(...(options.maxItems !== undefined ? loaded.slice(0, options.maxItems) : loaded));
  }

  // --- Load or synthesize answers. ---
  const answers = await resolveAnswers(options, items, dependencies);

  // --- Build the cascade config (which tiers are wired). ---
  const tier3Build = await dependencies.buildJudges(options);
  const cascadeThresholds = {
    samples: options.samples,
    ...(options.tier1LowF1 !== undefined ? { tier1LowF1: options.tier1LowF1 } : {}),
    ...(options.tier1HighF1 !== undefined ? { tier1HighF1: options.tier1HighF1 } : {}),
  };
  const cascadeConfig: CascadeConfig = {
    thresholds: cascadeThresholds,
    ...(buildTier2(options) !== null ? { tier2: buildTier2(options) as Tier2Config } : {}),
    ...(tier3Build !== null
      ? { tier3: { judges: tier3Build.judges, probes: tier3Build.probes, panelOptions: { samples: options.samples } } satisfies Tier3Config }
      : {}),
  };

  const outcome = await runCascade(items, answers, cascadeConfig);

  const panel: PanelComposition = {
    judges: tier3Build ? tier3Build.judges.map((j) => ({ name: j.name, family: j.family })) : [],
    distinctFamilies: tier3Build ? distinctFamilies(tier3Build.judges).length : 0,
    selfConsistencyK: options.samples,
    calibrationMethod: outcome.panelCalibration?.method ?? null,
    abstentionThreshold: 0.5,
  };
  const config: ScorecardConfigProvenance = {
    provider: options.provider,
    embeddingModel: options.model,
    answererModel: options.answererModel,
    thresholds: { samples: options.samples },
    tier2Families: {
      entailment: cascadeConfig.tier2?.entailment.family ?? null,
      semantic: cascadeConfig.tier2?.semantic.family ?? null,
    },
  };

  const scorecard = buildScorecard({
    generatedAt: dependencies.now().toISOString(),
    gitSha: await dependencies.gitSha(process.cwd()),
    datasets: options.datasets,
    outcome,
    panel,
    config,
  });

  const jsonPath = path.join(options.outputDir, 'rag-eval-scorecard.json');
  await writeJsonFile(jsonPath, scorecard);
  const markdownPath = path.join(options.outputDir, 'rag-eval-scorecard.md');
  const { writeFile } = await import('fs/promises');
  await writeFile(markdownPath, formatScorecardMarkdown(scorecard), 'utf-8');

  // RFC 020 §7 ledger — log to MLflow when BENCH_MLFLOW_* is configured (no-op
  // otherwise). The payload carries the panel config + per-judge bias coefs so
  // cross-run comparisons stay within the same eval configuration (§5).
  await logRagEvalToMlflow({
    report: {
      git_sha: scorecard.git_sha,
      datasets: scorecard.datasets,
      config: {
        provider: scorecard.config.provider,
        embeddingModel: scorecard.config.embeddingModel,
        answererModel: scorecard.config.answererModel,
        tier2Families: scorecard.config.tier2Families,
      },
      panel: {
        distinctFamilies: scorecard.panel.distinctFamilies,
        selfConsistencyK: scorecard.panel.selfConsistencyK,
        calibrationMethod: scorecard.panel.calibrationMethod,
      },
      tier1: {
        exactMatch: scorecard.tier1.exactMatch,
        tokenF1: scorecard.tier1.tokenF1,
        contextRecall: scorecard.tier1.contextRecall,
        contextPrecision: scorecard.tier1.contextPrecision,
      },
      routing: scorecard.routing,
      correctness: scorecard.correctness,
      panelConfidence: scorecard.panelConfidence,
      biasProfiles: scorecard.biasProfiles.map((p) => ({
        judge: p.judge,
        family: p.family,
        biasCoefficient: p.biasCoefficient,
        positionBias: p.positionBias,
        dropped: p.dropped,
      })),
    },
    jsonPath,
    markdownPath,
    repoRoot: process.cwd(),
  });

  return { scorecard, jsonPath, markdownPath };
}

function buildTier2(options: RagEvalOptions): Tier2Config | null {
  // The only Tier-2 path runnable here is the deterministic stub (plumbing
  // self-test). A real NLI/BERTScore checkpoint is environment-dependent and is
  // left unwired (items route to Tier 3 or stay pending) unless --fake is set.
  if (!options.fake) return null;
  return { entailment: tokenOverlapEntailmentModel('stub-nli'), semantic: tokenOverlapSimilarityModel('stub-semantic') };
}

async function resolveAnswers(
  options: RagEvalOptions,
  items: readonly GoldQaItem[],
  dependencies: RagEvalDependencies,
): Promise<RagAnswer[]> {
  if (options.answersPath !== undefined) {
    return dependencies.loadAnswers(options.answersPath);
  }
  if (options.fake) {
    // Hermetic self-test: echo the first gold answer + a context that contains
    // it, so the cascade produces a complete (non-pending) scorecard offline.
    return items.map((item) => ({
      id: item.id,
      answer: item.goldAnswers[0] ?? '',
      contexts: [
        { id: `${item.id}-ctx`, text: [item.goldAnswers[0] ?? '', ...item.goldSupportingFacts].join(' ').trim() },
      ],
    }));
  }
  process.stderr.write('rag-eval: no --answers fixture and not --fake; items will be pending (run `kb ask` offline to produce answers).\n');
  return [];
}

export function defaultDependencies(): RagEvalDependencies {
  return {
    loadDataset: loadGoldQaDataset,
    loadAnswers: loadAnswersFile,
    buildJudges: defaultBuildJudges,
    gitSha,
    now: () => new Date(),
  };
}

async function loadAnswersFile(filePath: string): Promise<RagAnswer[]> {
  const { readFile } = await import('fs/promises');
  const raw = await readFile(filePath, 'utf-8');
  const answers: RagAnswer[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const row = JSON.parse(trimmed) as { id?: unknown; answer?: unknown; contexts?: unknown };
    if (typeof row.id !== 'string' || typeof row.answer !== 'string') {
      throw new Error('rag-eval: answers JSONL rows need string {id, answer}');
    }
    const contexts = Array.isArray(row.contexts)
      ? row.contexts.map((ctx, idx) => normalizeContext(ctx, `${row.id}-${idx}`))
      : [];
    answers.push({ id: row.id, answer: row.answer, contexts });
  }
  return answers;
}

function normalizeContext(value: unknown, fallbackId: string): { id: string; text: string } {
  if (typeof value === 'string') return { id: fallbackId, text: value };
  const row = value as { id?: unknown; text?: unknown };
  return {
    id: typeof row.id === 'string' ? row.id : fallbackId,
    text: typeof row.text === 'string' ? row.text : '',
  };
}

/**
 * Default judge wiring. `--fake` builds 3 deterministic stub families (so the
 * panel + probes run offline). `--judges` loads a real config and wires LLM
 * judges over the compiled provider abstraction (dynamic import keeps this
 * module free of a static src/ import, mirroring the BEIR runner seam). No
 * judges configured → Tier 3 stays unwired and its residue is pending.
 */
async function defaultBuildJudges(options: RagEvalOptions): Promise<{ judges: Judge[]; probes: ProbeItem[] } | null> {
  if (options.fake) {
    const judges = STUB_JUDGE_FAMILIES.map((family, idx) =>
      createStubJudge({ name: `stub-judge-${idx + 1}`, family }));
    return { judges, probes: stubProbes() };
  }
  if (options.judgesConfigPath === undefined) return null;

  const { readFile } = await import('fs/promises');
  const raw = await readFile(options.judgesConfigPath, 'utf-8');
  const parsed = JSON.parse(raw) as JudgeConfigEntry[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('rag-eval: --judges config must be a non-empty JSON array');
  }
  const chat = await loadChatCompletion(options.buildRoot);
  const judges = parsed.map((entry) =>
    createLlmJudge({
      name: entry.name,
      family: entry.family,
      endpoint: entry.endpoint,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      chat,
    }));
  return { judges, probes: stubProbes() };
}

/** Minimal constructed probes (§5 Tier 4); a real run derives these per-domain. */
function stubProbes(): ProbeItem[] {
  return [
    { id: 'probe-1', question: 'What is the capital of France?', contexts: ['Paris is the capital of France.'], goldAnswer: 'Paris', otherFamilyAnswer: 'Paris', selfFamily: 'stub-alpha' },
    { id: 'probe-2', question: 'Who wrote Hamlet?', contexts: ['Hamlet was written by William Shakespeare.'], goldAnswer: 'William Shakespeare', otherFamilyAnswer: 'Shakespeare', selfFamily: 'stub-beta' },
  ];
}

async function loadChatCompletion(buildRoot: string): Promise<ChatCompletionLike> {
  const url = pathToFileURL(path.join(buildRoot, 'llm-client.js')).href;
  const mod = (await import(url)) as { callChatCompletion: ChatCompletionLike };
  return mod.callChatCompletion;
}

export function parseRagEvalArgs(argv: string[]): RagEvalOptions {
  const repoRoot = process.cwd();
  const options: RagEvalOptions = {
    datasets: ragDatasetNames(),
    dataDir: process.env.RAG_EVAL_DATA_DIR ?? path.join(repoRoot, 'benchmarks', '.cache', 'rag-eval'),
    provider: process.env.EMBEDDING_PROVIDER ?? null,
    model: null,
    answererModel: null,
    samples: 5,
    fake: false,
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'rag-eval'),
    buildRoot: path.join(repoRoot, 'build', 'src'),
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
      options.datasets = readValue().split(',').map((v) => v.trim()).filter(Boolean).map(parseDataset);
    } else if (flag === '--data-dir') {
      options.dataDir = path.resolve(readValue());
    } else if (flag === '--answers') {
      options.answersPath = path.resolve(readValue());
    } else if (flag === '--judges') {
      options.judgesConfigPath = path.resolve(readValue());
    } else if (flag === '--provider') {
      options.provider = readValue();
    } else if (flag === '--model') {
      options.model = readValue();
    } else if (flag === '--answerer-model') {
      options.answererModel = readValue();
    } else if (flag === '--samples') {
      options.samples = parsePositiveInt(readValue(), '--samples');
    } else if (flag === '--max-items') {
      options.maxItems = parsePositiveInt(readValue(), '--max-items');
    } else if (flag === '--tier1-low-f1') {
      options.tier1LowF1 = parseUnitInterval(readValue(), '--tier1-low-f1');
    } else if (flag === '--tier1-high-f1') {
      options.tier1HighF1 = parseUnitInterval(readValue(), '--tier1-high-f1');
    } else if (flag === '--output-dir') {
      options.outputDir = path.resolve(readValue());
    } else if (flag === '--build-root') {
      options.buildRoot = path.resolve(readValue());
    } else if (flag === '--fake') {
      options.fake = true;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(ragEvalHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function parseDataset(raw: string): string {
  if (getRagDataset(raw) === undefined) {
    throw new Error(`unknown rag-eval dataset "${raw}"; known: ${ragDatasetNames().join(', ')}`);
  }
  return raw;
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

// Token-F1 threshold. Accepts [-1, 1]: a negative low threshold disables
// Tier 1's deterministic "incorrect" decision so the residue routes to the
// judge panel instead of being auto-failed.
function parseUnitInterval(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < -1 || parsed > 1) {
    throw new Error(`${flag} must be a number in [-1, 1]`);
  }
  return parsed;
}

function ragEvalHelpText(): string {
  return `kb end-to-end RAG eval — human-label-free four-tier cascade (RFC 020 §5, M4)

Usage:
  npm run bench:rag-eval -- --fake                 # hermetic plumbing self-test
  npm run bench:rag-eval -- --datasets=hotpotqa \\
      --data-dir=benchmarks/.cache/rag-eval \\
      --answers=answers.jsonl --judges=judges.json --samples=5

Modes:
  --fake               Deterministic stubs for every tier; complete offline scorecard.
  --answers=<jsonl>    System answers ({id,answer,contexts} per line) from kb ask.
  --judges=<json>      Array of {name,family,endpoint,model} live judges (≥3 families).

Options:
  --datasets=<a,b>     Gold-QA datasets. Default: ${ragDatasetNames().join(',')}.
  --data-dir=<p>       Dir of <dataset>.jsonl gold files. Default: benchmarks/.cache/rag-eval.
  --samples=<n>        Self-consistency K per judge×order. Default: 5.
  --max-items=<n>      Cap items per dataset (smoke runs).
  --provider/--model   Embedding provider/model recorded in the scorecard.
  --answerer-model     The kb ask LLM recorded in the scorecard provenance.
  --output-dir=<p>     Scorecard dir. Default: benchmarks/results/rag-eval.
`;
}

async function main(): Promise<void> {
  const options = parseRagEvalArgs(process.argv.slice(2));
  const { scorecard, jsonPath, markdownPath } = await runRagEval(options);
  process.stdout.write(`${jsonPath}\n${markdownPath}\n`);
  process.stdout.write(
    `tier1=${scorecard.routing.tier1Decided} tier2=${scorecard.routing.tier2Decided} ` +
      `tier3=${scorecard.routing.tier3Decided} pending=${scorecard.routing.pending} ` +
      `accuracy=${scorecard.correctness.accuracy ?? 'n/a'}\n`,
  );
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'rag-eval', 'run.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'rag-eval', 'run.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
