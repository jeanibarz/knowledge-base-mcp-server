// RFC 020 §5 (milestone M4) — shared types for the human-label-free
// end-to-end RAG eval cascade.
//
// The eval protects the `kb ask` product surface using NO human-annotated
// labels. Correctness signal comes from gold-bearing public QA datasets and
// automated cross-checks, structured as a four-tier, deterministic-first
// cascade (§5):
//
//   Tier 1 — deterministic reference metrics  (reference.ts)
//   Tier 2 — automated model metrics (NLI + semantic) (model-metrics.ts)
//   Tier 3 — multi-judge panel + unsupervised calibration (panel.ts)
//   Tier 4 — automated bias probes (bias-probes.ts)
//
// These shared shapes live in their own module so the tiers can depend on a
// common vocabulary without importing each other (and creating cycles).

/**
 * A gold-bearing QA item — the only ground truth the eval uses. It ships a
 * gold answer (NQ / 2WikiMultiHop short answers) and/or gold supporting facts
 * (HotpotQA / 2WikiMultiHop supporting sentences), so Tier 1 can score it with
 * no model in the loop.
 */
export interface GoldQaItem {
  id: string;
  /** Registry key of the source dataset (`hotpotqa`, `nq`, `2wikimultihop`). */
  dataset: string;
  question: string;
  /** Short gold answers; HotpotQA has one, NQ may have several aliases. */
  goldAnswers: string[];
  /** Gold supporting sentences for context recall/precision; may be empty. */
  goldSupportingFacts: string[];
  /**
   * `short` → a span answer Tier 1 can score mechanically (carries most of the
   * weight). `long` → free-form prose where EM/F1 are unreliable, so the item
   * is residue routed to Tier 2/3.
   */
  answerType: 'short' | 'long';
}

/** One retrieved chunk the system surfaced for an item. */
export interface RetrievedContext {
  id: string;
  text: string;
}

/** The system's answer for one item — the output of `kb ask` (or a fixture). */
export interface RagAnswer {
  /** Item id this answer belongs to (pairs the answer back to its GoldQaItem). */
  id: string;
  answer: string;
  contexts: RetrievedContext[];
}

/** The multi-dimensional rubric the Tier-3 judge panel scores against (§5). */
export type RubricDimension = 'faithfulness' | 'relevance' | 'completeness';

export const RUBRIC_DIMENSIONS: readonly RubricDimension[] = [
  'faithfulness',
  'relevance',
  'completeness',
];

/** A per-dimension score record over the full rubric, each in [0, 1]. */
export type RubricScores = Record<RubricDimension, number>;

/** Build a rubric record from a per-dimension producer, all keys present. */
export function rubricScores(produce: (dimension: RubricDimension) => number): RubricScores {
  const out = {} as RubricScores;
  for (const dimension of RUBRIC_DIMENSIONS) {
    out[dimension] = clampUnit(produce(dimension));
  }
  return out;
}

/** Mean of a rubric record's dimensions — the judge's `overall` score. */
export function rubricOverall(scores: RubricScores): number {
  let sum = 0;
  for (const dimension of RUBRIC_DIMENSIONS) sum += scores[dimension];
  return roundUnit(sum / RUBRIC_DIMENSIONS.length);
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function roundUnit(value: number): number {
  return Number(clampUnit(value).toFixed(6));
}
