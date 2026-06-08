// RFC 020 §8/§7 (milestone M4) — MTEB result record + report.
//
// The `mteb` Python package writes one JSON file per (model × task) under its
// results dir. This module parses those into a single MTEB submission record —
// the per-task main score + the mean — and renders a markdown report. Per §7
// provenance the record carries the kb model id, the canonical MTEB model id,
// the git SHA, and the exact `mteb` package version that produced it, so any
// third party can reproduce the number from commit + env. Pure parsing +
// rendering: unit-testable on a synthetic `mteb` JSON blob, no Python needed.

export const MTEB_RESULT_SCHEMA_VERSION = 'kb.mteb-result.v1';

export interface MtebTaskScore {
  task: string;
  /** MTEB task type (Retrieval, STS, Classification, …). */
  taskType: string;
  split: string;
  /** The task's headline metric value (MTEB `main_score`). */
  mainScore: number;
  metric: string;
}

export interface MtebResultRecord {
  schema_version: typeof MTEB_RESULT_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  kb_model: string;
  mteb_model_id: string;
  mteb_version: string | null;
  tasks: MtebTaskScore[];
  /** Mean main score across the evaluated tasks (the headline). */
  meanMainScore: number | null;
  caveats: string[];
}

interface RawMtebTaskFile {
  task_name?: unknown;
  mteb_version?: unknown;
  scores?: Record<string, unknown>;
  task_type?: unknown;
}

export interface BuildMtebRecordInput {
  generatedAt: string;
  gitSha: string;
  kbModel: string;
  mtebModelId: string;
  taskFiles: ParsedMtebTask[];
  caveats?: string[];
}

export interface ParsedMtebTask extends MtebTaskScore {
  mtebVersion: string | null;
}

/**
 * Parse one `mteb` task-result JSON blob (the per-task file the package writes)
 * into a flat task score. MTEB nests scores by split → list of metric records;
 * the task's `main_score` is the headline. Tolerant of the field-name drift
 * across mteb versions (test/validation split, `main_score` location).
 */
export function parseMtebTaskJson(raw: string, fallbackTask: string): ParsedMtebTask {
  const parsed = JSON.parse(raw) as RawMtebTaskFile;
  const task = typeof parsed.task_name === 'string' ? parsed.task_name : fallbackTask;
  const taskType = typeof parsed.task_type === 'string' ? parsed.task_type : 'unknown';
  const mtebVersion = typeof parsed.mteb_version === 'string' ? parsed.mteb_version : null;
  const { split, mainScore, metric } = extractMainScore(parsed.scores);
  return { task, taskType, split, mainScore, metric, mtebVersion };
}

function extractMainScore(scores: Record<string, unknown> | undefined): { split: string; mainScore: number; metric: string } {
  if (scores === undefined) return { split: 'unknown', mainScore: 0, metric: 'main_score' };
  // Prefer test, then any split present.
  const splitOrder = ['test', 'validation', 'dev', ...Object.keys(scores)];
  for (const split of splitOrder) {
    const entries = scores[split];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const first = entries[0] as Record<string, unknown>;
    const mainScore = typeof first.main_score === 'number' ? first.main_score : numberOrZero(first.main_score);
    return { split, mainScore, metric: 'main_score' };
  }
  return { split: 'unknown', mainScore: 0, metric: 'main_score' };
}

export function buildMtebRecord(input: BuildMtebRecordInput): MtebResultRecord {
  const tasks: MtebTaskScore[] = input.taskFiles.map((task) => ({
    task: task.task,
    taskType: task.taskType,
    split: task.split,
    mainScore: round(task.mainScore),
    metric: task.metric,
  }));
  const version = input.taskFiles.find((task) => task.mtebVersion !== null)?.mtebVersion ?? null;
  const meanMainScore = tasks.length === 0
    ? null
    : round(tasks.reduce((sum, task) => sum + task.mainScore, 0) / tasks.length);
  return {
    schema_version: MTEB_RESULT_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    git_sha: input.gitSha,
    kb_model: input.kbModel,
    mteb_model_id: input.mtebModelId,
    mteb_version: version,
    tasks,
    meanMainScore,
    caveats: input.caveats ?? defaultMtebCaveats(tasks.length),
  };
}

export function defaultMtebCaveats(taskCount: number): string[] {
  const caveats = [
    'MTEB ranks the embedding model, not the kb retrieval pipeline (RFC 020 §8). The BEIR matrix is the pipeline result.',
    'Reproducible from commit + env + the recorded mteb_version (§7 ledger).',
  ];
  if (taskCount === 0) {
    caveats.push(
      'No MTEB tasks recorded yet — a real run needs the `mteb` package and the active embedding model served ' +
        '(Ollama). Run benchmarks/mteb_submit.py to populate this record; no score is fabricated.',
    );
  }
  return caveats;
}

export function formatMtebMarkdown(record: MtebResultRecord): string {
  const lines: string[] = [
    '# MTEB submission — embedding-model rank',
    '',
    'Official `mteb` package run against the active kb embedding model (RFC 020 §8, M4).',
    '',
    `- kb model: ${record.kb_model}`,
    `- MTEB model id: ${record.mteb_model_id}`,
    `- mteb version: ${record.mteb_version ?? '(pending)'}`,
    `- git SHA: ${record.git_sha}`,
    `- Mean main score: ${record.meanMainScore === null ? '—' : record.meanMainScore.toFixed(4)} over ${record.tasks.length} task(s)`,
    '',
  ];
  if (record.tasks.length === 0) {
    lines.push('> **No MTEB tasks recorded yet.** Run benchmarks/mteb_submit.py with the embedding model served.', '');
  } else {
    lines.push('| Task | Type | Split | Main score |', '| --- | --- | --- | ---: |');
    for (const task of record.tasks) {
      lines.push(`| ${task.task} | ${task.taskType} | ${task.split} | ${task.mainScore.toFixed(4)} |`);
    }
    lines.push('');
  }
  lines.push('## Caveats', '');
  for (const caveat of record.caveats) lines.push(`- ${caveat}`);
  return `${lines.join('\n')}\n`;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
