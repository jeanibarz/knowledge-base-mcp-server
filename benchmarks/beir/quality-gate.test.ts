import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  DEFAULT_GATE_THRESHOLDS,
  evaluateGateComparison,
  parseQualityGateArgs,
  renderGateMarkdown,
  runQualityGate,
  summarizeGateRows,
  toleranceFor,
  type GateRunReport,
  type QualityGateDependencies,
  type QualityGateThresholds,
} from './quality-gate.js';
import type { BeirBenchmarkRunResult } from './run.js';

// A fast, deterministic threshold set for the unit tests (fewer bootstrap
// resamples than the 10k production default; the seed keeps it reproducible).
const FAST: QualityGateThresholds = {
  ...DEFAULT_GATE_THRESHOLDS,
  resamples: 2000,
};

function report(overrides: {
  mode?: GateRunReport['mode'];
  provider?: string | null;
  ndcg: number[];
}): GateRunReport {
  const ndcg = overrides.ndcg;
  const mean = ndcg.reduce((sum, v) => sum + v, 0) / ndcg.length;
  return {
    dataset: { name: 'scifact', queries_evaluated: ndcg.length },
    mode: overrides.mode ?? 'lexical',
    embedding: overrides.provider === undefined || overrides.provider === null
      ? null
      : { provider: overrides.provider, model: 'fake-embeddings' },
    metrics: { ndcgAt10: Number(mean.toFixed(6)) },
    per_query: ndcg.map((v, i) => ({ queryId: `q${i}`, ndcgAt10: v })),
  };
}

// A reproducible, varied baseline vector — varied so the per-query t-test has
// real variance to work with (a constant vector is a degenerate edge case).
function baselineVector(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(Number((0.5 + 0.4 * Math.sin(i * 1.3)).toFixed(4)));
  }
  return out;
}

describe('toleranceFor', () => {
  it('takes the larger of the absolute floor and the relative band', () => {
    // relative 2% of 0.1 = 0.002 < absolute floor 0.01 → floor wins.
    expect(toleranceFor(0.1, DEFAULT_GATE_THRESHOLDS)).toBeCloseTo(0.01, 6);
    // relative 2% of 0.8 = 0.016 > floor → relative wins.
    expect(toleranceFor(0.8, DEFAULT_GATE_THRESHOLDS)).toBeCloseTo(0.016, 6);
  });
});

describe('evaluateGateComparison', () => {
  it('FAILS a seeded, significant regression below tolerance', () => {
    const base = baselineVector(60);
    const baseline = report({ ndcg: base });
    // A consistent, large per-query drop: well below tolerance and statistically
    // significant (the paired CI excludes zero, t-test rejects).
    const current = report({ ndcg: base.map((v) => Math.max(0, v - 0.3)) });

    const row = evaluateGateComparison(baseline, current, FAST);

    expect(row.status).toBe('fail');
    expect(row.belowTolerance).toBe(true);
    expect(row.significant).toBe(true);
    expect(row.verdict).toBe('regression');
    expect(row.delta).toBeLessThan(0);
    expect(summarizeGateRows([row]).worstStatus).toBe('fail');
  });

  it('does NOT fail a non-significant dip below tolerance (reported, not failed)', () => {
    const n = 60;
    const base = baselineVector(n);
    // Mixed-sign per-query deltas: the mean is slightly negative (a dip) but the
    // spread is wide, so the drop is not statistically significant. With a zero
    // tolerance it is below the band, yet the gate must WARN, not FAIL.
    const current = report({
      ndcg: base.map((v, i) => clamp01(v + (i % 2 === 0 ? -0.4 : 0.36))),
    });
    const zeroTolerance: QualityGateThresholds = {
      ...FAST,
      relativeTolerance: 0.0001,
      absoluteTolerance: 0,
    };

    const row = evaluateGateComparison(report({ ndcg: base }), current, zeroTolerance);

    expect(row.belowTolerance).toBe(true);
    expect(row.significant).toBe(false);
    expect(row.status).toBe('warn');
    expect(row.status).not.toBe('fail');
    expect(summarizeGateRows([row]).worstStatus).not.toBe('fail');
  });

  it('PASSES a dip that stays within tolerance even if measurable', () => {
    const base = baselineVector(60);
    const baseline = report({ ndcg: base });
    // A tiny uniform drop (~0.005) — within the 0.01 absolute floor band.
    const current = report({ ndcg: base.map((v) => clamp01(v - 0.005)) });

    const row = evaluateGateComparison(baseline, current, FAST);

    expect(row.belowTolerance).toBe(false);
    expect(row.status).toBe('pass');
  });

  it('PASSES an improvement', () => {
    const base = baselineVector(60);
    const current = report({ ndcg: base.map((v) => clamp01(v + 0.1)) });
    const row = evaluateGateComparison(report({ ndcg: base }), current, FAST);
    expect(row.status).toBe('pass');
    expect(row.delta).toBeGreaterThan(0);
  });

  it('SKIPS when the baseline provider differs from the current run', () => {
    const base = baselineVector(20);
    const baseline = report({ mode: 'dense', provider: 'ollama', ndcg: base });
    const current = report({ mode: 'dense', provider: 'fake', ndcg: base.map((v) => v - 0.3) });
    const row = evaluateGateComparison(baseline, current, FAST);
    expect(row.status).toBe('skip');
    expect(row.note).toContain('like-for-like');
  });

  it('SKIPS when the two runs share no query ids', () => {
    const baseline = report({ ndcg: [0.5, 0.6] });
    const current: GateRunReport = {
      ...report({ ndcg: [0.4, 0.3] }),
      per_query: [{ queryId: 'x', ndcgAt10: 0.4 }, { queryId: 'y', ndcgAt10: 0.3 }],
    };
    const row = evaluateGateComparison(baseline, current, FAST);
    expect(row.status).toBe('skip');
    expect(row.note).toContain('pair');
  });
});

describe('summarizeGateRows + renderGateMarkdown', () => {
  it('renders a GitHub step-summary friendly table with the overall verdict', () => {
    const base = baselineVector(40);
    const failRow = evaluateGateComparison(
      report({ ndcg: base }),
      report({ ndcg: base.map((v) => Math.max(0, v - 0.3)) }),
      FAST,
    );
    const passRow = evaluateGateComparison(
      report({ mode: 'dense', provider: 'fake', ndcg: base }),
      report({ mode: 'dense', provider: 'fake', ndcg: base }),
      FAST,
    );
    const markdown = renderGateMarkdown({
      rows: [failRow, passRow],
      enforceFailures: true,
      thresholds: FAST,
      baselineLabel: 'benchmarks/results/beir/baseline',
    });
    expect(markdown).toContain('## Retrieval quality gate');
    expect(markdown).toContain('| Status | Dataset | Mode | Baseline | Current | Δ nDCG@10 | Tolerance | Significance | Verdict |');
    expect(markdown).toContain('Overall: FAIL');
    expect(markdown).toContain('enforcing FAIL rows');
  });
});

describe('runQualityGate', () => {
  it('fails the gate when a fresh run regresses against the committed baseline', async () => {
    const baselineDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-gate-baseline-'));
    const base = baselineVector(50);
    const baseline = report({ ndcg: base });
    await fsp.writeFile(path.join(baselineDir, 'scifact-lexical.json'), JSON.stringify(baseline), 'utf-8');

    const deps: QualityGateDependencies = {
      readBaseline: async (filePath) => JSON.parse(await fsp.readFile(filePath, 'utf-8')) as GateRunReport,
      runBenchmark: async (): Promise<BeirBenchmarkRunResult> => ({
        jsonPath: '', trecPath: '', reportPath: '',
        report: report({ ndcg: base.map((v) => Math.max(0, v - 0.3)) }) as unknown as BeirBenchmarkRunResult['report'],
      }),
    };

    const result = await runQualityGate({
      datasets: ['scifact'],
      modes: ['lexical'],
      provider: 'fake',
      split: 'test',
      baselineDir,
      cacheDir: path.join(baselineDir, 'cache'),
      workspaceRoot: path.join(baselineDir, 'ws'),
      outputDir: path.join(baselineDir, 'out'),
      thresholds: FAST,
    }, deps);

    expect(result.worstStatus).toBe('fail');
    expect(result.rows[0].status).toBe('fail');

    await fsp.rm(baselineDir, { recursive: true, force: true });
  });

  it('skips (never fails) a cell with no committed baseline', async () => {
    const baselineDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-gate-nobaseline-'));
    let ran = false;
    const deps: QualityGateDependencies = {
      readBaseline: async () => null,
      runBenchmark: async (): Promise<BeirBenchmarkRunResult> => {
        ran = true;
        throw new Error('should not run when baseline is missing');
      },
    };
    const result = await runQualityGate({
      datasets: ['nfcorpus'],
      modes: ['lexical'],
      provider: 'fake',
      split: 'test',
      baselineDir,
      cacheDir: path.join(baselineDir, 'cache'),
      workspaceRoot: path.join(baselineDir, 'ws'),
      outputDir: path.join(baselineDir, 'out'),
      thresholds: FAST,
    }, deps);

    expect(ran).toBe(false);
    expect(result.worstStatus).toBe('skip');
    expect(result.rows[0].status).toBe('skip');
    expect(result.rows[0].note).toContain('no committed baseline');

    await fsp.rm(baselineDir, { recursive: true, force: true });
  });

  it('records a SKIP (not a failure) when a run throws — e.g. dataset unavailable', async () => {
    const baselineDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-gate-runfail-'));
    const baseline = report({ ndcg: baselineVector(20) });
    await fsp.writeFile(path.join(baselineDir, 'scifact-lexical.json'), JSON.stringify(baseline), 'utf-8');
    const deps: QualityGateDependencies = {
      readBaseline: async (filePath) => JSON.parse(await fsp.readFile(filePath, 'utf-8')) as GateRunReport,
      runBenchmark: async (): Promise<BeirBenchmarkRunResult> => {
        throw new Error('download failed: HTTP 503');
      },
    };
    const result = await runQualityGate({
      datasets: ['scifact'],
      modes: ['lexical'],
      provider: 'fake',
      split: 'test',
      baselineDir,
      cacheDir: path.join(baselineDir, 'cache'),
      workspaceRoot: path.join(baselineDir, 'ws'),
      outputDir: path.join(baselineDir, 'out'),
      thresholds: FAST,
    }, deps);
    expect(result.worstStatus).toBe('skip');
    expect(result.rows[0].note).toContain('run failed');
    await fsp.rm(baselineDir, { recursive: true, force: true });
  });
});

describe('parseQualityGateArgs', () => {
  it('defaults to the CI subset, lexical+dense, the fake provider, and is non-enforcing', () => {
    const options = parseQualityGateArgs([], {});
    expect(options.datasets).toEqual(['scifact', 'nfcorpus', 'fiqa']);
    expect(options.modes).toEqual(['lexical', 'dense']);
    expect(options.provider).toBe('fake');
    expect(options.enforceFailures).toBe(false);
  });

  it('parses thresholds and the enforcement flag (flag or env)', () => {
    const options = parseQualityGateArgs(
      ['--tolerance=0.03', '--abs-tolerance=0.005', '--alpha=0.01', '--modes=lexical'],
      { BENCH_QUALITY_GATE_FAIL: '1' },
    );
    expect(options.thresholds.relativeTolerance).toBeCloseTo(0.03, 6);
    expect(options.thresholds.absoluteTolerance).toBeCloseTo(0.005, 6);
    expect(options.thresholds.alpha).toBeCloseTo(0.01, 6);
    expect(options.modes).toEqual(['lexical']);
    expect(options.enforceFailures).toBe(true);
  });
});

describe('committed gate fixture baselines', () => {
  // These two files are the hermetic, network-free gate baselines (lexical BM25 +
  // dense via the deterministic `fake` provider) recorded on the vendored
  // fixture corpus. Reading them here proves they parse as GateRunReports and
  // wire through the real significance comparator — and that a self-comparison
  // passes while a tampered (regressed) copy fails.
  const baselineDir = path.join(process.cwd(), 'benchmarks', 'results', 'beir', 'baseline');

  it.each(['gate-fixture-lexical.json', 'gate-fixture-dense.json'])(
    '%s self-compares to PASS (no regression against itself)',
    async (file) => {
      const baseline = JSON.parse(await fsp.readFile(path.join(baselineDir, file), 'utf-8')) as GateRunReport;
      expect(baseline.per_query.length).toBeGreaterThanOrEqual(2);
      const row = evaluateGateComparison(baseline, baseline, FAST);
      expect(row.status).toBe('pass');
      expect(row.delta).toBe(0);
    },
  );

  it('FAILS when the fixture lexical baseline is regressed', async () => {
    const baseline = JSON.parse(
      await fsp.readFile(path.join(baselineDir, 'gate-fixture-lexical.json'), 'utf-8'),
    ) as GateRunReport;
    const regressed: GateRunReport = {
      ...baseline,
      metrics: { ndcgAt10: Number((baseline.metrics.ndcgAt10 - 0.5).toFixed(6)) },
      per_query: baseline.per_query.map((q) => ({ queryId: q.queryId, ndcgAt10: Math.max(0, q.ndcgAt10 - 0.5) })),
    };
    const row = evaluateGateComparison(baseline, regressed, FAST);
    expect(row.status).toBe('fail');
    expect(row.significant).toBe(true);
  });
});

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}
