import type { BenchmarkReport } from '../types.js';
import { buildBudgetRows, summarizeBudgetRows } from '../budget-diff.js';
import {
  EVOLUTION_DECISION_SCHEMA_VERSION,
  type EvolutionArmRun,
  type EvolutionCandidateDecision,
  type EvolutionDecision,
  type EvolutionGate,
  type EvolutionObjective,
  type EvolutionObjectiveDelta,
} from './types.js';

const DEFAULT_GATE: Required<Pick<EvolutionGate, 'max_fail_rows' | 'require_metric_present'>> & Pick<EvolutionGate, 'max_warn_rows'> = {
  max_fail_rows: 0,
  max_warn_rows: null,
  require_metric_present: true,
};

export function decideEvolutionPromotion(input: {
  champion: EvolutionArmRun;
  candidates: EvolutionArmRun[];
  generatedAt?: Date;
  objective: EvolutionObjective;
  gate?: EvolutionGate;
  runId: string;
}): EvolutionDecision {
  const gate = { ...DEFAULT_GATE, ...input.gate };
  const candidates = input.candidates.map((candidate) =>
    evaluateCandidate(input.champion.report, candidate, input.objective, gate));
  const eligible = candidates
    .filter((candidate) => candidate.qualifies && candidate.objective !== null)
    .sort((left, right) =>
      (right.objective!.improvement - left.objective!.improvement) ||
      left.arm_id.localeCompare(right.arm_id));

  const winner = eligible[0]?.arm_id ?? input.champion.arm.id;

  return {
    schema_version: EVOLUTION_DECISION_SCHEMA_VERSION,
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    run_id: input.runId,
    objective: input.objective,
    champion: input.champion.arm.id,
    winner,
    promoted: winner !== input.champion.arm.id,
    candidates,
  };
}

function evaluateCandidate(
  championReport: BenchmarkReport,
  candidate: EvolutionArmRun,
  objective: EvolutionObjective,
  gate: EvolutionGate,
): EvolutionCandidateDecision {
  const reasons: string[] = [];
  const budgetRows = buildBudgetRows(championReport, candidate.report);
  const budgetSummary = summarizeBudgetRows(budgetRows);

  if (budgetSummary.fail > (gate.max_fail_rows ?? DEFAULT_GATE.max_fail_rows)) {
    reasons.push(`budget fail rows ${budgetSummary.fail} > ${gate.max_fail_rows ?? DEFAULT_GATE.max_fail_rows}`);
  }
  if (gate.max_warn_rows !== null && gate.max_warn_rows !== undefined && budgetSummary.warn > gate.max_warn_rows) {
    reasons.push(`budget warn rows ${budgetSummary.warn} > ${gate.max_warn_rows}`);
  }

  const objectiveDelta = readObjectiveDelta(championReport, candidate.report, objective);
  if (objectiveDelta === null) {
    if (gate.require_metric_present ?? DEFAULT_GATE.require_metric_present) {
      reasons.push(`objective metric missing: ${objective.metric_path}`);
    }
  } else if (!objectiveDelta.passed) {
    reasons.push(formatObjectiveMiss(objectiveDelta, objective));
  }

  return {
    arm_id: candidate.arm.id,
    ...(candidate.arm.hypothesis ? { hypothesis: candidate.arm.hypothesis } : {}),
    qualifies: reasons.length === 0,
    reasons,
    objective: objectiveDelta,
    budget_summary: {
      fail: budgetSummary.fail,
      pass: budgetSummary.pass,
      skip: budgetSummary.skip,
      warn: budgetSummary.warn,
    },
    budget_rows: budgetRows,
  };
}

export function readObjectiveDelta(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
  objective: EvolutionObjective,
): EvolutionObjectiveDelta | null {
  const baselineValue = readNumericPath(baseline, objective.metric_path);
  const currentValue = readNumericPath(current, objective.metric_path);
  if (baselineValue === undefined || currentValue === undefined) {
    return null;
  }

  const delta = currentValue - baselineValue;
  const improvement = objective.direction === 'higher' ? delta : -delta;
  const relativeImprovement = baselineValue === 0 ? null : improvement / Math.abs(baselineValue);
  const minAbsolute = objective.min_absolute_improvement ?? 0;
  const minRelative = objective.min_relative_improvement ?? 0;
  const absolutePassed = improvement >= minAbsolute;
  const relativePassed = minRelative === 0 || (relativeImprovement !== null && relativeImprovement >= minRelative);

  return {
    baseline: baselineValue,
    current: currentValue,
    delta,
    direction: objective.direction,
    improvement,
    relative_improvement: relativeImprovement,
    passed: absolutePassed && relativePassed,
  };
}

export function readNumericPath(value: unknown, metricPath: string): number | undefined {
  let cursor: unknown = value;
  for (const part of metricPath.split('.')) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
    } else if (cursor !== null && typeof cursor === 'object' && part in cursor) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

function formatObjectiveMiss(delta: EvolutionObjectiveDelta, objective: EvolutionObjective): string {
  const pieces = [`objective improvement ${round(delta.improvement)}`];
  if (objective.min_absolute_improvement !== undefined) {
    pieces.push(`absolute required ${objective.min_absolute_improvement}`);
  }
  if (objective.min_relative_improvement !== undefined) {
    pieces.push(`relative ${delta.relative_improvement === null ? 'n/a' : round(delta.relative_improvement)} required ${objective.min_relative_improvement}`);
  }
  return pieces.join('; ');
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
