// RFC 020 §5 — Tier 3 calibration leg: unsupervised confidence distillation.
//
// "Calibration is unsupervised, not human: run offline self-consistency
// sampling on the unlabeled eval set and distill a single-pass calibrated
// confidence predictor (ridge/isotonic), exactly the label-free recipe in
// [KB: llm-reasoning/2604.19444]."
//
// The recipe: pay K self-consistency samples per item OFFLINE on the unlabeled
// set, take the agreement fraction as the calibration target, and fit a
// predictor that maps a CHEAP single-pass feature (available without re-sampling
// at inference time) onto that agreement. No human label ever enters — the
// target is the model's own self-consistency. Two fitters are provided:
//
//   - isotonic (PAV): a monotone non-decreasing step function, the right choice
//     when the single-pass feature is itself a confidence-like quantity and we
//     only need to correct its calibration, not its rank order.
//   - ridge: L2-regularized linear regression, for when the feature is a raw
//     score that needs an affine re-mapping (and generalizes to >1 feature).
//
// Both are pure, deterministic, dependency-free closed-form/PAV fits.

export type CalibrationMethod = 'isotonic' | 'ridge';

/** One offline calibration observation: a single-pass feature and its label. */
export interface CalibrationSample {
  /** Cheap single-pass signal available at inference (e.g. panel mean score). */
  feature: number;
  /** Expensive self-consistency agreement fraction (the unsupervised target). */
  target: number;
}

export interface ConfidenceCalibrator {
  method: CalibrationMethod;
  /** Number of offline samples the fit consumed. */
  fittedOn: number;
  predict(feature: number): number;
}

export interface CalibrationOptions {
  /** Ridge L2 penalty. Ignored by isotonic. */
  lambda?: number;
}

export const DEFAULT_RIDGE_LAMBDA = 1e-3;

/**
 * Fit a calibrator from offline self-consistency samples. With fewer than two
 * samples there is nothing to fit, so the predictor is the identity clamped to
 * [0, 1] (an honest "we could not calibrate" fallback, never a fabricated
 * curve).
 */
export function fitConfidenceCalibrator(
  samples: readonly CalibrationSample[],
  method: CalibrationMethod = 'isotonic',
  options: CalibrationOptions = {},
): ConfidenceCalibrator {
  if (samples.length < 2) {
    return { method, fittedOn: samples.length, predict: (feature) => clamp01(feature) };
  }
  return method === 'ridge'
    ? fitRidge(samples, options.lambda ?? DEFAULT_RIDGE_LAMBDA)
    : fitIsotonic(samples);
}

/**
 * Pool-Adjacent-Violators isotonic regression: sort by feature, then merge
 * adjacent blocks that violate monotonicity into weighted-mean pools until the
 * fitted values are non-decreasing. `predict` interpolates linearly between
 * block knots and clamps outside the fitted feature range.
 */
export function fitIsotonic(samples: readonly CalibrationSample[]): ConfidenceCalibrator {
  const sorted = [...samples].sort((a, b) => a.feature - b.feature);
  interface Block { x: number; y: number; weight: number; }
  const blocks: Block[] = [];
  for (const sample of sorted) {
    let block: Block = { x: sample.feature, y: sample.target, weight: 1 };
    while (blocks.length > 0 && blocks[blocks.length - 1].y > block.y) {
      const prev = blocks.pop() as Block;
      const weight = prev.weight + block.weight;
      block = {
        x: prev.x,
        y: (prev.y * prev.weight + block.y * block.weight) / weight,
        weight,
      };
    }
    blocks.push(block);
  }
  // Knot x is the max feature in each block so the step function is right-edged.
  const knots = buildKnots(sorted, blocks);
  return {
    method: 'isotonic',
    fittedOn: samples.length,
    predict: (feature) => clamp01(interpolate(knots, feature)),
  };
}

interface Knot { x: number; y: number; }

function buildKnots(sorted: readonly CalibrationSample[], blocks: ReadonlyArray<{ y: number; weight: number }>): Knot[] {
  const knots: Knot[] = [];
  let index = 0;
  for (const block of blocks) {
    index += block.weight;
    const lastFeature = sorted[Math.min(index, sorted.length) - 1].feature;
    knots.push({ x: lastFeature, y: block.y });
  }
  return knots;
}

function interpolate(knots: readonly Knot[], feature: number): number {
  if (knots.length === 0) return clamp01(feature);
  if (feature <= knots[0].x) return knots[0].y;
  if (feature >= knots[knots.length - 1].x) return knots[knots.length - 1].y;
  for (let i = 1; i < knots.length; i += 1) {
    const left = knots[i - 1];
    const right = knots[i];
    if (feature <= right.x) {
      const span = right.x - left.x;
      if (span === 0) return right.y;
      const t = (feature - left.x) / span;
      return left.y + t * (right.y - left.y);
    }
  }
  return knots[knots.length - 1].y;
}

/**
 * Ridge regression on a single feature: closed-form fit of y = a·x + b with an
 * L2 penalty `lambda` on the slope (the intercept is unpenalized, the standard
 * convention). Reduces variance when the offline sample is small/noisy.
 */
export function fitRidge(samples: readonly CalibrationSample[], lambda: number): ConfidenceCalibrator {
  const n = samples.length;
  let meanX = 0;
  let meanY = 0;
  for (const s of samples) {
    meanX += s.feature;
    meanY += s.target;
  }
  meanX /= n;
  meanY /= n;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    const dx = s.feature - meanX;
    sxx += dx * dx;
    sxy += dx * (s.target - meanY);
  }
  const slope = sxx + lambda === 0 ? 0 : sxy / (sxx + lambda);
  const intercept = meanY - slope * meanX;
  return {
    method: 'ridge',
    fittedOn: n,
    predict: (feature) => clamp01(slope * feature + intercept),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(6));
}
