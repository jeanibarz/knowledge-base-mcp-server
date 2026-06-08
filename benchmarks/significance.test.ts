import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  adjustPValues,
  compareFamily,
  compareSamples,
  loadRunScores,
  pairScores,
  pairedBootstrap,
  pairedTTest,
  studentTwoSidedCritical,
  studentTwoSidedP,
  wildClusterBootstrap,
  type ComparisonResult,
  type PairedSample,
} from './significance.js';

// Deterministic fixture helpers ------------------------------------------------

/** Build paired samples from a flat delta list, single cluster. */
function samplesFromDeltas(deltas: number[], cluster = 'all'): PairedSample[] {
  return deltas.map((delta, i) => ({
    queryId: `q${i}`,
    baseline: 0,
    current: delta,
    delta,
    cluster,
  }));
}

/**
 * Build clustered samples: one delta per (cluster, query). `clusterEffects` is
 * the per-cluster mean; `withinNoise` adds a deterministic ±noise pattern so
 * the cluster-robust variance estimator is non-degenerate (a zero-variance
 * fixture makes both the t-test and the wild bootstrap ill-defined).
 */
function clusteredSamples(
  clusterEffects: number[],
  queriesPerCluster: number,
  withinNoise = 0.01,
): PairedSample[] {
  const samples: PairedSample[] = [];
  clusterEffects.forEach((effect, c) => {
    for (let i = 0; i < queriesPerCluster; i += 1) {
      const noise = withinNoise * ((i % 2 === 0 ? 1 : -1) + (i % 3) - 1);
      const delta = effect + noise;
      samples.push({ queryId: `c${c}-q${i}`, baseline: 0, current: delta, delta, cluster: `d${c}` });
    }
  });
  return samples;
}

describe('pairScores', () => {
  it('pairs by query id over the intersection and records dropped ids', () => {
    const { samples, dropped } = pairScores(
      [
        { queryId: 'a', ndcgAt10: 0.5 },
        { queryId: 'b', ndcgAt10: 0.6 },
        { queryId: 'only-baseline', ndcgAt10: 0.1 },
      ],
      [
        { queryId: 'a', ndcgAt10: 0.7 },
        { queryId: 'b', ndcgAt10: 0.6 },
        { queryId: 'only-current', ndcgAt10: 0.9 },
      ],
    );
    expect(samples.map((s) => s.queryId)).toEqual(['a', 'b']);
    expect(samples[0].delta).toBeCloseTo(0.2, 12);
    expect(samples[1].delta).toBeCloseTo(0, 12);
    expect(dropped.sort()).toEqual(['only-baseline', 'only-current']);
  });

  it('throws when the two run files share no query ids', () => {
    expect(() => pairScores(
      [{ queryId: 'a', ndcgAt10: 1 }],
      [{ queryId: 'b', ndcgAt10: 1 }],
    )).toThrow(/share no query ids/);
  });
});

describe('pairedTTest', () => {
  it('matches textbook two-sided critical values', () => {
    // t = 0 -> p = 1.
    expect(studentTwoSidedP(0, 4)).toBeCloseTo(1, 12);
    // Classic df=4 critical values: t=2.776 -> p≈0.05, t=2.132 -> p≈0.10.
    expect(studentTwoSidedP(2.776445, 4)).toBeCloseTo(0.05, 4);
    expect(studentTwoSidedP(2.131847, 4)).toBeCloseTo(0.10, 4);
    // Large df approaches the normal: t=1.959964 -> p≈0.05.
    expect(studentTwoSidedP(1.959964, 1_000_000)).toBeCloseTo(0.05, 3);
  });

  it('treats a constant non-zero delta as a deterministic difference', () => {
    const nonzero = pairedTTest([0.1, 0.1, 0.1, 0.1]);
    expect(nonzero.pValue).toBe(0);
    expect(nonzero.tStatistic).toBe(Infinity);
    const zero = pairedTTest([0, 0, 0]);
    expect(zero.pValue).toBe(1);
    expect(zero.tStatistic).toBe(0);
  });

  it('computes the paired t-statistic for a known delta vector', () => {
    // deltas mean=0.2, sample sd=0.158114, se=0.0707107 -> t=2.828427, df=4.
    const result = pairedTTest([0.1, 0.2, 0.3, 0.0, 0.4]);
    expect(result.degreesOfFreedom).toBe(4);
    expect(result.tStatistic).toBeCloseTo(2.828427, 5);
    expect(result.pValue).toBeCloseTo(0.0473, 3);
  });

  it('throws below two observations', () => {
    expect(() => pairedTTest([0.3])).toThrow(/≥2 paired observations/);
  });

  it('inverts to textbook two-sided critical t-values', () => {
    expect(studentTwoSidedCritical(4, 0.05)).toBeCloseTo(2.7764, 3);
    expect(studentTwoSidedCritical(4, 0.10)).toBeCloseTo(2.1318, 3);
    expect(studentTwoSidedCritical(1_000_000, 0.05)).toBeCloseTo(1.96, 2);
  });
});

describe('pairedBootstrap', () => {
  it('is deterministic for a fixed seed and brackets the mean delta', () => {
    const deltas = [0.1, 0.2, 0.3, 0.0, 0.4];
    const a = pairedBootstrap(deltas, 2000, 12345, 0.05);
    const b = pairedBootstrap(deltas, 2000, 12345, 0.05);
    expect(a).toEqual(b);
    expect(a.meanDelta).toBeCloseTo(0.2, 12);
    expect(a.ciLow).toBeLessThan(a.meanDelta);
    expect(a.ciHigh).toBeGreaterThan(a.meanDelta);
  });

  it('produces a CI that excludes zero for a strongly positive shift', () => {
    const deltas = Array.from({ length: 40 }, (_, i) => 0.25 + 0.02 * ((i % 5) - 2));
    const ci = pairedBootstrap(deltas, 5000, 999, 0.05);
    expect(ci.ciLow).toBeGreaterThan(0);
  });

  it('produces a CI that contains zero for a symmetric-around-zero shift', () => {
    const deltas = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    const ci = pairedBootstrap(deltas, 5000, 7, 0.05);
    expect(ci.ciLow).toBeLessThan(0);
    expect(ci.ciHigh).toBeGreaterThan(0);
  });
});

describe('compareSamples verdicts', () => {
  it('returns improvement when a positive shift is significant', () => {
    const result = compareSamples(samplesFromDeltas(
      Array.from({ length: 30 }, (_, i) => 0.2 + 0.03 * ((i % 4) - 1.5)),
    ), { label: 'rerank gain' });
    expect(result.verdict).toBe('improvement');
    expect(result.meanDelta).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('returns regression when a negative shift is significant', () => {
    const result = compareSamples(samplesFromDeltas(
      Array.from({ length: 30 }, (_, i) => -0.2 + 0.03 * ((i % 4) - 1.5)),
    ));
    expect(result.verdict).toBe('regression');
    expect(result.meanDelta).toBeLessThan(0);
  });

  it('returns no-significant-change for a noisy near-zero shift', () => {
    const result = compareSamples(samplesFromDeltas(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.3 : -0.29)),
    ));
    expect(result.verdict).toBe('no-significant-change');
  });
});

describe('wildClusterBootstrap', () => {
  it('is deterministic for a fixed seed', () => {
    const samples = clusteredSamples([0.4, -0.3, 0.45, -0.25, 0.5, -0.35, 0.4, -0.2, 0.3, -0.15, 0.25, -0.2], 8);
    const a = wildClusterBootstrap(samples, 3000, 42, 0.05);
    const b = wildClusterBootstrap(samples, 3000, 42, 0.05);
    expect(a).toEqual(b);
    expect(a.clusters).toBe(12);
  });

  it('is less significant than the naive t-test when queries cluster by domain', () => {
    // 12 domains; effects are mixed-sign with high between-cluster spread but
    // near-zero pooled mean. Treating all 96 queries as independent finds a
    // confident effect; the wild-cluster bootstrap-t, resampling whole domains,
    // does not — the honest answer when only 12 clusters disagree.
    const effects = [0.6, -0.4, 0.55, -0.35, 0.5, -0.3, 0.62, -0.45, 0.48, -0.25, 0.4, -0.5];
    const samples = clusteredSamples(effects, 8);

    const naive = compareSamples(samples, { clusterByDataset: false });
    const clustered = compareSamples(samples, { clusterByDataset: true });

    expect(clustered.wildCluster).toBeDefined();
    const wild = clustered.wildCluster!;
    // Clustering strictly widens the interval and weakens significance.
    expect(wild.pValue).toBeGreaterThan(naive.pValue);
    const naiveWidth = naive.bootstrap.ciHigh - naive.bootstrap.ciLow;
    const wildWidth = wild.ciHigh - wild.ciLow;
    expect(wildWidth).toBeGreaterThan(naiveWidth);
    // The cluster-aware verdict does not over-claim.
    expect(wild.pValue).toBeGreaterThan(0.05);
    expect(clustered.verdict).toBe('no-significant-change');
    // The Wald-t cluster CI stays bounded (no percentile-t blow-up) and, here,
    // straddles zero.
    expect(Number.isFinite(wild.ciLow)).toBe(true);
    expect(Number.isFinite(wild.ciHigh)).toBe(true);
    expect(wild.ciLow).toBeLessThan(0);
    expect(wild.ciHigh).toBeGreaterThan(0);
  });

  it('keeps the cluster CI bounded even with only two clusters', () => {
    const samples = clusteredSamples([0.3, 0.05], 5);
    const wild = wildClusterBootstrap(samples, 2000, 1, 0.05);
    expect(wild.clusters).toBe(2);
    expect(Number.isFinite(wild.ciLow)).toBe(true);
    expect(Number.isFinite(wild.ciHigh)).toBe(true);
    // A finite, sane interval — not the ±1e15 the percentile-t inversion gives.
    expect(Math.abs(wild.ciLow)).toBeLessThan(100);
    expect(Math.abs(wild.ciHigh)).toBeLessThan(100);
  });

  it('still finds improvement when every domain agrees on a positive gain', () => {
    // All 12 clusters positive with modest spread -> robust even under
    // cluster-level resampling.
    const effects = [0.22, 0.25, 0.2, 0.28, 0.24, 0.21, 0.27, 0.23, 0.26, 0.2, 0.29, 0.22];
    const samples = clusteredSamples(effects, 8);
    const clustered = compareSamples(samples, { clusterByDataset: true });
    expect(clustered.wildCluster).toBeDefined();
    expect(clustered.wildCluster!.pValue).toBeLessThan(0.05);
    expect(clustered.verdict).toBe('improvement');
  });
});

describe('adjustPValues — multiple-comparison correction', () => {
  const raw = [0.01, 0.02, 0.03, 0.04];

  it('applies Bonferroni by scaling by the family size and clamping to 1', () => {
    expect(adjustPValues(raw, 'bonferroni')).toEqual([0.04, 0.08, 0.12, 0.16]);
    expect(adjustPValues([0.3, 0.4], 'bonferroni')).toEqual([0.6, 0.8]);
    expect(adjustPValues([0.6, 0.7], 'bonferroni')).toEqual([1, 1]);
  });

  it('applies Holm step-down with monotonic non-decrease', () => {
    // 0.01*4=0.04; 0.02*3=0.06; 0.03*2=0.06; 0.04*1=0.04 -> running max 0.06.
    const holm = adjustPValues(raw, 'holm');
    expect(holm[0]).toBeCloseTo(0.04, 12);
    expect(holm[1]).toBeCloseTo(0.06, 12);
    expect(holm[2]).toBeCloseTo(0.06, 12);
    expect(holm[3]).toBeCloseTo(0.06, 12);
  });

  it('reproduces the KB-cited risk: naive marks all 4 significant, correction leaves 1', () => {
    const uncorrectedSignificant = raw.filter((p) => p < 0.05).length;
    expect(uncorrectedSignificant).toBe(4);
    const bonferroniSignificant = adjustPValues(raw, 'bonferroni').filter((p) => p < 0.05).length;
    const holmSignificant = adjustPValues(raw, 'holm').filter((p) => p < 0.05).length;
    expect(bonferroniSignificant).toBe(1);
    expect(holmSignificant).toBe(1);
  });

  it('preserves input order under Holm regardless of sort order', () => {
    const unordered = [0.04, 0.01, 0.03, 0.02];
    const holm = adjustPValues(unordered, 'holm');
    // index 1 (raw 0.01) is the smallest -> 0.04; the largest raw 0.04 -> 0.06.
    expect(holm[1]).toBeCloseTo(0.04, 12);
    expect(holm[0]).toBeCloseTo(0.06, 12);
  });
});

describe('compareFamily', () => {
  function fakeComparison(label: string, meanDelta: number, pValue: number): ComparisonResult {
    return {
      label,
      n: 50,
      clusters: 1,
      meanDelta,
      tStatistic: 0,
      degreesOfFreedom: 49,
      pValue,
      bootstrap: { resamples: 0, meanDelta, ciLow: meanDelta, ciHigh: meanDelta, pLessEqualZero: 0 },
      verdict: pValue < 0.05 ? (meanDelta >= 0 ? 'improvement' : 'regression') : 'no-significant-change',
    };
  }

  it('downgrades family members the correction no longer rejects', () => {
    const family = compareFamily([
      fakeComparison('dense->hybrid', 0.05, 0.01),
      fakeComparison('hybrid->rerank', 0.03, 0.02),
      fakeComparison('rerank->contextual', 0.02, 0.03),
      fakeComparison('chunk-tweak', 0.01, 0.04),
    ], 'holm', 0.05);

    const verdicts = family.comparisons.map((c) => c.correctedVerdict);
    // Only the strongest survives Holm at α=0.05.
    expect(verdicts).toEqual([
      'improvement',
      'no-significant-change',
      'no-significant-change',
      'no-significant-change',
    ]);
    expect(family.comparisons[0].rejectedNull).toBe(true);
    expect(family.comparisons[0].adjustedPValue).toBeCloseTo(0.04, 12);
  });

  it('prefers the wild-cluster p-value when a comparison carries one', () => {
    const clustered = fakeComparison('multi-domain', 0.2, 0.001);
    clustered.wildCluster = {
      clusters: 3,
      resamples: 1000,
      meanDelta: 0.2,
      tStatistic: 1,
      clusterRobustStdError: 0.2,
      ciLow: -0.1,
      ciHigh: 0.5,
      pValue: 0.4,
    };
    const family = compareFamily([clustered], 'bonferroni', 0.05);
    // The cluster-aware p (0.4), not the naive 0.001, drives the verdict.
    expect(family.comparisons[0].adjustedPValue).toBeCloseTo(0.4, 12);
    expect(family.comparisons[0].correctedVerdict).toBe('no-significant-change');
  });
});

describe('loadRunScores', () => {
  it('reads per_query nDCG@10 vectors and namespaces ids by dataset cluster', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sig-load-'));
    const scifact = path.join(dir, 'scifact.json');
    const nfcorpus = path.join(dir, 'nfcorpus.json');
    await fsp.writeFile(scifact, JSON.stringify({
      dataset: { name: 'scifact' },
      per_query: [
        { queryId: '1', ndcgAt10: 0.5 },
        { queryId: '2', ndcgAt10: 0.6 },
      ],
    }), 'utf-8');
    await fsp.writeFile(nfcorpus, JSON.stringify({
      dataset: { name: 'nfcorpus' },
      per_query: [{ queryId: '1', ndcgAt10: 0.4 }],
    }), 'utf-8');

    const scores = await loadRunScores([scifact, nfcorpus]);
    expect(scores).toEqual([
      { queryId: 'scifact:1', ndcgAt10: 0.5, cluster: 'scifact' },
      { queryId: 'scifact:2', ndcgAt10: 0.6, cluster: 'scifact' },
      { queryId: 'nfcorpus:1', ndcgAt10: 0.4, cluster: 'nfcorpus' },
    ]);

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('rejects a file that is not a BEIR run report', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sig-bad-'));
    const bad = path.join(dir, 'bad.json');
    await fsp.writeFile(bad, JSON.stringify({ not: 'a-report' }), 'utf-8');
    await expect(loadRunScores([bad])).rejects.toThrow(/no per_query array/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
