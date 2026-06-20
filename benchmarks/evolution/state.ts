import * as fsp from 'fs/promises';
import * as path from 'path';
import { writeJsonFile } from '../utils.js';
import {
  EVOLUTION_PLAN_SCHEMA_VERSION,
  type EvolutionDecision,
  type EvolutionPlan,
  type EvolutionState,
} from './types.js';

export interface BuiltIterationPlan {
  plan: EvolutionPlan;
}

export function nextRunId(state: EvolutionState): string {
  return `iter-${String((state.chain?.iter ?? 0) + 1).padStart(3, '0')}`;
}

export function buildIterationPlan(state: EvolutionState): BuiltIterationPlan {
  const runId = nextRunId(state);
  const currentChampion = state.current_champion;
  const command = currentChampion.command?.length
    ? currentChampion.command
    : state.bench_command?.length
      ? state.bench_command
      : ['npm', 'run', 'bench'];
  const championEnv = {
    ...(state.champion_env ?? {}),
    ...(currentChampion.env ?? {}),
  };
  const triedAgainstChampion = new Set(
    (state.candidate_history ?? [])
      .filter((entry) => entry.champion_id === currentChampion.id)
      .flatMap((entry) => entry.candidate_ids),
  );
  const eligible = (state.candidate_pool ?? [])
    .filter((candidate) => candidate.id !== currentChampion.id)
    .filter((candidate) => !triedAgainstChampion.has(candidate.id));
  const selected = eligible.slice(0, Math.max(1, state.chain?.candidates_per_iteration ?? 1));

  if (selected.length === 0) {
    throw new Error(`no eligible candidates remain for champion ${currentChampion.id}`);
  }

  return {
    plan: {
      schema_version: EVOLUTION_PLAN_SCHEMA_VERSION,
      run_id: runId,
      objective: state.objective,
      gate: state.gate,
      champion: {
        id: currentChampion.id,
        ...(currentChampion.hypothesis ? { hypothesis: currentChampion.hypothesis } : {}),
        command,
        env: championEnv,
      },
      candidates: selected.map((candidate) => ({
        ...candidate,
        command: candidate.command ?? command,
        env: {
          ...championEnv,
          ...(candidate.env ?? {}),
        },
      })),
    },
  };
}

export function applyDecisionToState(
  state: EvolutionState,
  plan: EvolutionPlan,
  decision: EvolutionDecision,
): EvolutionState {
  const winningArm = plan.candidates.find((candidate) => candidate.id === decision.winner);
  const nextChampion = decision.promoted && winningArm
    ? {
        id: winningArm.id,
        ...(winningArm.hypothesis ? { hypothesis: winningArm.hypothesis } : {}),
        ...(winningArm.command?.length ? { command: winningArm.command } : {}),
        env: winningArm.env ?? {},
      }
    : state.current_champion;

  return {
    ...state,
    current_champion: nextChampion,
    last_run_id: decision.run_id,
    last_promoted_run_id: decision.promoted ? decision.run_id : state.last_promoted_run_id,
    chain: {
      ...state.chain,
      iter: (state.chain?.iter ?? 0) + 1,
    },
    candidate_history: [
      ...(state.candidate_history ?? []),
      {
        run_id: decision.run_id,
        champion_id: decision.champion,
        candidate_ids: plan.candidates.map((candidate) => candidate.id),
        winner: decision.winner,
        promoted: decision.promoted,
        generated_at: decision.generated_at,
      },
    ],
    last_decision: {
      run_id: decision.run_id,
      champion: decision.champion,
      winner: decision.winner,
      promoted: decision.promoted,
      candidate_ids: plan.candidates.map((candidate) => candidate.id),
    },
  };
}

export function renderHistoryLine(decision: EvolutionDecision): string {
  const status = decision.promoted ? 'PROMOTE' : 'HOLD';
  const candidateSummary = decision.candidates
    .map((candidate) => {
      const objective = candidate.objective
        ? `improvement=${round(candidate.objective.improvement)}`
        : 'objective=n/a';
      const gate = candidate.qualifies ? 'qualified' : `blocked=${candidate.reasons.join('; ')}`;
      return `${candidate.arm_id}(${objective}, ${gate})`;
    })
    .join('; ');
  return `- ${decision.generated_at.slice(0, 10)} \`${decision.run_id}\` ${status} - champion ${decision.champion}; winner ${decision.winner}; candidates: ${candidateSummary}\n`;
}

export async function readEvolutionState(statePath: string): Promise<EvolutionState> {
  return JSON.parse(await fsp.readFile(statePath, 'utf-8')) as EvolutionState;
}

export async function writeEvolutionState(statePath: string, state: EvolutionState): Promise<void> {
  await writeJsonFile(statePath, state);
}

export async function appendHistory(historyPath: string, line: string): Promise<void> {
  await fsp.mkdir(path.dirname(historyPath), { recursive: true });
  await fsp.appendFile(historyPath, line, 'utf-8');
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
