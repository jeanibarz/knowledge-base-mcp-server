// RFC 020 §8/§7 (milestone M4) — MTEB result recorder.
//
// The heavy lifting (running the official `mteb` package against the active
// embedding model) is the Python helper benchmarks/mteb_submit.py. This TS CLI
// is the record/report/ledger half: it reads either the folded result JSON the
// Python script writes (`--result`) or a directory of raw per-task `mteb` JSON
// files (`--results-dir`), assembles the canonical MtebResultRecord, renders the
// markdown report, and logs the §7 ledger entry to MLflow (no-op unless
// BENCH_MLFLOW_* is set). It never fabricates a score — an empty input yields a
// "pending" record that says so.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { gitSha, writeJsonFile } from '../utils.js';
import { logMtebToMlflow } from '../observability/mlflow.js';
import { resolveMtebModel } from './registry.js';
import {
  buildMtebRecord,
  formatMtebMarkdown,
  parseMtebTaskJson,
  type MtebResultRecord,
  type ParsedMtebTask,
} from './result.js';

export interface MtebRunOptions {
  resultPath?: string;
  resultsDir?: string;
  provider: string;
  outputDir: string;
}

interface FoldedResult {
  kb_model?: unknown;
  mteb_model_id?: unknown;
  mteb_version?: unknown;
  tasks?: unknown;
}

export interface MtebRunResult {
  record: MtebResultRecord;
  jsonPath: string;
  markdownPath: string;
}

export async function runMtebRecord(
  options: MtebRunOptions,
  now: () => Date = () => new Date(),
): Promise<MtebRunResult> {
  const entry = resolveMtebModel(options.provider);
  const kbModel = entry?.kbModel ?? options.provider;
  const mtebModelId = entry?.mtebModelId ?? options.provider;

  const tasks = options.resultsDir !== undefined
    ? await readTasksFromDir(options.resultsDir)
    : options.resultPath !== undefined
      ? await readTasksFromFolded(options.resultPath)
      : [];

  const record = buildMtebRecord({
    generatedAt: now().toISOString(),
    gitSha: await gitSha(process.cwd()),
    kbModel,
    mtebModelId,
    taskFiles: tasks,
  });

  await fsp.mkdir(options.outputDir, { recursive: true });
  const jsonPath = path.join(options.outputDir, 'mteb-result.json');
  await writeJsonFile(jsonPath, record);
  const markdownPath = path.join(options.outputDir, 'mteb-result.md');
  await fsp.writeFile(markdownPath, formatMtebMarkdown(record), 'utf-8');

  await logMtebToMlflow({
    report: {
      git_sha: record.git_sha,
      kb_model: record.kb_model,
      mteb_model_id: record.mteb_model_id,
      mteb_version: record.mteb_version,
      meanMainScore: record.meanMainScore,
      tasks: record.tasks.map((task) => ({ task: task.task, mainScore: task.mainScore })),
    },
    jsonPath,
    markdownPath,
    repoRoot: process.cwd(),
  });

  return { record, jsonPath, markdownPath };
}

async function readTasksFromDir(dir: string): Promise<ParsedMtebTask[]> {
  const tasks: ParsedMtebTask[] = [];
  const entries = await collectJsonFiles(dir);
  for (const filePath of entries) {
    const raw = await fsp.readFile(filePath, 'utf-8');
    try {
      const task = parseMtebTaskJson(raw, path.basename(filePath, '.json'));
      // Skip files that are not task results (no score extracted, unknown split).
      if (task.split !== 'unknown' || task.mainScore !== 0) tasks.push(task);
    } catch {
      // Not an mteb task file — ignore.
    }
  }
  return tasks;
}

async function readTasksFromFolded(filePath: string): Promise<ParsedMtebTask[]> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as FoldedResult;
  if (!Array.isArray(parsed.tasks)) return [];
  const version = typeof parsed.mteb_version === 'string' ? parsed.mteb_version : null;
  const tasks: ParsedMtebTask[] = [];
  for (const entry of parsed.tasks) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { task?: unknown; task_type?: unknown; split?: unknown; main_score?: unknown; metric?: unknown };
    tasks.push({
      task: typeof row.task === 'string' ? row.task : 'unknown',
      taskType: typeof row.task_type === 'string' ? row.task_type : 'unknown',
      split: typeof row.split === 'string' ? row.split : 'unknown',
      mainScore: typeof row.main_score === 'number' ? row.main_score : 0,
      metric: typeof row.metric === 'string' ? row.metric : 'main_score',
      mtebVersion: version,
    });
  }
  return tasks;
}

async function collectJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsonFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

export function parseMtebRunArgs(argv: string[]): MtebRunOptions {
  const repoRoot = process.cwd();
  const options: MtebRunOptions = {
    provider: process.env.EMBEDDING_PROVIDER ?? 'ollama',
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'mteb'),
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
    if (flag === '--result') {
      options.resultPath = path.resolve(readValue());
    } else if (flag === '--results-dir') {
      options.resultsDir = path.resolve(readValue());
    } else if (flag === '--provider') {
      options.provider = readValue();
    } else if (flag === '--output-dir') {
      options.outputDir = path.resolve(readValue());
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(mtebHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function mtebHelpText(): string {
  return `kb MTEB result recorder (RFC 020 §8, M4)

Usage:
  python3 benchmarks/mteb_submit.py --tasks=SciFact,NFCorpus --output=out.json
  npm run bench:mteb -- --result=out.json --provider=ollama

Options:
  --result=<json>      Folded result JSON from mteb_submit.py.
  --results-dir=<p>    Directory of raw per-task mteb JSON files (alternative).
  --provider=<name>    kb embedding provider (resolves the MTEB model id). Default: $EMBEDDING_PROVIDER or ollama.
  --output-dir=<p>     Report dir. Default: benchmarks/results/mteb.
`;
}

async function main(): Promise<void> {
  const options = parseMtebRunArgs(process.argv.slice(2));
  const { record, jsonPath, markdownPath } = await runMtebRecord(options);
  process.stdout.write(`${jsonPath}\n${markdownPath}\n`);
  process.stdout.write(`mteb_model=${record.mteb_model_id} tasks=${record.tasks.length} mean=${record.meanMainScore ?? 'n/a'}\n`);
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'mteb', 'run.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'mteb', 'run.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
