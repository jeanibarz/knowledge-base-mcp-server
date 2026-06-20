import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { BenchmarkReport } from '../types.js';
import type { EvolutionState } from './types.js';

const execFileAsync = promisify(execFile);

describe('bench:evol iteration runner', () => {
  it('runs one iteration from durable state and records state/history artifacts', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-evol-iteration-test-'));
    const statePath = path.join(tmp, 'state.json');
    const historyPath = path.join(tmp, 'history.md');
    const outRoot = path.join(tmp, 'out');
    const fakeBenchPath = path.join(tmp, 'fake-bench.js');
    await fsp.writeFile(fakeBenchPath, fakeBenchProgram(), 'utf-8');
    await fsp.writeFile(statePath, JSON.stringify(stateWith({
      bench_command: ['node', fakeBenchPath],
      candidate_pool: [
        {
          id: 'candidate',
          env: { KB_CHUNK_SIZE: '768' },
          hypothesis: 'synthetic CLI p95 improvement',
        },
      ],
    }), null, 2), 'utf-8');
    await fsp.writeFile(historyPath, '# history\n', 'utf-8');

    const completed = await execFileAsync('node', [
      '--import',
      'tsx',
      path.join(process.cwd(), 'benchmarks/evolution/iteration.ts'),
      `--state=${statePath}`,
      `--history=${historyPath}`,
      `--out-root=${outRoot}`,
    ], { cwd: process.cwd() });

    expect(completed.stdout).toContain('iteration complete: iter-001');
    await expect(fileExists(path.join(outRoot, 'iter-001', 'plan.json'))).resolves.toBe(true);
    await expect(fileExists(path.join(outRoot, 'iter-001', 'decision.json'))).resolves.toBe(true);
    const nextState = JSON.parse(await fsp.readFile(statePath, 'utf-8')) as EvolutionState;
    expect(nextState.chain.iter).toBe(1);
    expect(nextState.current_champion.id).toBe('candidate');
    expect(nextState.last_promoted_run_id).toBe('iter-001');
    const history = await fsp.readFile(historyPath, 'utf-8');
    expect(history).toContain('`iter-001` PROMOTE');
  });

  it('exits with the chain-complete code when the state cap is reached', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-evol-iteration-cap-test-'));
    const statePath = path.join(tmp, 'state.json');
    await fsp.writeFile(statePath, JSON.stringify(stateWith({
      chain: {
        iter: 1,
        candidates_per_iteration: 1,
        stop_after_iter: 1,
      },
    }), null, 2), 'utf-8');

    await expect(execFileAsync('node', [
      '--import',
      'tsx',
      path.join(process.cwd(), 'benchmarks/evolution/iteration.ts'),
      `--state=${statePath}`,
      `--history=${path.join(tmp, 'history.md')}`,
      `--out-root=${path.join(tmp, 'out')}`,
    ], { cwd: process.cwd() })).rejects.toMatchObject({
      code: 3,
      stdout: expect.stringContaining('chain cap reached'),
    });
  });
});

function stateWith(overrides: Partial<EvolutionState>): EvolutionState {
  return {
    schema_version: 1,
    playbook: '.kookr/playbooks/evolve.md',
    current_champion: {
      id: 'current-defaults',
      env: {},
    },
    last_run_id: null,
    last_promoted_run_id: null,
    bench_command: ['npm', 'run', 'bench'],
    champion_env: {
      BENCH_PROVIDER: 'stub',
      BENCH_INCLUDE_CLI_SEARCH: '1',
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
      candidates_per_iteration: 1,
      stop_after_iter: null,
    },
    candidate_pool: [],
    candidate_history: [],
    last_decision: null,
    ...overrides,
  };
}

function fakeBenchProgram(): string {
  return `
const fs = require('fs');
const path = require('path');
const out = process.env.BENCH_RESULTS_DIR || process.cwd();
fs.mkdirSync(out, { recursive: true });
const wall = process.env.KB_CHUNK_SIZE === '768' ? 80 : 100;
const report = ${JSON.stringify(reportWith(0))};
report.scenarios.cli_search.variants[0].wall_p50_ms = wall;
report.scenarios.cli_search.variants[0].wall_p95_ms = wall;
report.scenarios.cli_search.variants[0].wall_p99_ms = wall;
const file = path.join(out, \`\${process.env.BENCH_RESULTS_PREFIX}.json\`);
fs.writeFileSync(file, JSON.stringify(report));
console.log(\`JSON:\${file}\`);
`;
}

function reportWith(warmP95Ms: number): BenchmarkReport {
  return {
    arch: 'x64',
    git_sha: 'iteration-test',
    node_version: process.version,
    os: process.platform,
    provider: 'stub',
    scenarios: {
      cold_index: { chunks: 10, files: 2, ms: 1000 },
      cold_start: { fixture_documents: 2, ms: 40, rss_bytes: 1000 },
      memory_peak: { chunk_count: 10, files: 2, heap_used_bytes: 1000, rss_bytes: 2000 },
      retrieval_quality: {
        default_fanout_factor: 3,
        default_loaded_kbs: 1,
        default_recall_at_10: 1,
        query_count: 1,
        sweep: [],
      },
      warm_query: { p50_ms: 10, p95_ms: 12, p99_ms: 14, repetitions: 3 },
      cli_search: {
        schema_version: 2,
        profile: 'default',
        fixture_knowledge_bases: 1,
        fixture_files: 2,
        fixture_chunk_count: 10,
        variants: [{
          variant: 'iteration-test',
          format: 'json',
          mode: 'dense',
          effective_mode: 'dense',
          scope: 'global',
          query_shape: 'prose',
          k: 5,
          group_by_source: false,
          repetitions: 3,
          wall_p50_ms: warmP95Ms,
          wall_p95_ms: warmP95Ms,
          wall_p99_ms: warmP95Ms,
          phase_percentiles: {},
          process_start_p50_ms: null,
          bootstrap_p50_ms: null,
          model_resolution_p50_ms: null,
          manager_load_p50_ms: null,
          index_load_p50_ms: null,
          embed_query_p50_ms: null,
          faiss_search_p50_ms: null,
          post_filter_p50_ms: null,
          staleness_p50_ms: null,
          cli_total_p50_ms: null,
          rss_peak_bytes: null,
        }],
      },
    },
    version: 1,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}
