import type { EvolutionDecision, EvolutionState } from './types.js';
import {
  applyDecisionToState,
  buildIterationPlan,
  nextRunId,
  renderHistoryLine,
} from './state.js';

const baseState: EvolutionState = {
  schema_version: 1,
  playbook: '.kookr/playbooks/evolve.md',
  current_champion: {
    id: 'current-defaults',
    env: {
      BENCH_PROVIDER: 'stub',
      BENCH_INCLUDE_CLI_SEARCH: '1',
    },
  },
  last_run_id: null,
  last_promoted_run_id: null,
  bench_command: ['npm', 'run', 'bench'],
  champion_env: {
    BENCH_PROVIDER: 'stub',
    BENCH_CLI_SEARCH_REPETITIONS: '3',
  },
  objective: {
    metric_path: 'scenarios.cli_search.variants.0.wall_p95_ms',
    direction: 'lower',
    min_absolute_improvement: 5,
  },
  gate: {
    max_fail_rows: 0,
    max_warn_rows: null,
    require_metric_present: true,
  },
  chain: {
    iter: 0,
    candidates_per_iteration: 2,
    stop_after_iter: null,
  },
  candidate_pool: [
    {
      id: 'chunk-768-overlap-128',
      hypothesis: 'Try smaller chunks.',
      axis: 'chunking',
      env: {
        KB_CHUNK_SIZE: '768',
        KB_CHUNK_OVERLAP: '128',
      },
    },
    {
      id: 'batch-32',
      hypothesis: 'Try a smaller embedding batch.',
      axis: 'indexing-batch',
      env: {
        INDEXING_BATCH_SIZE: '32',
      },
    },
    {
      id: 'batch-128',
      hypothesis: 'Try a larger embedding batch.',
      axis: 'indexing-batch',
      env: {
        INDEXING_BATCH_SIZE: '128',
      },
    },
  ],
  candidate_history: [],
  last_decision: null,
};

describe('evolution iteration state', () => {
  it('builds a plan from durable state and selects untried candidates', () => {
    const plan = buildIterationPlan({
      ...baseState,
      candidate_history: [
        {
          run_id: 'iter-001',
          champion_id: 'current-defaults',
          candidate_ids: ['chunk-768-overlap-128'],
          winner: 'current-defaults',
          promoted: false,
          generated_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    });

    expect(nextRunId(baseState)).toBe('iter-001');
    expect(plan.plan.run_id).toBe('iter-001');
    expect(plan.plan.champion).toMatchObject({
      id: 'current-defaults',
      command: ['npm', 'run', 'bench'],
      env: {
        BENCH_PROVIDER: 'stub',
        BENCH_INCLUDE_CLI_SEARCH: '1',
        BENCH_CLI_SEARCH_REPETITIONS: '3',
      },
    });
    expect(plan.plan.candidates.map((candidate) => candidate.id)).toEqual(['batch-32', 'batch-128']);
  });

  it('promotes a winning candidate into the next champion state', () => {
    const built = buildIterationPlan(baseState);
    const decision = decisionFor({
      promoted: true,
      winner: 'chunk-768-overlap-128',
    });

    const next = applyDecisionToState(baseState, built.plan, decision);

    expect(next.current_champion).toMatchObject({
      id: 'chunk-768-overlap-128',
    });
    expect(next.current_champion.env).toEqual({
      BENCH_PROVIDER: 'stub',
      BENCH_CLI_SEARCH_REPETITIONS: '3',
      BENCH_INCLUDE_CLI_SEARCH: '1',
      KB_CHUNK_SIZE: '768',
      KB_CHUNK_OVERLAP: '128',
    });
    expect(next.chain.iter).toBe(1);
    expect(next.last_promoted_run_id).toBe('iter-001');
    expect(next.candidate_history[0]).toMatchObject({
      champion_id: 'current-defaults',
      candidate_ids: ['chunk-768-overlap-128', 'batch-32'],
    });
  });

  it('preserves a promoted command-bearing candidate as the next champion', () => {
    const commandState: EvolutionState = {
      ...baseState,
      candidate_pool: [
        {
          id: 'custom-command',
          command: ['node', 'bench.js'],
          env: {
            KB_CHUNK_SIZE: '900',
          },
        },
      ],
    };
    const built = buildIterationPlan(commandState);
    const next = applyDecisionToState(commandState, built.plan, decisionFor({
      promoted: true,
      winner: 'custom-command',
    }));
    const followup = buildIterationPlan({
      ...next,
      candidate_pool: [{ id: 'next-candidate', env: { INDEXING_BATCH_SIZE: '32' } }],
    });

    expect(next.current_champion.command).toEqual(['node', 'bench.js']);
    expect(followup.plan.champion.command).toEqual(['node', 'bench.js']);
  });

  it('renders an append-only history line with candidate reasons', () => {
    const line = renderHistoryLine(decisionFor({
      promoted: false,
      winner: 'current-defaults',
      reason: 'budget fail rows 1 > 0',
    }));

    expect(line).toContain('`iter-001` HOLD');
    expect(line).toContain('budget fail rows 1 > 0');
  });

  it('throws when no eligible candidates remain for the current champion', () => {
    expect(() => buildIterationPlan({
      ...baseState,
      chain: { ...baseState.chain, candidates_per_iteration: 1 },
      candidate_history: [
        {
          run_id: 'iter-001',
          champion_id: 'current-defaults',
          candidate_ids: ['chunk-768-overlap-128', 'batch-32', 'batch-128'],
          winner: 'current-defaults',
          promoted: false,
          generated_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })).toThrow('no eligible candidates remain');
  });
});

function decisionFor(input: {
  promoted: boolean;
  reason?: string;
  winner: string;
}): EvolutionDecision {
  return {
    schema_version: 'kb.evolution-decision.v1',
    generated_at: '2026-06-20T00:00:00.000Z',
    run_id: 'iter-001',
    objective: baseState.objective,
    champion: 'current-defaults',
    winner: input.winner,
    promoted: input.promoted,
    candidates: [
      {
        arm_id: 'chunk-768-overlap-128',
        qualifies: input.promoted,
        reasons: input.reason ? [input.reason] : [],
        objective: {
          baseline: 100,
          current: input.promoted ? 80 : 110,
          delta: input.promoted ? -20 : 10,
          direction: 'lower',
          improvement: input.promoted ? 20 : -10,
          relative_improvement: input.promoted ? 0.2 : -0.1,
          passed: input.promoted,
        },
        budget_summary: {
          fail: input.reason ? 1 : 0,
          pass: 8,
          skip: 0,
          warn: 0,
        },
        budget_rows: [],
      },
    ],
  };
}
