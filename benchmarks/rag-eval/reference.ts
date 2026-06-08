// RFC 020 §5 — Tier 1: deterministic reference metrics (no model in the loop).
//
// "Use QA datasets that ship gold answers and gold supporting facts: HotpotQA
// (gold supporting sentences), NQ/2WikiMultiHop (short gold answers). Compute
// exact-match + token-F1 against the gold answer, and context recall/precision
// against the gold supporting facts — fully mechanical, the most trustworthy
// signal we have."
//
// This tier is bedrock: it carries most items so the LLM panel (Tier 3) only
// adjudicates the genuinely-subjective residue. Everything here is pure and
// deterministic — the normalization is the standard SQuAD scheme (lowercase,
// strip articles + punctuation, collapse whitespace) so a string-equal answer
// scores EM=1 regardless of casing/punctuation. Context recall/precision are a
// token-F1 overlap match between retrieved chunks and the gold supporting
// sentences, since chunk boundaries never line up with sentence spans exactly.

import type { GoldQaItem, RagAnswer, RetrievedContext } from './types.js';

/** Default token-F1 overlap above which a chunk is said to "cover" a fact. */
export const DEFAULT_CONTEXT_MATCH_THRESHOLD = 0.5;

export interface ReferenceScore {
  id: string;
  dataset: string;
  /** 1 when the normalized prediction equals a normalized gold answer, else 0. */
  exactMatch: number;
  /** Best token-F1 of the prediction against any gold answer. */
  tokenF1: number;
  /** Fraction of gold supporting facts covered by some retrieved chunk. */
  contextRecall: number | null;
  /** Fraction of retrieved chunks that cover some gold supporting fact. */
  contextPrecision: number | null;
  hasGoldAnswer: boolean;
  hasGoldFacts: boolean;
}

export interface ReferenceOptions {
  /** Token-F1 threshold for a chunk↔fact overlap match. */
  contextMatchThreshold?: number;
}

const ARTICLES = new Set(['a', 'an', 'the']);

/** SQuAD-style answer normalization: lowercase, drop punctuation + articles. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !ARTICLES.has(token))
    .join(' ');
}

/** Whitespace tokens of a normalized string (articles already stripped). */
export function normalizedTokens(text: string): string[] {
  const normalized = normalizeAnswer(text);
  return normalized === '' ? [] : normalized.split(' ');
}

/** Exact-match against the best of several gold answers (1 or 0). */
export function exactMatch(prediction: string, golds: readonly string[]): number {
  const predicted = normalizeAnswer(prediction);
  for (const gold of golds) {
    if (normalizeAnswer(gold) === predicted) return 1;
  }
  return 0;
}

/**
 * Token-level F1 between two strings: the harmonic mean of the precision and
 * recall of the shared multiset of tokens — the standard SQuAD/HotpotQA F1.
 */
export function tokenF1Pair(prediction: string, gold: string): number {
  const predTokens = normalizedTokens(prediction);
  const goldTokens = normalizedTokens(gold);
  if (predTokens.length === 0 || goldTokens.length === 0) {
    // Both empty → perfect agreement; one empty → no overlap possible.
    return predTokens.length === goldTokens.length ? 1 : 0;
  }
  const goldCounts = new Map<string, number>();
  for (const token of goldTokens) goldCounts.set(token, (goldCounts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of predTokens) {
    const remaining = goldCounts.get(token);
    if (remaining !== undefined && remaining > 0) {
      shared += 1;
      goldCounts.set(token, remaining - 1);
    }
  }
  if (shared === 0) return 0;
  const precision = shared / predTokens.length;
  const recall = shared / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Best token-F1 of the prediction over a set of gold answers. */
export function tokenF1(prediction: string, golds: readonly string[]): number {
  let best = 0;
  for (const gold of golds) best = Math.max(best, tokenF1Pair(prediction, gold));
  return round(best);
}

/**
 * Context recall — fraction of gold supporting facts that are "covered" by at
 * least one retrieved chunk (token-F1 overlap ≥ threshold). Null when the item
 * carries no gold supporting facts (NQ short-answer items, where Tier 1 still
 * scores the answer but cannot score retrieval against spans it lacks).
 */
export function contextRecall(
  contexts: readonly RetrievedContext[],
  goldFacts: readonly string[],
  threshold = DEFAULT_CONTEXT_MATCH_THRESHOLD,
): number | null {
  if (goldFacts.length === 0) return null;
  let covered = 0;
  for (const fact of goldFacts) {
    if (contexts.some((ctx) => tokenF1Pair(ctx.text, fact) >= threshold)) covered += 1;
  }
  return round(covered / goldFacts.length);
}

/**
 * Context precision — fraction of retrieved chunks that cover some gold
 * supporting fact. This is the metric the RFC calls out as required, not
 * optional: an oversized chunk can keep recall high while drowning the answer
 * in irrelevant context, and precision is what exposes that chunking
 * regression. Null when there are no gold facts or no retrieved chunks.
 */
export function contextPrecision(
  contexts: readonly RetrievedContext[],
  goldFacts: readonly string[],
  threshold = DEFAULT_CONTEXT_MATCH_THRESHOLD,
): number | null {
  if (goldFacts.length === 0 || contexts.length === 0) return null;
  let relevant = 0;
  for (const ctx of contexts) {
    if (goldFacts.some((fact) => tokenF1Pair(ctx.text, fact) >= threshold)) relevant += 1;
  }
  return round(relevant / contexts.length);
}

/** Score one gold item against the system's answer — the full Tier 1 row. */
export function scoreReferenceItem(
  item: GoldQaItem,
  answer: RagAnswer,
  options: ReferenceOptions = {},
): ReferenceScore {
  const threshold = options.contextMatchThreshold ?? DEFAULT_CONTEXT_MATCH_THRESHOLD;
  const hasGoldAnswer = item.goldAnswers.length > 0;
  const hasGoldFacts = item.goldSupportingFacts.length > 0;
  return {
    id: item.id,
    dataset: item.dataset,
    exactMatch: hasGoldAnswer ? exactMatch(answer.answer, item.goldAnswers) : 0,
    tokenF1: hasGoldAnswer ? tokenF1(answer.answer, item.goldAnswers) : 0,
    contextRecall: contextRecall(answer.contexts, item.goldSupportingFacts, threshold),
    contextPrecision: contextPrecision(answer.contexts, item.goldSupportingFacts, threshold),
    hasGoldAnswer,
    hasGoldFacts,
  };
}

export interface ReferenceAggregate {
  items: number;
  exactMatch: number;
  tokenF1: number;
  /** Mean over items that carry gold supporting facts. */
  contextRecall: number | null;
  contextPrecision: number | null;
  itemsWithGoldFacts: number;
}

export function aggregateReferenceScores(scores: readonly ReferenceScore[]): ReferenceAggregate {
  const withAnswer = scores.filter((s) => s.hasGoldAnswer);
  const withFacts = scores.filter((s) => s.hasGoldFacts);
  return {
    items: scores.length,
    exactMatch: meanOrZero(withAnswer.map((s) => s.exactMatch)),
    tokenF1: meanOrZero(withAnswer.map((s) => s.tokenF1)),
    contextRecall: withFacts.length === 0
      ? null
      : meanOrZero(withFacts.map((s) => s.contextRecall ?? 0)),
    contextPrecision: withFacts.length === 0
      ? null
      : meanOrZero(withFacts.map((s) => s.contextPrecision ?? 0)),
    itemsWithGoldFacts: withFacts.length,
  };
}

function meanOrZero(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
