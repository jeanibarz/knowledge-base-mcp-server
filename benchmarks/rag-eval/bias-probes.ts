// RFC 020 §5 — Tier 4: automated bias quantification (substitute for human
// calibration).
//
// "Instead of validating the judge against humans, we measure its bias against
// constructed ground truth that needs no annotation: programmatic probes whose
// correct verdict is known by construction — position bias = A↔B swap flip-rate
// (target <10%), verbosity bias = pad a Tier-1-correct answer with filler and
// measure score drift, self-preference = judge-on-self vs judge-on-other on
// items with known gold answers. These yield per-judge bias coefficients
// automatically, which are subtracted from scores; a judge whose probe bias
// exceeds a threshold is dropped from the panel — no human in the loop."
//
// The probes drive the SAME injected `Judge` interface as the panel, so they
// run on stub judges in tests and live judges in a real eval. Each probe's
// correct answer is known by construction (a swap should not change a verdict;
// filler should not raise a score; a judge should not prefer its own family's
// answer when both are equally gold-correct), so the measured deviation IS the
// bias — no labels required.

import { rubricOverall, roundUnit } from './types.js';
import type { Judge } from './panel.js';

/** A probe item — a constructed case whose unbiased verdict is known. */
export interface ProbeItem {
  id: string;
  question: string;
  contexts: string[];
  /** A Tier-1-correct answer (gold), used as the candidate in the probes. */
  goldAnswer: string;
  /** An equally-correct answer attributed to ANOTHER family (self-preference). */
  otherFamilyAnswer?: string;
  /** Marks `goldAnswer` as authored by `selfFamily` (self-preference probe). */
  selfFamily?: string;
}

export interface BiasWeights {
  verbosity: number;
  selfPreference: number;
}

export interface BiasProbeOptions {
  /** Self-consistency samples per probe grade. Default 3. */
  samples?: number;
  /** Position flip-rate above which the judge is dropped. Default 0.10. */
  positionThreshold?: number;
  /** |bias coefficient| above which the judge is dropped. Default 0.15. */
  biasThreshold?: number;
  /** Filler appended to build the padded (verbosity) answer. */
  fillerText?: string;
  /** Weights combining the directional biases into one coefficient. */
  weights?: BiasWeights;
}

export interface JudgeBiasProfile {
  judge: string;
  family: string;
  /** A↔B swap flip-rate on gold items (target < positionThreshold). */
  positionBias: number;
  /** Mean score lift from padding a correct answer with filler (signed). */
  verbosityBias: number;
  /** Judge-on-self minus judge-on-other on equal-gold items (signed). */
  selfPreferenceBias: number;
  /** Combined coefficient subtracted from this judge's panel scores. */
  biasCoefficient: number;
  /** True when position or combined bias exceeds its threshold. */
  dropped: boolean;
  dropReason: string | null;
}

export const DEFAULT_POSITION_THRESHOLD = 0.10;
export const DEFAULT_BIAS_THRESHOLD = 0.15;
export const DEFAULT_PROBE_SAMPLES = 3;
export const DEFAULT_FILLER_TEXT =
  ' Furthermore, it is worth noting that this point, while perhaps obvious, ' +
  'merits additional emphasis and elaboration for the sake of completeness.';
export const DEFAULT_BIAS_WEIGHTS: BiasWeights = { verbosity: 0.5, selfPreference: 0.5 };

/** Probe one judge across all three bias dimensions and combine the result. */
export async function probeJudgeBias(
  judge: Judge,
  probes: readonly ProbeItem[],
  options: BiasProbeOptions = {},
): Promise<JudgeBiasProfile> {
  const samples = options.samples ?? DEFAULT_PROBE_SAMPLES;
  const filler = options.fillerText ?? DEFAULT_FILLER_TEXT;
  const weights = options.weights ?? DEFAULT_BIAS_WEIGHTS;
  const positionThreshold = options.positionThreshold ?? DEFAULT_POSITION_THRESHOLD;
  const biasThreshold = options.biasThreshold ?? DEFAULT_BIAS_THRESHOLD;

  const positionBias = await measurePositionBias(judge, probes, samples);
  const verbosityBias = await measureVerbosityBias(judge, probes, samples, filler);
  const selfPreferenceBias = await measureSelfPreferenceBias(judge, probes, samples);

  // Verbosity and self-preference are directional score distortions that we
  // subtract; position bias is a reliability signal that gates dropping, not a
  // score offset (a flip says the judge is order-sensitive, not that its score
  // is inflated by a known amount). Only positive (inflating) distortions are
  // subtracted — we never inflate a judge's score to "correct" a negative bias.
  const biasCoefficient = roundSigned(
    Math.max(0, weights.verbosity * verbosityBias) +
      Math.max(0, weights.selfPreference * selfPreferenceBias),
  );

  const overPosition = positionBias > positionThreshold;
  const overBias = Math.abs(biasCoefficient) > biasThreshold;
  const dropReason = overPosition
    ? `position flip-rate ${positionBias.toFixed(3)} > ${positionThreshold}`
    : overBias
      ? `bias coefficient ${biasCoefficient.toFixed(3)} exceeds ${biasThreshold}`
      : null;

  return {
    judge: judge.name,
    family: judge.family,
    positionBias,
    verbosityBias,
    selfPreferenceBias,
    biasCoefficient,
    dropped: overPosition || overBias,
    dropReason,
  };
}

/** Probe every judge; returns profiles plus the derived panel inputs. */
export async function probePanelBias(
  judges: readonly Judge[],
  probes: readonly ProbeItem[],
  options: BiasProbeOptions = {},
): Promise<{
  profiles: JudgeBiasProfile[];
  biasCoefficients: Map<string, number>;
  droppedJudges: Set<string>;
}> {
  const profiles: JudgeBiasProfile[] = [];
  for (const judge of judges) profiles.push(await probeJudgeBias(judge, probes, options));
  const biasCoefficients = new Map(profiles.map((p) => [p.judge, p.biasCoefficient]));
  const droppedJudges = new Set(profiles.filter((p) => p.dropped).map((p) => p.judge));
  return { profiles, biasCoefficients, droppedJudges };
}

/** Position: how often a candidate↔reference swap flips the preference. */
async function measurePositionBias(judge: Judge, probes: readonly ProbeItem[], samples: number): Promise<number> {
  let flips = 0;
  let pairs = 0;
  for (const probe of probes) {
    for (let sample = 0; sample < samples; sample += 1) {
      // A transient malformed judge reply must not crash bias measurement —
      // skip the sample (it just doesn't count toward the probe).
      let ab;
      let ba;
      try {
        ab = await judge.grade({
          question: probe.question,
          candidate: probe.goldAnswer,
          reference: probe.goldAnswer,
          contexts: probe.contexts,
          order: 'AB',
          sample,
        });
        ba = await judge.grade({
          question: probe.question,
          candidate: probe.goldAnswer,
          reference: probe.goldAnswer,
          contexts: probe.contexts,
          order: 'BA',
          sample,
        });
      } catch {
        continue;
      }
      if (ab.preferredCandidate !== ba.preferredCandidate) flips += 1;
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : roundSigned(flips / pairs);
}

/** Verbosity: score lift from padding a correct answer with empty filler. */
async function measureVerbosityBias(
  judge: Judge,
  probes: readonly ProbeItem[],
  samples: number,
  filler: string,
): Promise<number> {
  const drifts: number[] = [];
  for (const probe of probes) {
    for (let sample = 0; sample < samples; sample += 1) {
      try {
        const plain = await scoreCandidate(judge, probe, probe.goldAnswer, sample);
        const padded = await scoreCandidate(judge, probe, probe.goldAnswer + filler, sample);
        drifts.push(padded - plain);
      } catch {
        continue;
      }
    }
  }
  return meanSigned(drifts);
}

/** Self-preference: judge-on-self minus judge-on-other on equal-gold items. */
async function measureSelfPreferenceBias(judge: Judge, probes: readonly ProbeItem[], samples: number): Promise<number> {
  const gaps: number[] = [];
  for (const probe of probes) {
    if (probe.otherFamilyAnswer === undefined) continue;
    const judgingOwn = probe.selfFamily === judge.family;
    for (let sample = 0; sample < samples; sample += 1) {
      let selfScore;
      let otherScore;
      try {
        selfScore = await scoreCandidate(judge, probe, probe.goldAnswer, sample);
        otherScore = await scoreCandidate(judge, probe, probe.otherFamilyAnswer, sample);
      } catch {
        continue;
      }
      // The gap only counts as self-preference when the judge is grading an
      // answer attributed to its OWN family; otherwise the two answers are just
      // two equally-gold strings and any gap is noise, not self-preference.
      if (judgingOwn) gaps.push(selfScore - otherScore);
    }
  }
  return meanSigned(gaps);
}

async function scoreCandidate(judge: Judge, probe: ProbeItem, candidate: string, sample: number): Promise<number> {
  const verdict = await judge.grade({
    question: probe.question,
    candidate,
    reference: probe.goldAnswer,
    contexts: probe.contexts,
    order: 'AB',
    sample,
  });
  return rubricOverall(verdict.dimensions);
}

function meanSigned(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return roundSigned(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundSigned(value: number): number {
  return Number(value.toFixed(6));
}
