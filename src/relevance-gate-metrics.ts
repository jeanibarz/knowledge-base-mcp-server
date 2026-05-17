import { emitCanonicalLog, type CanonicalProcess } from './canonical-log.js';
import type { RelevanceGateVerdict } from './relevance-gate-schema.js';

export interface RelevanceGateMetricsSnapshot {
  gated_queries: number;
  verdict_injected: number;
  verdict_no_relevant_context: number;
  verdict_empty_index: number;
  low_confidence_rate: number;
  drop_rate_A1: number;
  drop_rate_A2: number;
  drop_rate_B: number;
  judge_degrade_rate: number;
  judge_window: {
    size: number;
    degraded: number;
    rate: number;
    warn_threshold: number;
  };
}

const JUDGE_WINDOW_SIZE = 50;
const JUDGE_WARN_THRESHOLD = 0.10;
const JUDGE_WARN_MIN_SAMPLES = 5;

export class RelevanceGateMetrics {
  private gatedQueries = 0;
  private verdictInjected = 0;
  private verdictNoRelevantContext = 0;
  private verdictEmptyIndex = 0;
  private lowConfidence = 0;
  private inputCandidates = 0;
  private stageDrops = { A1: 0, A2: 0, B: 0 };
  private judgeRuns = 0;
  private judgeDegrades = 0;
  private judgeWindow: boolean[] = [];
  private lastWarnedWindow: string | null = null;

  record(verdict: RelevanceGateVerdict, process: CanonicalProcess = 'cli'): void {
    if (verdict.state === 'bypassed') return;

    this.gatedQueries += 1;
    this.inputCandidates += verdict.input_count;
    if (verdict.low_confidence) this.lowConfidence += 1;
    if (verdict.state === 'injected') this.verdictInjected += 1;
    if (verdict.state === 'no-relevant-context') this.verdictNoRelevantContext += 1;
    if (verdict.state === 'empty-index') this.verdictEmptyIndex += 1;

    for (const drop of verdict.dropped) {
      if (drop.stage.startsWith('A1-')) this.stageDrops.A1 += 1;
      if (drop.stage.startsWith('A2-')) this.stageDrops.A2 += 1;
      if (drop.stage.startsWith('B-')) this.stageDrops.B += 1;
    }

    if (verdict.judge.status === 'succeeded' || verdict.judge.status === 'failed') {
      const degraded = verdict.judge.status === 'failed';
      this.judgeRuns += 1;
      if (degraded) this.judgeDegrades += 1;
      this.judgeWindow.push(degraded);
      if (this.judgeWindow.length > JUDGE_WINDOW_SIZE) this.judgeWindow.shift();
      this.maybeEmitDegradeAlarm(process);
    }
  }

  snapshot(): RelevanceGateMetricsSnapshot {
    const windowDegraded = this.judgeWindow.filter(Boolean).length;
    const windowRate = rate(windowDegraded, this.judgeWindow.length);
    return {
      gated_queries: this.gatedQueries,
      verdict_injected: this.verdictInjected,
      verdict_no_relevant_context: this.verdictNoRelevantContext,
      verdict_empty_index: this.verdictEmptyIndex,
      low_confidence_rate: rate(this.lowConfidence, this.gatedQueries),
      drop_rate_A1: rate(this.stageDrops.A1, this.inputCandidates),
      drop_rate_A2: rate(this.stageDrops.A2, this.inputCandidates),
      drop_rate_B: rate(this.stageDrops.B, this.inputCandidates),
      judge_degrade_rate: rate(this.judgeDegrades, this.judgeRuns),
      judge_window: {
        size: this.judgeWindow.length,
        degraded: windowDegraded,
        rate: windowRate,
        warn_threshold: JUDGE_WARN_THRESHOLD,
      },
    };
  }

  reset(): void {
    this.gatedQueries = 0;
    this.verdictInjected = 0;
    this.verdictNoRelevantContext = 0;
    this.verdictEmptyIndex = 0;
    this.lowConfidence = 0;
    this.inputCandidates = 0;
    this.stageDrops = { A1: 0, A2: 0, B: 0 };
    this.judgeRuns = 0;
    this.judgeDegrades = 0;
    this.judgeWindow = [];
    this.lastWarnedWindow = null;
  }

  private maybeEmitDegradeAlarm(process: CanonicalProcess): void {
    if (this.judgeWindow.length < JUDGE_WARN_MIN_SAMPLES) return;
    const degraded = this.judgeWindow.filter(Boolean).length;
    const currentRate = rate(degraded, this.judgeWindow.length);
    if (currentRate <= JUDGE_WARN_THRESHOLD) return;
    const windowKey = this.judgeWindow.map((value) => value ? '1' : '0').join('');
    if (this.lastWarnedWindow === windowKey) return;
    this.lastWarnedWindow = windowKey;
    emitCanonicalLog({
      process,
      event: 'relevance-gate.degrade-rate',
      level: 'warn',
      tool: process === 'mcp' ? 'relevance-gate.degrade-rate' : undefined,
      cmd: process === 'cli' ? 'relevance-gate.degrade-rate' : undefined,
      took_ms: 0,
      recovery_hint:
        'Check KB_GATE_LLM_ENDPOINT / KB_GATE_LLM_MODEL health; the relevance gate is degrading to the statistical path.',
      gate: {
        judge_window_size: this.judgeWindow.length,
        judge_window_degraded: degraded,
        judge_degrade_rate: currentRate,
        warn_threshold: JUDGE_WARN_THRESHOLD,
      },
    });
  }
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export const relevanceGateMetrics = new RelevanceGateMetrics();
