import type { BenchmarkReport } from '../types.js';
import { decideEvolutionPromotion, readNumericPath, readObjectiveDelta } from './decision.js';

const championReport = reportWith({});

describe('kb evolution promotion decision', () => {
  it('promotes the fastest candidate that clears objective and budget gates', () => {
    const candidateA = reportWith({ warmP95Ms: 88 });
    const candidateB = reportWith({ warmP95Ms: 82 });

    const decision = decideEvolutionPromotion({
      champion: { arm: { id: 'champion' }, report: championReport },
      candidates: [
        { arm: { id: 'candidate-a', hypothesis: 'small speedup' }, report: candidateA },
        { arm: { id: 'candidate-b', hypothesis: 'larger speedup' }, report: candidateB },
      ],
      generatedAt: new Date('2026-06-20T00:00:00.000Z'),
      objective: {
        metric_path: 'scenarios.warm_query.p95_ms',
        direction: 'lower',
        min_absolute_improvement: 5,
      },
      runId: 'iter-test',
    });

    expect(decision).toMatchObject({
      champion: 'champion',
      winner: 'candidate-b',
      promoted: true,
    });
    expect(decision.candidates[1]).toMatchObject({
      arm_id: 'candidate-b',
      qualifies: true,
      objective: {
        baseline: 100,
        current: 82,
        improvement: 18,
      },
    });
  });

  it('holds a faster candidate when it causes a protected quality regression', () => {
    const candidate = reportWith({ warmP95Ms: 75, retrievalRecall: 0.9 });

    const decision = decideEvolutionPromotion({
      champion: { arm: { id: 'champion' }, report: championReport },
      candidates: [{ arm: { id: 'fast-but-worse' }, report: candidate }],
      generatedAt: new Date('2026-06-20T00:00:00.000Z'),
      objective: {
        metric_path: 'scenarios.warm_query.p95_ms',
        direction: 'lower',
        min_absolute_improvement: 5,
      },
      runId: 'iter-test',
    });

    expect(decision.promoted).toBe(false);
    expect(decision.winner).toBe('champion');
    expect(decision.candidates[0].reasons).toContain('budget fail rows 1 > 0');
  });

  it('holds candidates below the pre-registered objective margin', () => {
    const candidate = reportWith({ warmP95Ms: 97 });

    const decision = decideEvolutionPromotion({
      champion: { arm: { id: 'champion' }, report: championReport },
      candidates: [{ arm: { id: 'too-small' }, report: candidate }],
      generatedAt: new Date('2026-06-20T00:00:00.000Z'),
      objective: {
        metric_path: 'scenarios.warm_query.p95_ms',
        direction: 'lower',
        min_absolute_improvement: 5,
      },
      runId: 'iter-test',
    });

    expect(decision.promoted).toBe(false);
    expect(decision.candidates[0].reasons[0]).toContain('objective improvement 3');
  });

  it('reads numeric metric paths and computes higher-is-better deltas', () => {
    expect(readNumericPath(championReport, 'scenarios.warm_query.p99_ms')).toBe(120);
    expect(readNumericPath(championReport, 'scenarios.missing.value')).toBeUndefined();

    const delta = readObjectiveDelta(championReport, reportWith({ retrievalRecall: 1 }), {
      metric_path: 'scenarios.retrieval_quality.default_recall_at_10',
      direction: 'higher',
      min_relative_improvement: 0.01,
    });

    expect(delta).toMatchObject({
      baseline: 0.98,
      current: 1,
      passed: true,
    });
    expect(delta?.improvement).toBeCloseTo(0.02);
  });
});

function reportWith(overrides: {
  coldIndexMs?: number;
  memoryRssBytes?: number;
  retrievalRecall?: number;
  warmP50Ms?: number;
  warmP95Ms?: number;
  warmP99Ms?: number;
}): BenchmarkReport {
  return {
    arch: 'x64',
    git_sha: 'abc123',
    node_version: 'v24.11.1',
    os: 'linux',
    provider: 'stub',
    scenarios: {
      cold_index: {
        chunks: 600,
        files: 100,
        ms: overrides.coldIndexMs ?? 10_000,
      },
      cold_start: {
        fixture_documents: 100,
        ms: 40,
        rss_bytes: 90 * 1024 * 1024,
      },
      memory_peak: {
        chunk_count: 600,
        files: 100,
        heap_used_bytes: 50 * 1024 * 1024,
        rss_bytes: overrides.memoryRssBytes ?? 120 * 1024 * 1024,
      },
      retrieval_quality: {
        default_fanout_factor: 3,
        default_loaded_kbs: 5,
        default_recall_at_10: overrides.retrievalRecall ?? 0.98,
        query_count: 50,
        sweep: [],
      },
      warm_query: {
        p50_ms: overrides.warmP50Ms ?? 80,
        p95_ms: overrides.warmP95Ms ?? 100,
        p99_ms: overrides.warmP99Ms ?? 120,
        repetitions: 30,
      },
    },
    version: 1,
  };
}
