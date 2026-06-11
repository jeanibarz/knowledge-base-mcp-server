// RFC 020 §5 — Tier 3: multi-judge panel with unsupervised calibration.
//
// "Only the genuinely subjective residue reaches an LLM judge, and never a
// single one… Use a panel of ≥3 distinct model families, aggregate by
// majority/mean, and derive a confidence signal from self-consistency — K
// independent samples per item, agreement fraction as confidence. Calibration
// is unsupervised… Per-judge prompts still apply double-query A/B–B/A ordering
// and an independent multi-dimensional rubric. Low-confidence items are
// reported as abstentions, not silently scored."
//
// The judges are injected behind the `Judge` interface so the orchestration is
// unit-testable with deterministic stubs — no live model in the loop for the
// tests. A real run wires ≥3 distinct provider families (judges.ts); the panel
// code is identical either way. Per-judge bias coefficients measured by Tier 4
// (bias-probes.ts) are subtracted here before aggregation, and judges flagged
// as over-biased are dropped from the panel.

import { fitConfidenceCalibrator, type CalibrationMethod, type ConfidenceCalibrator } from './calibration.js';
import {
  RUBRIC_DIMENSIONS,
  rubricOverall,
  roundUnit,
  type RubricDimension,
  type RubricScores,
} from './types.js';

export type JudgeOrder = 'AB' | 'BA';

export interface JudgeGradeInput {
  question: string;
  /** The system answer under evaluation. */
  candidate: string;
  /** The gold/reference answer it is graded against. */
  reference: string;
  contexts: string[];
  /** AB → candidate shown first; BA → reference shown first (position probe). */
  order: JudgeOrder;
  /** Self-consistency sample index (≥0); real judges vary by temperature. */
  sample: number;
}

export interface JudgeRawVerdict {
  /** Per-dimension scores for the CANDIDATE answer, each in [0, 1]. */
  dimensions: RubricScores;
  /** Whether the judge preferred the candidate over the reference. */
  preferredCandidate: boolean;
}

export interface Judge {
  name: string;
  /** Provider/model family — the panel asserts ≥3 DISTINCT families. */
  family: string;
  grade(input: JudgeGradeInput): Promise<JudgeRawVerdict>;
}

export interface PanelOptions {
  /** Self-consistency samples per (judge × order). Default 5. */
  samples?: number;
  /** Overall score at/above which the candidate "passes". Default 0.5. */
  passThreshold?: number;
  /** Per-judge bias coefficient subtracted from overall scores (Tier 4). */
  biasCoefficients?: ReadonlyMap<string, number>;
  /** Judge names dropped from aggregation for excess measured bias (Tier 4). */
  droppedJudges?: ReadonlySet<string>;
}

export interface PerJudgeAggregate {
  judge: string;
  family: string;
  /** Mean per-dimension score across all order × sample grades. */
  meanDimensions: RubricScores;
  /** rubricOverall of the mean dimensions, before bias subtraction. */
  rawOverall: number;
  /** rawOverall minus the judge's measured bias coefficient, clamped. */
  adjustedOverall: number;
  /** A↔B preference flip-rate across the K paired samples (position signal). */
  positionFlipRate: number;
  /** Self-consistency agreement on the pass/fail call across all samples. */
  selfConsistencyAgreement: number;
  dropped: boolean;
}

export interface PanelItemRaw {
  id: string;
  perJudge: PerJudgeAggregate[];
  /** Mean adjustedOverall across non-dropped judges. */
  panelMeanOverall: number;
  /** Majority vote: do > half of non-dropped judges pass the candidate? */
  panelMajorityPass: boolean;
  /** Mean self-consistency agreement across non-dropped judges (raw signal). */
  selfConsistencyAgreement: number;
  /** Single-pass feature fed to the calibrator (panelMeanOverall). */
  feature: number;
  /** Number of non-dropped judges that contributed. */
  contributingJudges: number;
}

export const DEFAULT_PANEL_SAMPLES = 5;
export const DEFAULT_PASS_THRESHOLD = 0.5;

/**
 * Grade one item with the full panel: every judge, both orderings, K samples.
 * Returns the raw per-judge and panel aggregates (no calibration/abstention yet
 * — that needs the whole item set, see {@link calibratePanel}).
 */
export async function gradePanelItem(
  item: { id: string; question: string; candidate: string; reference: string; contexts: string[] },
  judges: readonly Judge[],
  options: PanelOptions = {},
): Promise<PanelItemRaw> {
  const samples = options.samples ?? DEFAULT_PANEL_SAMPLES;
  const passThreshold = options.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const biasCoefficients = options.biasCoefficients ?? new Map<string, number>();
  const droppedJudges = options.droppedJudges ?? new Set<string>();

  const perJudge: PerJudgeAggregate[] = [];
  for (const judge of judges) {
    const dimensionSums: Record<RubricDimension, number> = blankDimensions();
    const overallSamples: number[] = [];
    let count = 0;
    let positionFlips = 0;
    let gradedSamples = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      // A single malformed/empty judge reply (e.g. a local model returning no
      // `choices[0].message.content`, or a transient provider blip) must not
      // crash the whole panel — skip that sample for this judge. A judge with
      // zero usable samples is dropped below (it abstains; never a fabricated
      // score).
      let ab;
      let ba;
      try {
        ab = await judge.grade({ ...item, order: 'AB', sample });
        ba = await judge.grade({ ...item, order: 'BA', sample });
      } catch {
        continue;
      }
      gradedSamples += 1;
      for (const verdict of [ab, ba]) {
        for (const dimension of RUBRIC_DIMENSIONS) dimensionSums[dimension] += verdict.dimensions[dimension];
        overallSamples.push(rubricOverall(verdict.dimensions));
        count += 1;
      }
      if (ab.preferredCandidate !== ba.preferredCandidate) positionFlips += 1;
    }
    const meanDimensions = meanDimensionRecord(dimensionSums, count);
    const rawOverall = rubricOverall(meanDimensions);
    const bias = biasCoefficients.get(judge.name) ?? 0;
    const adjustedOverall = roundUnit(rawOverall - bias);
    perJudge.push({
      judge: judge.name,
      family: judge.family,
      meanDimensions,
      rawOverall,
      adjustedOverall,
      positionFlipRate: roundUnit(gradedSamples === 0 ? 0 : positionFlips / gradedSamples),
      selfConsistencyAgreement: agreementFraction(overallSamples, passThreshold),
      // A judge that produced no usable grade contributes nothing (abstains),
      // in addition to any externally-dropped judges.
      dropped: droppedJudges.has(judge.name) || count === 0,
    });
  }

  const contributing = perJudge.filter((j) => !j.dropped);
  const panelMeanOverall = contributing.length === 0
    ? 0
    : roundUnit(mean(contributing.map((j) => j.adjustedOverall)));
  const passVotes = contributing.filter((j) => j.adjustedOverall >= passThreshold).length;
  const panelMajorityPass = contributing.length > 0 && passVotes * 2 > contributing.length;
  const selfConsistencyAgreement = contributing.length === 0
    ? 0
    : roundUnit(mean(contributing.map((j) => j.selfConsistencyAgreement)));

  return {
    id: item.id,
    perJudge,
    panelMeanOverall,
    panelMajorityPass,
    selfConsistencyAgreement,
    feature: panelMeanOverall,
    contributingJudges: contributing.length,
  };
}

export interface PanelItemResult extends PanelItemRaw {
  /** Calibrated confidence from the single-pass feature (unsupervised). */
  calibratedConfidence: number;
  /** True when calibrated confidence < the abstention threshold. */
  abstained: boolean;
}

export interface CalibratePanelOptions {
  method?: CalibrationMethod;
  /** Calibrated-confidence floor below which an item abstains. Default 0.5. */
  abstentionThreshold?: number;
  lambda?: number;
}

export interface PanelSummary {
  items: number;
  /** Items the panel scored (did not abstain). */
  scored: number;
  abstained: number;
  abstentionRate: number;
  /** Pass-rate over the scored (non-abstained) items. */
  passRate: number | null;
  meanRawSelfConsistency: number;
  meanCalibratedConfidence: number;
  calibration: { method: CalibrationMethod; fittedOn: number };
}

export interface CalibratedPanel {
  items: PanelItemResult[];
  summary: PanelSummary;
  calibrator: ConfidenceCalibrator;
}

export const DEFAULT_ABSTENTION_THRESHOLD = 0.5;

/**
 * Fit the unsupervised confidence calibrator across the graded items — feature
 * = single-pass panel mean, target = the K-sample self-consistency agreement —
 * then apply it to every item to produce a calibrated confidence and the
 * abstention decision. The calibration target is the panel's OWN
 * self-consistency, never a human label (§5).
 */
export function calibratePanel(
  rawItems: readonly PanelItemRaw[],
  options: CalibratePanelOptions = {},
): CalibratedPanel {
  const method = options.method ?? 'isotonic';
  const abstentionThreshold = options.abstentionThreshold ?? DEFAULT_ABSTENTION_THRESHOLD;
  const calibrator = fitConfidenceCalibrator(
    rawItems.map((item) => ({ feature: item.feature, target: item.selfConsistencyAgreement })),
    method,
    { ...(options.lambda !== undefined ? { lambda: options.lambda } : {}) },
  );

  const items: PanelItemResult[] = rawItems.map((item) => {
    const calibratedConfidence = roundUnit(calibrator.predict(item.feature));
    return { ...item, calibratedConfidence, abstained: calibratedConfidence < abstentionThreshold };
  });

  const scored = items.filter((item) => !item.abstained);
  const abstained = items.length - scored.length;
  const passRate = scored.length === 0
    ? null
    : roundUnit(scored.filter((item) => item.panelMajorityPass).length / scored.length);

  return {
    items,
    calibrator,
    summary: {
      items: items.length,
      scored: scored.length,
      abstained,
      abstentionRate: items.length === 0 ? 0 : roundUnit(abstained / items.length),
      passRate,
      meanRawSelfConsistency: items.length === 0
        ? 0
        : roundUnit(mean(items.map((item) => item.selfConsistencyAgreement))),
      meanCalibratedConfidence: items.length === 0
        ? 0
        : roundUnit(mean(items.map((item) => item.calibratedConfidence))),
      calibration: { method: calibrator.method, fittedOn: calibrator.fittedOn },
    },
  };
}

/** Distinct judge families in the panel — the RFC requires ≥3. */
export function distinctFamilies(judges: readonly Judge[]): string[] {
  return [...new Set(judges.map((judge) => judge.family))];
}

/**
 * Assert the panel has at least `minFamilies` (default 3) DISTINCT model
 * families — the RFC's bias-cancellation precondition. Throws otherwise so a
 * misconfigured single-family "panel" fails loudly rather than reporting a
 * falsely-confident number.
 */
export function assertPanelFamilies(judges: readonly Judge[], minFamilies = 3): void {
  const families = distinctFamilies(judges);
  if (families.length < minFamilies) {
    throw new Error(
      `rag-eval panel needs ≥${minFamilies} distinct judge families for bias cancellation (RFC 020 §5), ` +
        `got ${families.length}: [${families.join(', ')}]`,
    );
  }
}

function blankDimensions(): Record<RubricDimension, number> {
  const out = {} as Record<RubricDimension, number>;
  for (const dimension of RUBRIC_DIMENSIONS) out[dimension] = 0;
  return out;
}

function meanDimensionRecord(sums: Record<RubricDimension, number>, count: number): RubricScores {
  const out = {} as RubricScores;
  for (const dimension of RUBRIC_DIMENSIONS) {
    out[dimension] = roundUnit(count === 0 ? 0 : sums[dimension] / count);
  }
  return out;
}

/** Self-consistency = how often the samples agree on the pass/fail call. */
function agreementFraction(overalls: readonly number[], passThreshold: number): number {
  if (overalls.length === 0) return 0;
  const passes = overalls.filter((value) => value >= passThreshold).length;
  const pPass = passes / overalls.length;
  return roundUnit(Math.max(pPass, 1 - pPass));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
