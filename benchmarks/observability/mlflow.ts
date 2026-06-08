import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { BenchmarkReport } from '../types.js';

export interface MlflowConfig {
  trackingUri?: string;
  experimentName: string;
  runName?: string;
  tags: Record<string, string>;
  python: string;
}

export interface MlflowPayload {
  tracking_uri?: string;
  experiment_name: string;
  run_name?: string;
  tags: Record<string, string>;
  params: Record<string, string>;
  metrics: Record<string, number>;
  artifacts: string[];
}

export interface MlflowBenchmarkInput {
  report: BenchmarkReport;
  reportPath: string;
  repoRoot: string;
}

export interface MlflowCompareInput {
  compareJson: unknown;
  jsonPath: string;
  htmlPath: string;
  repoRoot: string;
}

// RFC 020 §7 — the reproducibility ledger. A BEIR run is an MLflow run logged
// with the git SHA, the full retrieval env (model IDs, RRF c, rerank model/topN,
// chunk size/overlap, contextual on/off), the per-dataset metrics, the latency
// percentiles, and the TREC run-file artifact. The shapes below are the subset
// of `BeirBenchmarkReport` / `MatrixReport` the ledger consumes — declared
// structurally so this module stays decoupled from the benchmark runner.
export interface BeirLedgerReport {
  git_sha: string;
  command?: string;
  dataset: { name: string; split: string; corpus_documents?: number; queries_evaluated: number };
  mode: string;
  embedding: { provider: string; model: string } | null;
  rerank: { enabled: boolean; model: string; topN: number } | null;
  contextual: { enabled: boolean } | null;
  chunking: { KB_CHUNK_SIZE: string | null; KB_CHUNK_OVERLAP: string | null };
  metrics: {
    ndcgAt10: number;
    mapAt100: number;
    precisionAt10: number;
    recallAt10: number;
    recallAt100: number;
  };
  latency: { p50Ms: number; p95Ms: number; p99Ms: number; meanMs: number };
}

export interface MlflowBeirRunInput {
  report: BeirLedgerReport;
  jsonPath: string;
  trecPath: string;
  repoRoot: string;
}

export interface MatrixLedgerReport {
  git_sha: string;
  modes: string[];
  datasets: string[];
  env: Record<string, string | null>;
  perMode: Array<{
    mode: string;
    datasetsEvaluated: number;
    datasetsRequested: number;
    multiDomainMeanNdcgAt10: number | null;
    multiDomainMeanPrecisionAt10: number | null;
    multiDomainMeanRecallAt10: number | null;
  }>;
  generalization: {
    modes: Array<{
      mode: string;
      deltaG: { deltaG: number | null; seenMeanNdcgAt10: number | null; unseenMeanNdcgAt10: number | null };
    }>;
  };
}

export interface MlflowBeirMatrixInput {
  report: MatrixLedgerReport;
  jsonPath: string;
  markdownPath: string;
  repoRoot: string;
}

const DEFAULT_EXPERIMENT = 'kb-benchmarks';

export function readMlflowConfig(env: NodeJS.ProcessEnv = process.env): MlflowConfig | undefined {
  const hasConfig = Boolean(
    env.BENCH_MLFLOW_URI
      || env.BENCH_MLFLOW_EXPERIMENT
      || env.BENCH_MLFLOW_RUN_NAME
      || env.BENCH_MLFLOW_TAGS,
  );
  if (!hasConfig) return undefined;

  return {
    trackingUri: emptyToUndefined(env.BENCH_MLFLOW_URI),
    experimentName: emptyToUndefined(env.BENCH_MLFLOW_EXPERIMENT) ?? DEFAULT_EXPERIMENT,
    runName: emptyToUndefined(env.BENCH_MLFLOW_RUN_NAME),
    tags: parseTags(env.BENCH_MLFLOW_TAGS),
    python: emptyToUndefined(env.BENCH_MLFLOW_PYTHON) ?? 'python3',
  };
}

export async function logBenchmarkToMlflow(
  input: MlflowBenchmarkInput,
  config = readMlflowConfig(),
): Promise<void> {
  if (!config) return;
  const payload: MlflowPayload = {
    ...basePayload(config),
    params: flattenParams({
      arch: input.report.arch,
      git_sha: input.report.git_sha,
      model_id: input.report.model_id,
      model_name: input.report.model_name,
      node_version: input.report.node_version,
      os: input.report.os,
      provider: input.report.provider,
      version: input.report.version,
    }),
    metrics: flattenMetrics(input.report.scenarios),
    artifacts: [input.reportPath],
  };
  await runMlflowLogger(payload, input.repoRoot, config.python);
}

export async function logCompareToMlflow(
  input: MlflowCompareInput,
  config = readMlflowConfig(),
): Promise<void> {
  if (!config) return;
  const record = isRecord(input.compareJson) ? input.compareJson : {};
  const params = flattenParams({
    kind: 'compare',
    modelA: pickNested(record, ['modelA']),
    modelB: pickNested(record, ['modelB']),
    fixture: pickNested(record, ['fixture']),
    generatedAt: pickNested(record, ['generatedAt']),
  });
  const metrics = flattenMetrics({
    reportA: pickNested(record, ['reportA', 'scenarios']),
    reportB: pickNested(record, ['reportB', 'scenarios']),
    crossModel: pickNested(record, ['crossModel']),
    goldenQuality: pickNested(record, ['goldenQuality']),
    cost: pickNested(record, ['cost']),
  });
  await runMlflowLogger({
    ...basePayload(config),
    params,
    metrics,
    artifacts: [input.jsonPath, input.htmlPath],
  }, input.repoRoot, config.python);
}

/**
 * Build the MLflow payload for one BEIR run (RFC 020 §7). Pure + exported so the
 * ledger contract is unit-testable without spawning Python: params carry the
 * commit + full retrieval env; metrics carry per-dataset quality + latency
 * percentiles; artifacts are the metrics JSON and the TREC run file.
 */
export function beirRunMlflowPayload(input: MlflowBeirRunInput, config: MlflowConfig): MlflowPayload {
  const { report } = input;
  return {
    ...basePayload(config),
    params: flattenParams({
      kind: 'beir',
      git_sha: report.git_sha,
      dataset: report.dataset.name,
      split: report.dataset.split,
      mode: report.mode,
      provider: report.embedding?.provider ?? 'none',
      model: report.embedding?.model ?? 'none',
      rerank_enabled: report.rerank?.enabled ?? false,
      rerank_model: report.rerank?.model ?? 'none',
      rerank_top_n: report.rerank?.topN ?? 0,
      contextual: report.contextual?.enabled ?? false,
      chunk_size: report.chunking.KB_CHUNK_SIZE ?? 'default',
      chunk_overlap: report.chunking.KB_CHUNK_OVERLAP ?? 'default',
    }),
    metrics: flattenMetrics({
      ndcg_at_10: report.metrics.ndcgAt10,
      map_at_100: report.metrics.mapAt100,
      precision_at_10: report.metrics.precisionAt10,
      recall_at_10: report.metrics.recallAt10,
      recall_at_100: report.metrics.recallAt100,
      queries_evaluated: report.dataset.queries_evaluated,
      latency_p50_ms: report.latency.p50Ms,
      latency_p95_ms: report.latency.p95Ms,
      latency_p99_ms: report.latency.p99Ms,
      latency_mean_ms: report.latency.meanMs,
    }),
    artifacts: [input.jsonPath, input.trecPath],
  };
}

export async function logBeirRunToMlflow(
  input: MlflowBeirRunInput,
  config = readMlflowConfig(),
): Promise<void> {
  if (!config) return;
  await runMlflowLogger(beirRunMlflowPayload(input, config), input.repoRoot, config.python);
}

/**
 * Build the MLflow payload for a full-matrix sweep (RFC 020 §2/§6/§7): one row
 * per mode for the headline multi-domain mean nDCG@10, plus the Δ_g generality
 * gap. Pure + exported for the same testability reason as the per-run builder.
 */
export function beirMatrixMlflowPayload(input: MlflowBeirMatrixInput, config: MlflowConfig): MlflowPayload {
  const { report } = input;
  const metrics: Record<string, unknown> = {};
  for (const summary of report.perMode) {
    const key = sanitizeKeySegment(summary.mode);
    metrics[`headline.${key}.mean_ndcg_at_10`] = summary.multiDomainMeanNdcgAt10 ?? undefined;
    metrics[`headline.${key}.mean_precision_at_10`] = summary.multiDomainMeanPrecisionAt10 ?? undefined;
    metrics[`headline.${key}.mean_recall_at_10`] = summary.multiDomainMeanRecallAt10 ?? undefined;
    metrics[`headline.${key}.datasets_evaluated`] = summary.datasetsEvaluated;
  }
  for (const modeGen of report.generalization.modes) {
    const key = sanitizeKeySegment(modeGen.mode);
    if (modeGen.deltaG.deltaG !== null) metrics[`delta_g.${key}`] = modeGen.deltaG.deltaG;
  }
  return {
    ...basePayload(config),
    params: flattenParams({
      kind: 'beir-matrix',
      git_sha: report.git_sha,
      modes: report.modes,
      datasets: report.datasets,
      ...report.env,
    }),
    metrics: flattenMetrics(metrics),
    artifacts: [input.jsonPath, input.markdownPath],
  };
}

export async function logBeirMatrixToMlflow(
  input: MlflowBeirMatrixInput,
  config = readMlflowConfig(),
): Promise<void> {
  if (!config) return;
  await runMlflowLogger(beirMatrixMlflowPayload(input, config), input.repoRoot, config.python);
}

// RFC 020 §5/§7 (M4) — e2e RAG eval ledger. A scorecard run records the panel
// composition (each judge family), the self-consistency K, the calibration
// method, the per-judge bias coefficients, and the routing/correctness numbers,
// so a cross-run comparison is only ever made within the same eval config (§5
// provenance). Structurally typed to stay decoupled from the scorecard module.
export interface RagEvalLedgerReport {
  git_sha: string;
  datasets: string[];
  config: {
    provider: string | null;
    embeddingModel: string | null;
    answererModel: string | null;
    tier2Families: { entailment: string | null; semantic: string | null };
  };
  panel: { distinctFamilies: number; selfConsistencyK: number; calibrationMethod: string | null };
  tier1: { exactMatch: number; tokenF1: number; contextRecall: number | null; contextPrecision: number | null };
  routing: { items: number; tier1Decided: number; tier2Decided: number; tier3Decided: number; tier3Abstained: number; pending: number };
  correctness: { scored: number; correct: number; accuracy: number | null };
  panelConfidence: { meanSelfConsistency: number | null; meanCalibratedConfidence: number | null; abstentionRate: number | null };
  biasProfiles: Array<{ judge: string; family: string; biasCoefficient: number; positionBias: number; dropped: boolean }>;
}

export interface MlflowRagEvalInput {
  report: RagEvalLedgerReport;
  jsonPath: string;
  markdownPath: string;
  repoRoot: string;
}

/**
 * Build the MLflow payload for one e2e RAG eval scorecard (RFC 020 §5/§7). Pure
 * + exported so the ledger contract is unit-testable without spawning Python:
 * params carry the commit + panel/grader config; metrics carry the tier-1
 * deterministic scores, the routing counts, correctness, panel confidence, and
 * each judge's probe-measured bias coefficient.
 */
export function ragEvalMlflowPayload(input: MlflowRagEvalInput, config: MlflowConfig): MlflowPayload {
  const { report } = input;
  const biasMetrics: Record<string, unknown> = {};
  for (const profile of report.biasProfiles) {
    const key = sanitizeKeySegment(profile.judge);
    biasMetrics[`bias.${key}.coefficient`] = profile.biasCoefficient;
    biasMetrics[`bias.${key}.position`] = profile.positionBias;
  }
  return {
    ...basePayload(config),
    params: flattenParams({
      kind: 'rag-eval',
      git_sha: report.git_sha,
      datasets: report.datasets,
      provider: report.config.provider ?? 'none',
      embedding_model: report.config.embeddingModel ?? 'none',
      answerer_model: report.config.answererModel ?? 'none',
      nli_family: report.config.tier2Families.entailment ?? 'none',
      semantic_family: report.config.tier2Families.semantic ?? 'none',
      panel_families: report.panel.distinctFamilies,
      self_consistency_k: report.panel.selfConsistencyK,
      calibration: report.panel.calibrationMethod ?? 'none',
      dropped_judges: report.biasProfiles.filter((p) => p.dropped).map((p) => p.judge),
    }),
    metrics: flattenMetrics({
      tier1: report.tier1,
      routing: report.routing,
      correctness: { scored: report.correctness.scored, correct: report.correctness.correct, accuracy: report.correctness.accuracy ?? undefined },
      panel_confidence: {
        mean_self_consistency: report.panelConfidence.meanSelfConsistency ?? undefined,
        mean_calibrated_confidence: report.panelConfidence.meanCalibratedConfidence ?? undefined,
        abstention_rate: report.panelConfidence.abstentionRate ?? undefined,
      },
      ...biasMetrics,
    }),
    artifacts: [input.jsonPath, input.markdownPath],
  };
}

export async function logRagEvalToMlflow(input: MlflowRagEvalInput, config = readMlflowConfig()): Promise<void> {
  if (!config) return;
  await runMlflowLogger(ragEvalMlflowPayload(input, config), input.repoRoot, config.python);
}

// RFC 020 §8/§7 (M4) — MTEB submission ledger. Records the kb model, the
// canonical MTEB id, the mteb version, and the per-task + mean main scores so a
// public leaderboard claim is reproducible from commit + env.
export interface MtebLedgerReport {
  git_sha: string;
  kb_model: string;
  mteb_model_id: string;
  mteb_version: string | null;
  meanMainScore: number | null;
  tasks: Array<{ task: string; mainScore: number }>;
}

export interface MlflowMtebInput {
  report: MtebLedgerReport;
  jsonPath: string;
  markdownPath: string;
  repoRoot: string;
}

export function mtebMlflowPayload(input: MlflowMtebInput, config: MlflowConfig): MlflowPayload {
  const { report } = input;
  const taskMetrics: Record<string, unknown> = {};
  for (const task of report.tasks) taskMetrics[`task.${sanitizeKeySegment(task.task)}.main_score`] = task.mainScore;
  return {
    ...basePayload(config),
    params: flattenParams({
      kind: 'mteb',
      git_sha: report.git_sha,
      kb_model: report.kb_model,
      mteb_model_id: report.mteb_model_id,
      mteb_version: report.mteb_version ?? 'none',
      tasks: report.tasks.length,
    }),
    metrics: flattenMetrics({ mean_main_score: report.meanMainScore ?? undefined, ...taskMetrics }),
    artifacts: [input.jsonPath, input.markdownPath],
  };
}

export async function logMtebToMlflow(input: MlflowMtebInput, config = readMlflowConfig()): Promise<void> {
  if (!config) return;
  await runMlflowLogger(mtebMlflowPayload(input, config), input.repoRoot, config.python);
}

function sanitizeKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_');
}

export function flattenMetrics(value: unknown, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  collectMetrics(out, value, prefix);
  return out;
}

export function flattenParams(value: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  collectParams(out, value, prefix);
  return out;
}

function basePayload(config: MlflowConfig): Omit<MlflowPayload, 'params' | 'metrics' | 'artifacts'> {
  return {
    ...(config.trackingUri ? { tracking_uri: config.trackingUri } : {}),
    experiment_name: config.experimentName,
    ...(config.runName ? { run_name: config.runName } : {}),
    tags: config.tags,
  };
}

async function runMlflowLogger(payload: MlflowPayload, repoRoot: string, python: string): Promise<void> {
  const payloadPath = path.join(os.tmpdir(), `kb-mlflow-${process.pid}-${Date.now()}.json`);
  await fsp.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  try {
    const scriptPath = path.join(repoRoot, 'benchmarks', 'observability', 'mlflow_log.py');
    await spawnPython(python, [scriptPath, payloadPath], repoRoot);
  } finally {
    await fsp.rm(payloadPath, { force: true });
  }
}

function spawnPython(python: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`MLflow logger exited with code ${code}`));
    });
  });
}

function collectMetrics(out: Record<string, number>, value: unknown, prefix: string): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (prefix) out[metricKey(prefix)] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectMetrics(out, entry, joinKey(prefix, String(index))));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectMetrics(out, nested, joinKey(prefix, key));
  }
}

function collectParams(out: Record<string, string>, value: unknown, prefix: string): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    if (prefix) out[paramKey(prefix)] = String(value);
    return;
  }
  if (Array.isArray(value)) {
    const scalar = value.every((entry) => (
      entry === null
        || typeof entry === 'string'
        || typeof entry === 'boolean'
        || typeof entry === 'number'
    ));
    if (scalar && prefix) {
      out[paramKey(prefix)] = value.map((entry) => String(entry)).join(',');
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectParams(out, nested, joinKey(prefix, key));
  }
}

function parseTags(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const tags: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key) tags[key] = value;
  }
  return tags;
}

function metricKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 250);
}

function paramKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 250);
}

function joinKey(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function pickNested(value: Record<string, unknown>, pathParts: string[]): unknown {
  let cursor: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
