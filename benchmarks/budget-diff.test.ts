import type { BenchmarkReport } from './types.js';
import {
  buildBudgetRows,
  defaultBaselinePath,
  renderBudgetMarkdown,
  summarizeBudgetRows,
} from './budget-diff.js';

const baseReport: BenchmarkReport = {
  arch: 'x64',
  git_sha: 'base123',
  node_version: 'v24.11.1',
  os: 'linux',
  provider: 'stub',
  scenarios: {
    cold_index: {
      chunks: 600,
      files: 100,
      ms: 10_000,
    },
    cold_start: {
      fixture_documents: 120,
      ms: 40,
      rss_bytes: 100 * 1024 * 1024,
    },
    memory_peak: {
      chunk_count: 600,
      files: 100,
      heap_used_bytes: 40 * 1024 * 1024,
      rss_bytes: 120 * 1024 * 1024,
    },
    retrieval_quality: {
      default_fanout_factor: 3,
      default_loaded_kbs: 5,
      default_recall_at_10: 0.98,
      query_count: 50,
      sweep: [],
    },
    warm_query: {
      p50_ms: 80,
      p95_ms: 100,
      p99_ms: 120,
      repetitions: 30,
    },
    batch_query: {
      runs: [
        {
          concurrency: 16,
          latency_p50_ms: 80,
          latency_p95_ms: 100,
          latency_p99_ms: 120,
          qps_p50: 20,
          qps_p95: 18,
          total_queries: 64,
        },
      ],
    },
    index_storage: {
      bytes_per_vector: 320,
      docstore_bytes: 8 * 1024 * 1024,
      total_bytes: 20 * 1024 * 1024,
      vector_binary_bytes: 12 * 1024 * 1024,
      vectors: 600,
    },
  },
  version: 1,
};

describe('budget diff rows', () => {
  it('classifies meaningful latency and quality regressions', () => {
    const current = reportWith({
      coldIndexMs: 12_600,
      retrievalRecall: 0.92,
      warmP50Ms: 83,
    });

    const rows = buildBudgetRows(baseReport, current);

    expect(row(rows, 'cold-index-ms')).toMatchObject({
      status: 'fail',
      baseline: 10_000,
      current: 12_600,
    });
    expect(row(rows, 'retrieval-recall-at-10')).toMatchObject({
      status: 'fail',
      delta: -0.06,
    });
    expect(row(rows, 'warm-query-p50-ms')).toMatchObject({
      status: 'pass',
    });
    expect(summarizeBudgetRows(rows)).toEqual({
      fail: 2,
      pass: 7,
      skip: 0,
      warn: 0,
      worstStatus: 'fail',
    });
  });

  it('warns before failing for moderate memory and throughput regressions', () => {
    const current = reportWith({
      batchQpsP50: 17,
      memoryRssBytes: 138 * 1024 * 1024,
    });

    const rows = buildBudgetRows(baseReport, current);

    expect(row(rows, 'memory-peak-rss-bytes')).toMatchObject({
      status: 'warn',
    });
    expect(row(rows, 'batch-query-qps-p50')).toMatchObject({
      status: 'warn',
      delta: -3,
    });
  });

  it('skips optional batch and storage rows when a baseline lacks those scenarios', () => {
    const baseline = reportWith({
      batchQuery: undefined,
      indexStorage: undefined,
    });

    const rows = buildBudgetRows(baseline, baseReport);

    expect(row(rows, 'batch-query-qps-p50')).toMatchObject({
      status: 'skip',
      note: 'No common batch-query concurrency in baseline and current report.',
    });
    expect(row(rows, 'index-storage-total-bytes')).toMatchObject({
      status: 'skip',
    });
    expect(row(rows, 'index-storage-bytes-per-vector')).toMatchObject({
      status: 'skip',
    });
  });

  it('renders a GitHub step-summary friendly table', () => {
    const rows = buildBudgetRows(baseReport, reportWith({ warmP95Ms: 118 }));
    const markdown = renderBudgetMarkdown({
      baselineLabel: 'baseline-stub-node24-linux-x64.json',
      currentLabel: 'ci-stub-node24-linux-x64.json',
      enforceFailures: false,
      rows,
    });

    expect(markdown).toContain('## Benchmark regression summary');
    expect(markdown).toContain('| Status | Budget | Baseline | Current | Delta | Threshold |');
    expect(markdown).toContain('| WARN | Warm query p95 | 100.0 ms | 118.0 ms | +18.0 ms (+18.0%) | warn >= +10.0% and +10.0 ms; fail >= +25.0% and +25.0 ms |');
    expect(markdown).toContain('Mode: advisory');
  });

  it('derives the matching committed baseline path from the current report identity', () => {
    expect(defaultBaselinePath('/repo', baseReport)).toBe(
      '/repo/benchmarks/results/baseline-stub-node24-linux-x64.json',
    );
  });
});

function reportWith(overrides: {
  batchQpsP50?: number;
  batchQuery?: BenchmarkReport['scenarios']['batch_query'];
  coldIndexMs?: number;
  indexStorage?: BenchmarkReport['scenarios']['index_storage'];
  memoryRssBytes?: number;
  retrievalRecall?: number;
  warmP50Ms?: number;
  warmP95Ms?: number;
}): BenchmarkReport {
  return {
    ...baseReport,
    git_sha: 'current123',
    scenarios: {
      ...baseReport.scenarios,
      cold_index: {
        ...baseReport.scenarios.cold_index,
        ms: overrides.coldIndexMs ?? baseReport.scenarios.cold_index.ms,
      },
      memory_peak: {
        ...baseReport.scenarios.memory_peak,
        rss_bytes: overrides.memoryRssBytes ?? baseReport.scenarios.memory_peak.rss_bytes,
      },
      retrieval_quality: {
        ...baseReport.scenarios.retrieval_quality,
        default_recall_at_10: overrides.retrievalRecall
          ?? baseReport.scenarios.retrieval_quality.default_recall_at_10,
      },
      warm_query: {
        ...baseReport.scenarios.warm_query,
        p50_ms: overrides.warmP50Ms ?? baseReport.scenarios.warm_query.p50_ms,
        p95_ms: overrides.warmP95Ms ?? baseReport.scenarios.warm_query.p95_ms,
      },
      batch_query: overrides.batchQuery === undefined && 'batchQuery' in overrides
        ? undefined
        : {
            runs: [
              {
                ...baseReport.scenarios.batch_query!.runs[0],
                qps_p50: overrides.batchQpsP50 ?? baseReport.scenarios.batch_query!.runs[0].qps_p50,
              },
            ],
          },
      index_storage: overrides.indexStorage === undefined && 'indexStorage' in overrides
        ? undefined
        : baseReport.scenarios.index_storage,
    },
  };
}

function row(rows: ReturnType<typeof buildBudgetRows>, id: string) {
  const found = rows.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`Missing row ${id}`);
  }
  return found;
}
