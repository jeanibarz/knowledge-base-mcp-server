// RFC 020 §5 — Tier 2: automated model metrics, no judge prompt.
//
// "For the residue Tier 1 can't score mechanically (long-form prose,
// paraphrase): an NLI/entailment model scores faithfulness by checking each
// answer claim is entailed by the retrieved context (a different model family
// than the judge, so it cross-checks rather than echoes), and semantic metrics
// (BERTScore/COMET) stand in for lexical overlap on open-ended text."
//
// The models are injected behind narrow interfaces so the tier is unit-testable
// with deterministic stubs (no NLI checkpoint, no network). A real run wires an
// actual NLI checkpoint and a BERTScore/COMET model; the stubs below derive a
// deterministic token-overlap proxy so the cascade, routing, and report can be
// exercised hermetically. The interfaces carry a `family` tag because the RFC
// requires the NLI model to be a DIFFERENT family than the Tier-3 judge — the
// cascade asserts that separation so the cross-check is real, not an echo.

import { normalizedTokens, tokenF1Pair } from './reference.js';
import { clampUnit, roundUnit } from './types.js';
import type { RetrievedContext } from './types.js';

export type EntailmentLabel = 'entailment' | 'neutral' | 'contradiction';

export interface EntailmentResult {
  label: EntailmentLabel;
  /** Probability mass on the entailment class, in [0, 1]. */
  score: number;
}

/** An NLI/entailment model: does `premise` entail `hypothesis`? */
export interface EntailmentModel {
  /** Model family tag (must differ from the Tier-3 judge families). */
  family: string;
  entail(premise: string, hypothesis: string): Promise<EntailmentResult>;
}

/** A semantic-similarity model (BERTScore/COMET stand-in), score in [0, 1]. */
export interface SemanticSimilarityModel {
  family: string;
  similarity(candidate: string, reference: string): Promise<number>;
}

export interface FaithfulnessOptions {
  /** Entailment score at/above which a claim counts as supported. */
  entailmentThreshold?: number;
}

export interface ClaimVerdict {
  claim: string;
  entailed: boolean;
  bestScore: number;
  label: EntailmentLabel;
}

export interface FaithfulnessResult {
  /** Fraction of answer claims entailed by some retrieved context. */
  faithfulness: number;
  claims: ClaimVerdict[];
}

export const DEFAULT_ENTAILMENT_THRESHOLD = 0.5;

/** Split an answer into claim-sized units (sentences) for claim-wise NLI. */
export function splitClaims(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((claim) => claim.trim())
    .filter((claim) => claim.length > 0);
}

/**
 * Faithfulness — each answer claim is checked against every retrieved context;
 * the claim is "entailed" if any context entails it at/above the threshold. The
 * score is the fraction of claims supported (no claim → vacuously faithful = 1,
 * the standard RAGAS convention for an empty/abstaining answer).
 */
export async function faithfulnessScore(
  answer: string,
  contexts: readonly RetrievedContext[],
  model: EntailmentModel,
  options: FaithfulnessOptions = {},
): Promise<FaithfulnessResult> {
  const threshold = options.entailmentThreshold ?? DEFAULT_ENTAILMENT_THRESHOLD;
  const claims = splitClaims(answer);
  if (claims.length === 0) {
    return { faithfulness: 1, claims: [] };
  }
  const verdicts: ClaimVerdict[] = [];
  for (const claim of claims) {
    let best: EntailmentResult = { label: 'neutral', score: 0 };
    for (const ctx of contexts) {
      const result = await model.entail(ctx.text, claim);
      if (result.score > best.score) best = result;
    }
    verdicts.push({
      claim,
      entailed: best.label === 'entailment' && best.score >= threshold,
      bestScore: roundUnit(best.score),
      label: best.label,
    });
  }
  const entailed = verdicts.filter((v) => v.entailed).length;
  return { faithfulness: roundUnit(entailed / verdicts.length), claims: verdicts };
}

/** Best semantic similarity of a prediction over a set of reference answers. */
export async function semanticScore(
  prediction: string,
  references: readonly string[],
  model: SemanticSimilarityModel,
): Promise<number> {
  if (references.length === 0) return 0;
  let best = 0;
  for (const reference of references) {
    best = Math.max(best, clampUnit(await model.similarity(prediction, reference)));
  }
  return roundUnit(best);
}

// ---------------------------------------------------------------------------
// Deterministic stubs — for hermetic unit tests and the `fake` cascade path.
// ---------------------------------------------------------------------------

/**
 * A deterministic NLI stub: entailment score is the token-F1 overlap of the
 * hypothesis against the premise, labelled `entailment` above the threshold and
 * `contradiction` only when an explicit negation token flips a high-overlap
 * claim. No network, no checkpoint — purely a function of the two strings, so a
 * test always gets the same verdict. NEVER a real quality signal.
 */
export function tokenOverlapEntailmentModel(
  family = 'stub-nli',
  threshold = DEFAULT_ENTAILMENT_THRESHOLD,
): EntailmentModel {
  return {
    family,
    async entail(premise: string, hypothesis: string): Promise<EntailmentResult> {
      const overlap = recallOverlap(hypothesis, premise);
      const negated = hasNegationMismatch(premise, hypothesis);
      if (negated && overlap >= threshold) {
        return { label: 'contradiction', score: clampUnit(1 - overlap) };
      }
      const label: EntailmentLabel = overlap >= threshold ? 'entailment' : 'neutral';
      return { label, score: clampUnit(overlap) };
    },
  };
}

/** A deterministic BERTScore/COMET stub: symmetric token-F1 similarity. */
export function tokenOverlapSimilarityModel(family = 'stub-semantic'): SemanticSimilarityModel {
  return {
    family,
    async similarity(candidate: string, reference: string): Promise<number> {
      return tokenF1Pair(candidate, reference);
    },
  };
}

/** Fraction of hypothesis tokens that appear in the premise (claim coverage). */
function recallOverlap(hypothesis: string, premise: string): number {
  const hypTokens = normalizedTokens(hypothesis);
  if (hypTokens.length === 0) return 1;
  const premiseSet = new Set(normalizedTokens(premise));
  let hits = 0;
  for (const token of hypTokens) if (premiseSet.has(token)) hits += 1;
  return hits / hypTokens.length;
}

const NEGATIONS = new Set(['not', 'no', 'never', 'cannot', "n't", 'none', 'without']);

function hasNegationMismatch(premise: string, hypothesis: string): boolean {
  const premiseNeg = normalizedTokens(premise).some((t) => NEGATIONS.has(t));
  const hypNeg = normalizedTokens(hypothesis).some((t) => NEGATIONS.has(t));
  return premiseNeg !== hypNeg;
}
