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
