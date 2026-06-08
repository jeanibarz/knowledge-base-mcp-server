// RFC 020 §3 — retrieval significance comparator.
//
// "Add a comparator that takes two run files (per-query nDCG@10 vectors over
// the same query set) and reports a paired bootstrap (10k resamples) CI on the
// mean delta, a paired t-test p-value, and a verdict (improvement / regression
// / no-significant-change) at α = 0.05."
//
// This is the arbiter for every roadmap decision (M1+) and for the future CI
// gate's "is this a real regression?" question. It lives next to
// `benchmarks/budget-diff.ts` (the established two-run comparison pattern) and
// reuses its CLI shape (`--baseline` / `--current` / `--fail-on-regression` /
// `--summary`).
//
// Two correctness properties drive the design:
//
//   1. **Pairing.** nDCG@10 is compared per query, paired by query id over the
//      intersection of the two run files. An unpaired (Welch) test would throw
//      away the variance reduction that makes per-query deltas powerful and
//      would silently compare different query subsets.
//
//   2. **Multiple comparisons.** A sweep compares many configs at once;
//      reporting each delta at α = 0.05 inflates the family-wise error rate.
//      `adjustPValues` applies Bonferroni or Holm across the comparison family.
//      And because BEIR queries cluster by dataset/domain — per-query results
//      within one dataset are not independent — the comparator also offers a
//      **wild-cluster bootstrap-t** (Cameron–Gelbach–Miller) that resamples at
//      the cluster level, so a family spanning several datasets gets a CI that
//      respects the intra-dataset correlation instead of pretending every query
//      is independent.
//
// Everything here is deterministic: the bootstrap uses a seeded PRNG (default
// seed below), so a given pair of run files always yields the same CI and the
// same verdict — a precondition for a reproducible ledger (RFC §7).

import * as fsp from 'fs/promises';
import * as path from 'path';

export const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000;
export const DEFAULT_ALPHA = 0.05;
// Fixed default seed keeps the CLI reproducible run-to-run (RFC §7 ledger).
export const DEFAULT_BOOTSTRAP_SEED = 0x9e3779b9;

export type Verdict = 'improvement' | 'regression' | 'no-significant-change';
export type CorrectionMethod = 'bonferroni' | 'holm' | 'none';

export interface PerQueryScore {
  queryId: string;
  ndcgAt10: number;
  /** Cluster label (BEIR dataset/domain). Drives the wild-cluster bootstrap. */
  cluster?: string;
}

export interface PairedSample {
  queryId: string;
  baseline: number;
  current: number;
  delta: number;
  cluster: string;
}

export interface BootstrapCi {
  resamples: number;
  meanDelta: number;
  ciLow: number;
  ciHigh: number;
  /** Fraction of resampled mean deltas that are ≤ 0 (one-sided diagnostic). */
  pLessEqualZero: number;
}

export interface ComparisonResult {
  label: string;
  n: number;
  clusters: number;
  meanDelta: number;
  /** Paired t-test. */
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
  bootstrap: BootstrapCi;
  /** Present only when `clusterByDataset` is requested and >1 cluster exists. */
  wildCluster?: WildClusterResult;
  /** Verdict from the comparison alone (no family correction). */
  verdict: Verdict;
}

export interface WildClusterResult {
  clusters: number;
  resamples: number;
  meanDelta: number;
  tStatistic: number;
  clusterRobustStdError: number;
  ciLow: number;
  ciHigh: number;
  pValue: number;
}

export interface FamilyComparison extends ComparisonResult {
  adjustedPValue: number;
  rejectedNull: boolean;
  /** Verdict after family-wise multiple-comparison correction. */
  correctedVerdict: Verdict;
}

export interface FamilyResult {
  method: CorrectionMethod;
  alpha: number;
  comparisons: FamilyComparison[];
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * Pair two per-query score vectors by query id over their intersection.
 *
 * Throws when the intersection is empty (comparing disjoint query sets is a
 * caller bug, not a "no change" result). Query ids present in only one vector
 * are dropped with their ids recorded on the returned `dropped` list so the
 * caller can surface the mismatch. The cluster label is taken from the baseline
 * vector (falling back to current), defaulting to `'all'` when neither carries
 * one — i.e. the unclustered case collapses to a single cluster.
 */
export function pairScores(
  baseline: readonly PerQueryScore[],
  current: readonly PerQueryScore[],
): { samples: PairedSample[]; dropped: string[] } {
  const currentById = new Map<string, PerQueryScore>();
  for (const row of current) currentById.set(row.queryId, row);
  const baselineIds = new Set(baseline.map((row) => row.queryId));

  const samples: PairedSample[] = [];
  const dropped: string[] = [];
  for (const baseRow of baseline) {
    const curRow = currentById.get(baseRow.queryId);
    if (curRow === undefined) {
      dropped.push(baseRow.queryId);
      continue;
    }
    samples.push({
      queryId: baseRow.queryId,
      baseline: baseRow.ndcgAt10,
      current: curRow.ndcgAt10,
      delta: curRow.ndcgAt10 - baseRow.ndcgAt10,
      cluster: baseRow.cluster ?? curRow.cluster ?? 'all',
    });
  }
  for (const curRow of current) {
    if (!baselineIds.has(curRow.queryId)) dropped.push(curRow.queryId);
  }
  if (samples.length === 0) {
    throw new Error('significance: the two run files share no query ids; cannot pair nDCG@10 vectors');
  }
  return { samples, dropped };
}

// ---------------------------------------------------------------------------
// Single comparison
// ---------------------------------------------------------------------------

export interface CompareOptions {
  label?: string;
  resamples?: number;
  seed?: number;
  alpha?: number;
  /** Add the wild-cluster bootstrap-t leg (queries cluster by dataset). */
  clusterByDataset?: boolean;
}

export function compareScores(
  baseline: readonly PerQueryScore[],
  current: readonly PerQueryScore[],
  options: CompareOptions = {},
): ComparisonResult {
  const { samples } = pairScores(baseline, current);
  return compareSamples(samples, options);
}

export function compareSamples(
  samples: readonly PairedSample[],
  options: CompareOptions = {},
): ComparisonResult {
  const label = options.label ?? 'comparison';
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const deltas = samples.map((s) => s.delta);
  const n = deltas.length;
  const clusters = new Set(samples.map((s) => s.cluster)).size;

  const meanDelta = mean(deltas);
  const ttest = pairedTTest(deltas);
  const bootstrap = pairedBootstrap(deltas, resamples, seed, alpha);
  const wildCluster = options.clusterByDataset && clusters > 1
    ? wildClusterBootstrap(samples, resamples, seed ^ 0x5bd1e995, alpha)
    : undefined;

  return {
    label,
    n,
    clusters,
    meanDelta,
    tStatistic: ttest.tStatistic,
    degreesOfFreedom: ttest.degreesOfFreedom,
    pValue: ttest.pValue,
    bootstrap,
    ...(wildCluster !== undefined ? { wildCluster } : {}),
    verdict: verdictFromResult(meanDelta, ttest.pValue, bootstrap, wildCluster, alpha),
  };
}

/**
 * Paired (one-sample on the deltas) two-sided t-test. With s = 0 the deltas are
 * a constant: a non-zero constant is a deterministic difference (p → 0), a zero
 * constant is no difference at all (p = 1).
 */
export function pairedTTest(deltas: readonly number[]): {
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
} {
  const n = deltas.length;
  if (n < 2) {
    throw new Error(`significance: need ≥2 paired observations for a t-test, got ${n}`);
  }
  const m = mean(deltas);
  const variance = deltas.reduce((acc, d) => acc + (d - m) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const df = n - 1;
  if (sd === 0) {
    return { tStatistic: m === 0 ? 0 : Math.sign(m) * Infinity, degreesOfFreedom: df, pValue: m === 0 ? 1 : 0 };
  }
  const standardError = sd / Math.sqrt(n);
  const tStatistic = m / standardError;
  return { tStatistic, degreesOfFreedom: df, pValue: studentTwoSidedP(tStatistic, df) };
}

/**
 * Paired bootstrap: resample the n deltas with replacement `resamples` times,
 * record each resample's mean, and take the [α/2, 1−α/2] percentile interval
 * on the mean delta. Deterministic given the seed.
 */
export function pairedBootstrap(
  deltas: readonly number[],
  resamples: number,
  seed: number,
  alpha: number,
): BootstrapCi {
  const n = deltas.length;
  const meanDelta = mean(deltas);
  if (n === 0) {
    return { resamples, meanDelta: 0, ciLow: 0, ciHigh: 0, pLessEqualZero: 1 };
  }
  const random = mulberry32(seed >>> 0);
  const means = new Float64Array(resamples);
  let leZero = 0;
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += deltas[(random() * n) | 0];
    }
    const resampleMean = sum / n;
    means[b] = resampleMean;
    if (resampleMean <= 0) leZero += 1;
  }
  const sorted = Array.from(means).sort((a, b) => a - b);
  return {
    resamples,
    meanDelta,
    ciLow: quantileSorted(sorted, alpha / 2),
    ciHigh: quantileSorted(sorted, 1 - alpha / 2),
    pLessEqualZero: leZero / resamples,
  };
}

/**
 * Wild-cluster bootstrap-t for the mean of clustered paired deltas (Cameron,
 * Gelbach & Miller 2008). The mean delta is a one-parameter model; its
 * cluster-robust (CR0) sandwich standard error is
 *
 *     SE = sqrt( Σ_g ( Σ_{i∈g} (dᵢ − d̄) )² ) / n.
 *
 * Each bootstrap replication draws one Rademacher weight wₘ ∈ {−1,+1} per
 * cluster, perturbs the centered residuals as d*ᵢ = d̄ + w_{g(i)}·(dᵢ − d̄), and
 * recomputes t* = (d̄* − d̄) / SE*. The reported **p-value** is the share of
 * |t*| at least as extreme as the observed |t| — the cluster-aware inference,
 * robust even with few clusters, which is the whole point for the BEIR matrix
 * (queries within a dataset are not independent).
 *
 * The **CI**, by contrast, is the cluster-robust Wald interval d̄ ± t_{G−1}·SE,
 * NOT the percentile-t inversion of the bootstrap t-distribution. With very few
 * clusters (BEIR's CI subset is 3) the percentile-t interval is numerically
 * unstable — a replication with SE* ≈ 0 sends a t* quantile to ±∞ and the
 * interval explodes — whereas the Wald-t interval stays bounded and honest. The
 * bootstrap is reserved for the p-value, where it is well-behaved; the interval
 * uses the G−1 t-approximation that is standard for cluster-robust inference.
 */
export function wildClusterBootstrap(
  samples: readonly PairedSample[],
  resamples: number,
  seed: number,
  alpha: number,
): WildClusterResult {
  const n = samples.length;
  const deltas = samples.map((s) => s.delta);
  const meanDelta = mean(deltas);

  // Group observation indices by cluster.
  const clusterIndexes = new Map<string, number[]>();
  for (let i = 0; i < samples.length; i += 1) {
    const key = samples[i].cluster;
    const bucket = clusterIndexes.get(key);
    if (bucket === undefined) clusterIndexes.set(key, [i]);
    else bucket.push(i);
  }
  const clusterGroups = [...clusterIndexes.values()];
  const residuals = deltas.map((d) => d - meanDelta);
  const seObserved = clusterRobustStdError(deltas, meanDelta, clusterGroups, n);
  const tObserved = seObserved === 0 ? 0 : meanDelta / seObserved;

  const random = mulberry32(seed >>> 0);
  const absObserved = Math.abs(tObserved);
  let extreme = 0;
  for (let b = 0; b < resamples; b += 1) {
    const starDeltas = deltas.slice();
    for (const group of clusterGroups) {
      const weight = random() < 0.5 ? -1 : 1;
      for (const i of group) starDeltas[i] = meanDelta + weight * residuals[i];
    }
    const starMean = mean(starDeltas);
    const starSe = clusterRobustStdError(starDeltas, starMean, clusterGroups, n);
    const tStar = starSe === 0 ? 0 : (starMean - meanDelta) / starSe;
    if (Math.abs(tStar) >= absObserved) extreme += 1;
  }

  // Cluster-robust Wald-t interval with G−1 degrees of freedom (bounded).
  const dfCluster = Math.max(1, clusterGroups.length - 1);
  const tCritical = studentTwoSidedCritical(dfCluster, alpha);
  return {
    clusters: clusterGroups.length,
    resamples,
    meanDelta,
    tStatistic: tObserved,
    clusterRobustStdError: seObserved,
    ciLow: meanDelta - tCritical * seObserved,
    ciHigh: meanDelta + tCritical * seObserved,
    pValue: extreme / resamples,
  };
}

function clusterRobustStdError(
  deltas: readonly number[],
  m: number,
  clusterGroups: readonly number[][],
  n: number,
): number {
  let sandwich = 0;
  for (const group of clusterGroups) {
    let clusterSum = 0;
    for (const i of group) clusterSum += deltas[i] - m;
    sandwich += clusterSum * clusterSum;
  }
  return Math.sqrt(sandwich) / n;
}

// ---------------------------------------------------------------------------
// Multiple-comparison correction across a family
// ---------------------------------------------------------------------------

/**
 * Family-wise adjusted p-values. `bonferroni` scales every p by the family size
 * m; `holm` is the uniformly-more-powerful step-down variant (sort ascending,
 * scale the k-th smallest by m−k+1, enforce monotonic non-decrease). Both clamp
 * to ≤ 1 and preserve input order in the returned array.
 */
export function adjustPValues(pValues: readonly number[], method: CorrectionMethod): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  if (method === 'none') return pValues.map((p) => clamp01(p));
  if (method === 'bonferroni') return pValues.map((p) => clamp01(p * m));

  // Holm step-down.
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach((entry, rank) => {
    const scaled = clamp01(entry.p * (m - rank));
    running = Math.max(running, scaled);
    adjusted[entry.index] = running;
  });
  return adjusted;
}

/**
 * Run a family of comparisons and apply a multiple-comparison correction across
 * them. Each comparison keeps its own (uncorrected) verdict; `correctedVerdict`
 * downgrades to `no-significant-change` whenever the family-wise correction no
 * longer rejects the null, and otherwise carries the sign of the mean delta.
 */
export function compareFamily(
  comparisons: readonly ComparisonResult[],
  method: CorrectionMethod = 'holm',
  alpha: number = DEFAULT_ALPHA,
): FamilyResult {
  // Prefer the wild-cluster p-value when present (it is the honest one for
  // clustered queries); fall back to the paired t-test p otherwise.
  const pValues = comparisons.map((c) => c.wildCluster?.pValue ?? c.pValue);
  const adjusted = adjustPValues(pValues, method);
  const familyComparisons = comparisons.map((comparison, index) => {
    const adjustedPValue = adjusted[index];
    const rejectedNull = adjustedPValue < alpha;
    const correctedVerdict: Verdict = rejectedNull
      ? comparison.meanDelta >= 0 ? 'improvement' : 'regression'
      : 'no-significant-change';
    return { ...comparison, adjustedPValue, rejectedNull, correctedVerdict };
  });
  return { method, alpha, comparisons: familyComparisons };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function verdictFromResult(
  meanDelta: number,
  pValue: number,
  bootstrap: BootstrapCi,
  wildCluster: WildClusterResult | undefined,
  alpha: number,
): Verdict {
  // A change is "significant" when the bootstrap CI excludes zero AND the
  // (cluster-aware, when available) test rejects at α. Requiring both the
  // interval and the test agree keeps a borderline p from flipping the verdict
  // on a CI that still straddles zero.
  const testP = wildCluster?.pValue ?? pValue;
  const ci = wildCluster ?? bootstrap;
  const ciExcludesZero = ci.ciLow > 0 || ci.ciHigh < 0;
  if (testP < alpha && ciExcludesZero) {
    return meanDelta >= 0 ? 'improvement' : 'regression';
  }
  return 'no-significant-change';
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Linear-interpolated quantile of an already-ascending array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const position = clamped * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** mulberry32 — small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two-sided p-value for Student's t with `df` degrees of freedom, via the
 * regularized incomplete beta identity p = I_{df/(df+t²)}(df/2, 1/2).
 */
export function studentTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  return clamp01(regularizedIncompleteBeta(x, df / 2, 0.5));
}

/**
 * Two-sided critical t-value for `df` degrees of freedom at level `alpha`: the
 * positive t* solving `studentTwoSidedP(t*, df) = alpha`. Found by bisection on
 * the monotone-decreasing tail; deterministic and dependency-free.
 */
export function studentTwoSidedCritical(df: number, alpha: number): number {
  if (df <= 0 || alpha <= 0 || alpha >= 1) return Infinity;
  let lo = 0;
  let hi = 1e6;
  for (let iter = 0; iter < 200; iter += 1) {
    const mid = (lo + hi) / 2;
    if (studentTwoSidedP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lnBeta + a * Math.log(x) + b * Math.log(1 - x));
  // Use the continued fraction for the faster-converging tail and the symmetry
  // I_x(a,b) = 1 − I_{1−x}(b,a) for the other.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const maxIterations = 300;
  const epsilon = 3e-12;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;

    numerator = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

const LANCZOS_COEFFICIENTS = [
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const shifted = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    x += LANCZOS_COEFFICIENTS[i] / (shifted + i + 1);
  }
  const t = shifted + LANCZOS_COEFFICIENTS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

// ---------------------------------------------------------------------------
// Run-file loading
// ---------------------------------------------------------------------------

interface BeirRunFileShape {
  dataset?: { name?: unknown };
  per_query?: unknown;
}

/**
 * Load one or more BEIR run-report JSON files into a single per-query score
 * vector. Each file contributes its `per_query[].{queryId, ndcgAt10}` rows;
 * the file's `dataset.name` becomes the cluster label and is prefixed onto the
 * query id (`<dataset>:<queryId>`) so ids stay unique across concatenated
 * datasets — which is exactly the clustered structure the wild-cluster
 * bootstrap consumes.
 */
export async function loadRunScores(paths: readonly string[]): Promise<PerQueryScore[]> {
  const scores: PerQueryScore[] = [];
  for (const filePath of paths) {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as BeirRunFileShape;
    const datasetName = typeof parsed.dataset?.name === 'string' ? parsed.dataset.name : path.basename(filePath);
    if (!Array.isArray(parsed.per_query)) {
      throw new Error(`significance: ${filePath} has no per_query array (is it a BEIR run report?)`);
    }
    for (const row of parsed.per_query) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as { queryId?: unknown; ndcgAt10?: unknown };
      if (typeof record.queryId !== 'string' || typeof record.ndcgAt10 !== 'number') {
        throw new Error(`significance: ${filePath} per_query row missing queryId/ndcgAt10`);
      }
      scores.push({
        queryId: `${datasetName}:${record.queryId}`,
        ndcgAt10: record.ndcgAt10,
        cluster: datasetName,
      });
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderComparisonMarkdown(
  result: ComparisonResult,
  options: { baselineLabel: string; currentLabel: string; alpha: number; dropped: number },
): string {
  const lines = [
    '## Retrieval significance comparison',
    '',
    `Current: \`${options.currentLabel}\``,
    `Baseline: \`${options.baselineLabel}\``,
    `Paired queries: ${result.n}${options.dropped > 0 ? ` (${options.dropped} unpaired id(s) dropped)` : ''}`,
    `Clusters (datasets): ${result.clusters}`,
    `Verdict: **${result.verdict.toUpperCase()}** at α=${options.alpha}`,
    '',
    '| Statistic | Value |',
    '| --- | ---: |',
    `| Mean ΔnDCG@10 | ${signed(result.meanDelta)} |`,
    `| Paired t | ${result.tStatistic.toFixed(4)} (df=${result.degreesOfFreedom}) |`,
    `| Paired t-test p | ${formatP(result.pValue)} |`,
    `| Bootstrap ${(100 * (1 - options.alpha)).toFixed(0)}% CI (${result.bootstrap.resamples} resamples) | [${signed(result.bootstrap.ciLow)}, ${signed(result.bootstrap.ciHigh)}] |`,
  ];
  if (result.wildCluster !== undefined) {
    const wc = result.wildCluster;
    lines.push(
      `| Wild-cluster bootstrap-t p | ${formatP(wc.pValue)} (${wc.clusters} clusters) |`,
      `| Wild-cluster ${(100 * (1 - options.alpha)).toFixed(0)}% CI | [${signed(wc.ciLow)}, ${signed(wc.ciHigh)}] |`,
    );
  }
  lines.push('', 'A non-significant dip is reported, not failed (RFC 020 §3/§4).');
  return `${lines.join('\n')}\n`;
}

export function renderFamilyMarkdown(family: FamilyResult): string {
  const lines = [
    '## Retrieval significance comparison (family)',
    '',
    `Correction: ${family.method} across ${family.comparisons.length} comparison(s) at α=${family.alpha}`,
    '',
    '| Comparison | n | Mean Δ | raw p | adj p | Verdict |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const comparison of family.comparisons) {
    const rawP = comparison.wildCluster?.pValue ?? comparison.pValue;
    lines.push([
      comparison.label,
      String(comparison.n),
      signed(comparison.meanDelta),
      formatP(rawP),
      formatP(comparison.adjustedPValue),
      comparison.correctedVerdict.toUpperCase(),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('', 'Non-significant rows are reported, not failed (RFC 020 §3/§4).');
  return `${lines.join('\n')}\n`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function formatP(value: number): string {
  if (value < 1e-4 && value > 0) return '<0.0001';
  return value.toFixed(4);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  baselinePaths: string[];
  currentPaths: string[];
  familyPath?: string;
  label: string;
  alpha: number;
  resamples: number;
  seed: number;
  method: CorrectionMethod;
  clusterByDataset: boolean;
  enforceFailures: boolean;
  summaryPath?: string;
  repoRoot: string;
}

interface FamilyManifestEntry {
  label: string;
  baseline: string | string[];
  current: string | string[];
  clusterByDataset?: boolean;
}

export function parseSignificanceArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const options: CliOptions = {
    baselinePaths: [],
    currentPaths: [],
    label: 'comparison',
    alpha: DEFAULT_ALPHA,
    resamples: DEFAULT_BOOTSTRAP_RESAMPLES,
    seed: DEFAULT_BOOTSTRAP_SEED,
    method: 'holm',
    clusterByDataset: false,
    enforceFailures: parseBool(env.BENCH_SIGNIFICANCE_FAIL),
    summaryPath: env.GITHUB_STEP_SUMMARY,
    repoRoot: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === '--baseline') {
      options.baselinePaths = splitPaths(readValue());
    } else if (flag === '--current') {
      options.currentPaths = splitPaths(readValue());
    } else if (flag === '--family') {
      options.familyPath = path.resolve(readValue());
    } else if (flag === '--label') {
      options.label = readValue();
    } else if (flag === '--alpha') {
      options.alpha = parseUnitInterval(readValue(), '--alpha');
    } else if (flag === '--bootstrap') {
      options.resamples = parsePositiveInt(readValue(), '--bootstrap');
    } else if (flag === '--seed') {
      options.seed = parsePositiveInt(readValue(), '--seed');
    } else if (flag === '--correction') {
      options.method = parseCorrection(readValue());
    } else if (flag === '--cluster-by-dataset') {
      options.clusterByDataset = true;
    } else if (flag === '--fail-on-regression') {
      options.enforceFailures = true;
    } else if (flag === '--summary') {
      options.summaryPath = path.resolve(readValue());
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(significanceHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function splitPaths(raw: string): string[] {
  return raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

async function runCli(): Promise<void> {
  const options = parseSignificanceArgs(process.argv.slice(2), process.env);
  const markdown = options.familyPath !== undefined
    ? await runFamilyCli(options)
    : await runSingleCli(options);

  process.stdout.write(markdown.text);
  if (options.summaryPath !== undefined) {
    await fsp.appendFile(options.summaryPath, markdown.text, 'utf-8');
  }
  if (options.enforceFailures && markdown.hasRegression) {
    process.exitCode = 1;
  }
}

async function runSingleCli(options: CliOptions): Promise<{ text: string; hasRegression: boolean }> {
  if (options.baselinePaths.length === 0 || options.currentPaths.length === 0) {
    throw new Error('significance: --baseline and --current are required (or use --family)');
  }
  const baseline = await loadRunScores(options.baselinePaths);
  const current = await loadRunScores(options.currentPaths);
  const { samples, dropped } = pairScores(baseline, current);
  const clusterByDataset = options.clusterByDataset
    || new Set(samples.map((s) => s.cluster)).size > 1;
  const result = compareSamples(samples, {
    label: options.label,
    alpha: options.alpha,
    resamples: options.resamples,
    seed: options.seed,
    clusterByDataset,
  });
  const text = renderComparisonMarkdown(result, {
    baselineLabel: options.baselinePaths.map((p) => path.relative(options.repoRoot, p)).join(', '),
    currentLabel: options.currentPaths.map((p) => path.relative(options.repoRoot, p)).join(', '),
    alpha: options.alpha,
    dropped: dropped.length,
  });
  return { text, hasRegression: result.verdict === 'regression' };
}

async function runFamilyCli(options: CliOptions): Promise<{ text: string; hasRegression: boolean }> {
  const raw = await fsp.readFile(options.familyPath as string, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('significance: --family manifest must be a JSON array of {label, baseline, current}');
  }
  const manifestDir = path.dirname(options.familyPath as string);
  const comparisons: ComparisonResult[] = [];
  for (const entry of parsed as FamilyManifestEntry[]) {
    const baselinePaths = toPathList(entry.baseline).map((p) => path.resolve(manifestDir, p));
    const currentPaths = toPathList(entry.current).map((p) => path.resolve(manifestDir, p));
    const baseline = await loadRunScores(baselinePaths);
    const current = await loadRunScores(currentPaths);
    const { samples } = pairScores(baseline, current);
    const clusterByDataset = (entry.clusterByDataset ?? options.clusterByDataset)
      || new Set(samples.map((s) => s.cluster)).size > 1;
    comparisons.push(compareSamples(samples, {
      label: entry.label,
      alpha: options.alpha,
      resamples: options.resamples,
      seed: options.seed,
      clusterByDataset,
    }));
  }
  const family = compareFamily(comparisons, options.method, options.alpha);
  return {
    text: renderFamilyMarkdown(family),
    hasRegression: family.comparisons.some((c) => c.correctedVerdict === 'regression'),
  };
}

function toPathList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseUnitInterval(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error(`${flag} must be in (0, 1)`);
  return parsed;
}

function parseCorrection(raw: string): CorrectionMethod {
  if (raw === 'bonferroni' || raw === 'holm' || raw === 'none') return raw;
  throw new Error('--correction must be one of: bonferroni, holm, none');
}

function significanceHelpText(): string {
  return `kb retrieval significance comparator (RFC 020 §3)

Usage:
  npm run bench:beir:significance -- --baseline a.json --current b.json
  npm run bench:beir:significance -- \\
      --baseline scifact-hybrid.json,nfcorpus-hybrid.json \\
      --current scifact-hybrid+rerank.json,nfcorpus-hybrid+rerank.json \\
      --cluster-by-dataset
  npm run bench:beir:significance -- --family stage-contributions.json --correction holm

Inputs are BEIR run-report JSON files (the per_query[].ndcgAt10 vectors).
Comma-separate multiple dataset files to compare a multi-domain run; each
file's dataset.name becomes a cluster for the wild-cluster bootstrap.

Options:
  --baseline=<a.json[,b.json]>  Baseline run file(s).
  --current=<a.json[,b.json]>   Current run file(s) (same query set).
  --family=<manifest.json>      JSON array of {label, baseline, current,
                                clusterByDataset?} for a corrected family sweep.
  --label=<name>                Label for the single-comparison report.
  --alpha=<p>                   Significance level. Default: 0.05.
  --bootstrap=<n>               Bootstrap resamples. Default: 10000.
  --seed=<n>                    Deterministic bootstrap seed.
  --correction=<m>              bonferroni | holm | none (family). Default: holm.
  --cluster-by-dataset          Force the wild-cluster bootstrap-t leg.
  --fail-on-regression          Exit 1 on a significant regression verdict.
  --summary=<path>              Append markdown to this file (CI step summary).
`;
}

function isDirectRun(argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false;
  return path.basename(argvPath) === 'significance.js';
}

if (isDirectRun(process.argv[1])) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
