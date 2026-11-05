// recommend-kb-core.ts
//
// Command-independent "which KB and which file should I use for this topic?"
// core behind both the `kb where` CLI adapter (`cli-where.ts`) and the
// read-only `recommend_knowledge_base` MCP tool (`KnowledgeBaseServer.ts`,
// issue #1152). Per the repo's non-CLI import boundary (issue #405 /
// `non-cli-import-boundary.test.ts`), the MCP server must NOT import a `cli-*`
// command adapter, so the reusable decision + serialization logic lives here
// and both surfaces import it.
//
// This module owns no I/O or process concerns (no argv parsing, no stdout, no
// exit codes): it reduces an already-computed list of cross-KB search results
// to a single recommendation and serializes it, leaving each caller to apply
// its own transport contract. `cli-where.ts` re-exports the symbols below so
// existing importers keep working.

import type { ScoredDocument } from './formatter.js';

/** The confidence cutoff shared by `kb where` and `recommend_knowledge_base`. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 1.0;
/** The default top-K considered when grouping cross-KB hits. */
export const DEFAULT_K = 20;

export interface WhereDecision {
  recommendedKb: string;
  existingTarget: string | null;
  confidence: number;
  suggestedInvocation: string;
}

/**
 * Reduces a flat list of cross-KB search results to a single recommendation.
 *
 * Returns `null` when `results` is empty or no result has a usable
 * `metadata.knowledgeBase` field (defensive — should not happen in practice
 * since FaissIndexManager always stamps it).
 *
 * Lower score = closer match (FAISS L2 distance). The "best" hit is the one
 * with the lowest score; the "best file" within that KB is the lowest-scoring
 * result whose `relativePath` is set.
 */
export function decideWhere(
  results: readonly ScoredDocument[],
  confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): WhereDecision | null {
  if (results.length === 0) return null;

  let bestKb: string | null = null;
  let bestKbScore = Number.POSITIVE_INFINITY;
  for (const r of results) {
    const kb = readKb(r);
    if (kb === null) continue;
    const score = r.score ?? Number.POSITIVE_INFINITY;
    if (score < bestKbScore) {
      bestKbScore = score;
      bestKb = kb;
    }
  }
  if (bestKb === null) return null;

  let bestFile: string | null = null;
  let bestFileScore = Number.POSITIVE_INFINITY;
  for (const r of results) {
    if (readKb(r) !== bestKb) continue;
    const rel = readRelativePath(r);
    if (rel === null) continue;
    const score = r.score ?? Number.POSITIVE_INFINITY;
    if (score < bestFileScore) {
      bestFileScore = score;
      bestFile = rel;
    }
  }

  const confident = bestFile !== null && bestFileScore < confidenceThreshold;
  return {
    recommendedKb: bestKb,
    existingTarget: confident ? bestFile : null,
    confidence: confident ? bestFileScore : bestKbScore,
    suggestedInvocation: confident
      ? buildAppendInvocation(bestKb, bestFile as string)
      : buildCreateInvocation(bestKb),
  };
}

function readKb(r: ScoredDocument): string | null {
  const v = (r.metadata as Record<string, unknown> | undefined)?.knowledgeBase;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readRelativePath(r: ScoredDocument): string | null {
  const v = (r.metadata as Record<string, unknown> | undefined)?.relativePath;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function buildAppendInvocation(kb: string, relPath: string): string {
  return (
    `kb remember --kb=${kb} \\\n` +
    `             --append=${relPath} \\\n` +
    `             --stdin --yes`
  );
}

function buildCreateInvocation(kb: string): string {
  return `kb remember --kb=${kb} --title=<title> --stdin --yes`;
}

/**
 * CLI `kb where --format=json` serializer. Includes the copy-pasteable
 * `kb remember` invocation, which is only useful at a terminal.
 */
export function toWhereJsonShape(d: WhereDecision): Record<string, unknown> {
  return {
    recommended_kb: d.recommendedKb,
    existing_target: d.existingTarget,
    confidence: d.confidence,
    suggested_invocation: d.suggestedInvocation,
  };
}

/** Stable wire-contract version for the `recommend_knowledge_base` MCP payload. */
export const RECOMMEND_SCHEMA_VERSION = 'kb.recommend.v1' as const;

/**
 * Structured `kb.recommend.v1` payload for the read-only
 * `recommend_knowledge_base` MCP tool (issue #1152). It mirrors the retained
 * fields of `kb where --format=json` — recommended shelf, best existing file,
 * and the numeric confidence score — and drops the CLI-only
 * `suggested_invocation` copy-paste so the MCP tool stays a pure
 * recommendation. `confident` makes the high/low confidence distinction the
 * CLI renders as a label an explicit boolean: it is true exactly when
 * `decideWhere` found an existing target inside the threshold (i.e.
 * `existing_target !== null`).
 */
export interface RecommendKbPayload {
  schema_version: typeof RECOMMEND_SCHEMA_VERSION;
  recommended_kb: string | null;
  existing_target: string | null;
  confidence: number | null;
  confident: boolean;
}

/**
 * Build the `kb.recommend.v1` payload from a `decideWhere` result. A `null`
 * decision (no similar notes, or no result carried a usable KB) serializes to
 * an all-null recommendation with `confident: false`, mirroring the CLI's
 * "no recommendation" branch without the CLI's `results: []` shape.
 */
export function buildRecommendKbPayload(decision: WhereDecision | null): RecommendKbPayload {
  if (decision === null) {
    return {
      schema_version: RECOMMEND_SCHEMA_VERSION,
      recommended_kb: null,
      existing_target: null,
      confidence: null,
      confident: false,
    };
  }
  return {
    schema_version: RECOMMEND_SCHEMA_VERSION,
    recommended_kb: decision.recommendedKb,
    existing_target: decision.existingTarget,
    confidence: decision.confidence,
    confident: decision.existingTarget !== null,
  };
}
