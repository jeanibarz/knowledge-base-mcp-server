import type { BenchmarkReport } from '../types.js';
import type { BudgetRow, BudgetStatus } from '../budget-diff.js';

export const EVOLUTION_PLAN_SCHEMA_VERSION = 'kb.evolution-plan.v1';
export const EVOLUTION_DECISION_SCHEMA_VERSION = 'kb.evolution-decision.v1';
export const EVOLUTION_STATE_SCHEMA_VERSION = 1;

export type EvolutionMetricDirection = 'higher' | 'lower';

export interface EvolutionObjective {
  direction: EvolutionMetricDirection;
  metric_path: string;
  min_absolute_improvement?: number;
  min_relative_improvement?: number;
}

export interface EvolutionGate {
  max_fail_rows?: number;
  max_warn_rows?: number | null;
  require_metric_present?: boolean;
}

export interface EvolutionArm {
  id: string;
  hypothesis?: string;
  axis?: string;
  env?: Record<string, string>;
  command?: string[];
  report?: string;
}

export interface EvolutionPlan {
  schema_version: typeof EVOLUTION_PLAN_SCHEMA_VERSION;
  run_id?: string;
  objective: EvolutionObjective;
  gate?: EvolutionGate;
  champion: EvolutionArm;
  candidates: EvolutionArm[];
}

export interface EvolutionArmRun {
  arm: EvolutionArm;
  report: BenchmarkReport;
  report_path?: string;
}

export interface EvolutionObjectiveDelta {
  baseline: number;
  current: number;
  delta: number;
  direction: EvolutionMetricDirection;
  improvement: number;
  relative_improvement: number | null;
  passed: boolean;
}

export interface EvolutionCandidateDecision {
  arm_id: string;
  hypothesis?: string;
  qualifies: boolean;
  reasons: string[];
  objective: EvolutionObjectiveDelta | null;
  budget_summary: Record<BudgetStatus, number>;
  budget_rows: BudgetRow[];
}

export interface EvolutionDecision {
  schema_version: typeof EVOLUTION_DECISION_SCHEMA_VERSION;
  generated_at: string;
  run_id: string;
  objective: EvolutionObjective;
  champion: string;
  winner: string;
  promoted: boolean;
  candidates: EvolutionCandidateDecision[];
}

export interface EvolutionChampion {
  id: string;
  hypothesis?: string;
  command?: string[];
  env?: Record<string, string>;
}

export interface EvolutionCandidateHistoryEntry {
  run_id: string;
  champion_id: string;
  candidate_ids: string[];
  winner: string;
  promoted: boolean;
  generated_at: string;
}

export interface EvolutionChainState {
  iter: number;
  candidates_per_iteration: number;
  stop_after_iter: number | null;
}

export interface EvolutionState {
  schema_version: typeof EVOLUTION_STATE_SCHEMA_VERSION;
  playbook: string;
  current_champion: EvolutionChampion;
  last_run_id: string | null;
  last_promoted_run_id: string | null;
  bench_command: string[];
  champion_env: Record<string, string>;
  objective: EvolutionObjective;
  gate: EvolutionGate;
  chain: EvolutionChainState;
  candidate_pool: EvolutionArm[];
  candidate_history: EvolutionCandidateHistoryEntry[];
  last_decision: {
    run_id: string;
    champion: string;
    winner: string;
    promoted: boolean;
    candidate_ids: string[];
  } | null;
}
