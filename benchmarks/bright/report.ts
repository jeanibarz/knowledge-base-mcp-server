// RFC 020 §8 (milestone M3) — the BRIGHT report.
//
// Acceptance metric: "BRIGHT nDCG recorded for hybrid+rerank vs dense baseline."
// This module assembles the per-(task × mode) points the runner collects into a
// single report and renders the headline comparison: nDCG@10 per task for each
// mode, the multi-task mean per mode, and — when both a dense baseline and a
// hybrid+rerank run are present — the per-task Δ (the quantity BRIGHT exists to
// expose, since rerank is expected to pull ahead on reasoning-intensive tasks).
//
// Pure assembly + rendering, separated from the run orchestration so it is unit
// testable on synthetic points without touching the network or an embedding
// model.

import type { BeirMode } from '../beir/run.js';

export const BRIGHT_REPORT_SCHEMA_VERSION = 'kb.bright-report.v1';

export interface BrightRunPoint {
  task: string;
  mode: BeirMode;
  ndcgAt10: number;
  precisionAt10: number;
  recallAt10: number;
  queriesEvaluated: number;
  /** Present when the cell did not actually run (dataset missing, run errored). */
  error?: string;
}

export interface BrightReport {
  schema_version: typeof BRIGHT_REPORT_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  provider: string | null;
  model: string | null;
  split: string;
  tasks: string[];
  modes: BeirMode[];
  points: BrightRunPoint[];
  /** Excluded-id deviation + fake-provider caveats travel with the report. */
  caveats: string[];
}

export interface BuildBrightReportInput {
  generatedAt: string;
  gitSha: string;
  provider: string | null;
  model: string | null;
  split: string;
  tasks: string[];
  modes: BeirMode[];
  points: BrightRunPoint[];
  caveats?: string[];
}

export function buildBrightReport(input: BuildBrightReportInput): BrightReport {
  return {
    schema_version: BRIGHT_REPORT_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    git_sha: input.gitSha,
    provider: input.provider,
    model: input.model,
    split: input.split,
    tasks: input.tasks,
    modes: input.modes,
    points: input.points,
    caveats: input.caveats ?? defaultBrightCaveats(input.provider),
  };
}

export function defaultBrightCaveats(provider: string | null): string[] {
  const caveats = [
    'Local BRIGHT reproduction, not an official BRIGHT leaderboard submission.',
    'Per-query excluded_ids are recorded for provenance but not subtracted from the ranking ' +
      '(doc-level scoring is global), so numbers may run slightly optimistic vs the official harness.',
    'Dense/hybrid retrieval is driven by the production src/ paths, not a benchmark-only reimplementation.',
  ];
  if (provider === 'fake') {
    caveats.push(
      'Provider is the deterministic fake embedder: numbers are a hermetic plumbing self-test only, ' +
        'never a quality result — BRIGHT needs a real embedding model (Ollama/OpenAI).',
    );
  }
  return caveats;
}

/** Mean nDCG@10 across the tasks that actually ran for a mode (errors excluded). */
export function meanNdcgForMode(report: BrightReport, mode: BeirMode): { mean: number; tasks: number } {
  const scored = report.points.filter((p) => p.mode === mode && p.error === undefined);
  if (scored.length === 0) return { mean: 0, tasks: 0 };
  const sum = scored.reduce((acc, p) => acc + p.ndcgAt10, 0);
  return { mean: Number((sum / scored.length).toFixed(6)), tasks: scored.length };
}

function pointFor(report: BrightReport, task: string, mode: BeirMode): BrightRunPoint | undefined {
  return report.points.find((p) => p.task === task && p.mode === mode);
}

/**
 * Per-task Δ nDCG@10 between two modes (default hybrid+rerank − dense): the
 * headline BRIGHT quantity. Only tasks where BOTH modes scored are returned.
 */
export function modeDeltas(
  report: BrightReport,
  high: BeirMode = 'hybrid+rerank',
  low: BeirMode = 'dense',
): Array<{ task: string; high: number; low: number; delta: number }> {
  const out: Array<{ task: string; high: number; low: number; delta: number }> = [];
  for (const task of report.tasks) {
    const hi = pointFor(report, task, high);
    const lo = pointFor(report, task, low);
    if (hi === undefined || lo === undefined || hi.error !== undefined || lo.error !== undefined) continue;
    out.push({ task, high: hi.ndcgAt10, low: lo.ndcgAt10, delta: Number((hi.ndcgAt10 - lo.ndcgAt10).toFixed(6)) });
  }
  return out;
}

export function formatBrightMarkdown(report: BrightReport): string {
  const lines: string[] = [
    '# BRIGHT reasoning-intensive retrieval — local report',
    '',
    'Local BRIGHT reproduction (RFC 020 §8, M3), not an official leaderboard submission.',
    '',
    `- Provider/model: ${report.provider ?? '(unset)'} / ${report.model ?? '(default)'}`,
    `- Split: ${report.split}`,
    `- Tasks: ${report.tasks.length} (${report.tasks.join(', ')})`,
    `- Modes: ${report.modes.join(', ')}`,
    '',
    '## nDCG@10 by task and mode',
    '',
  ];

  const header = ['task', ...report.modes.map(String)];
  lines.push(toRow(header), toRow(header.map(() => '---')));
  for (const task of report.tasks) {
    const cells = [task];
    for (const mode of report.modes) {
      const point = pointFor(report, task, mode);
      cells.push(point === undefined ? '—' : point.error !== undefined ? 'ERR' : point.ndcgAt10.toFixed(4));
    }
    lines.push(toRow(cells));
  }
  const meanCells = ['**mean**'];
  for (const mode of report.modes) {
    const { mean, tasks } = meanNdcgForMode(report, mode);
    meanCells.push(tasks === 0 ? '—' : `**${mean.toFixed(4)}** (${tasks})`);
  }
  lines.push(toRow(meanCells));

  // Headline comparison: hybrid+rerank vs dense, when both are present.
  if (report.modes.includes('dense') && report.modes.includes('hybrid+rerank')) {
    const deltas = modeDeltas(report, 'hybrid+rerank', 'dense');
    lines.push('', '## hybrid+rerank vs dense (Δ nDCG@10)', '');
    if (deltas.length === 0) {
      lines.push('No task ran both modes yet — Δ pending a full BRIGHT run.');
    } else {
      lines.push(toRow(['task', 'dense', 'hybrid+rerank', 'Δ']), toRow(['---', '---', '---', '---']));
      for (const d of deltas) {
        lines.push(toRow([d.task, d.low.toFixed(4), d.high.toFixed(4), signed(d.delta)]));
      }
      const meanDelta = deltas.reduce((a, d) => a + d.delta, 0) / deltas.length;
      lines.push(toRow(['**mean Δ**', '', '', `**${signed(Number(meanDelta.toFixed(6)))}**`]));
    }
  }

  if (report.points.length === 0) {
    lines.push(
      '',
      '> **No BRIGHT runs recorded yet.** A real BRIGHT run needs the BRIGHT task',
      '> data and a real embedding model; this report is the adapter scaffold. See',
      '> benchmarks/bright/README.md for the conversion + run recipe.',
    );
  }

  lines.push('', '## Caveats', '');
  for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  return `${lines.join('\n')}\n`;
}

function toRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}
