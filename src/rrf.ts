// Issue #206 stage 2 — Reciprocal Rank Fusion combinator.
//
// Why this lives in its own module. The fusion math is pure (no I/O,
// no clock, no filesystem) and is consumed from at least two surfaces
// (CLI `--mode=hybrid` and MCP `retrieve_knowledge` with
// `search_mode=hybrid`). Keeping it pure lets the unit tests pin every
// behavioral knob — the constant `c=60` choice, the per-retriever
// weights, the tie-break rule — without standing up a manager or a
// retriever.
//
// The math. For a document `d` that appears at rank `rank_r(d)` in the
// ranked list produced by retriever `r` (1-based), its fused score is:
//
//     score(d) = Σ_r  w_r * (1 / (c + rank_r(d)))
//
// where `w_r` is the per-retriever weight (defaulting to 1) and `c` is
// the smoothing constant. We use `c = 60` per Cormack et al. 2009 (the
// same default LangChain's `EnsembleRetriever` ships). Cormack
// established `60` as a reasonable across-the-board choice on TREC; it
// also happens to be the value RFC 006 §5.4 picked for dense-multi-
// provider fusion, so this module's choice is consistent with the
// existing in-house convention.
//
// Document identity. Fusion only makes sense if the same chunk appears
// under the same identifier in both ranked lists. The chunks the FAISS
// path and the lexical path each return carry `metadata.source`
// (absolute path) and `metadata.chunkIndex`; together those form a
// stable `${source}#${chunkIndex}` key. Callers compute the key once
// per chunk and pass it as `id` to this module. This module does NOT
// look at metadata — it operates purely over `(id, rank)` pairs.

export interface RankedDoc {
  /** Stable identifier; e.g. `${metadata.source}#${metadata.chunkIndex}`. */
  id: string;
  /** 1-based rank in the producing list. Position 1 is the highest-rated. */
  rank: number;
}

export interface RankedList {
  /** Tag for the contributing retriever. Surfaced on the fused output for
   *  attribution; does not affect the math beyond per-retriever weights. */
  retriever: string;
  results: RankedDoc[];
}

export interface RRFOptions {
  /** Smoothing constant `c` in `1 / (c + rank)`. Default 60 (Cormack 2009). */
  c?: number;
  /** Per-retriever weights, keyed by `RankedList.retriever`. Missing entries
   *  default to 1. Negative or non-finite weights are rejected. */
  weights?: Record<string, number>;
}

export interface FusedResult {
  id: string;
  /** Sum of per-retriever weighted reciprocal-rank contributions. */
  fusedScore: number;
  /** Per-retriever rank contributions; useful for debugging and explanation
   *  surfaces. Absent retrievers are omitted. */
  contributions: Record<string, number>;
}

export const DEFAULT_C = 60;

/**
 * Stable chunk identity for RRF fusion. Mirrors `${metadata.source}#${metadata.chunkIndex}`
 * so the dense and lexical paths produce the same id for the same chunk.
 *
 * Robust against missing fields: falls back to the JSON-stringified metadata,
 * which still gives a deterministic key — just not aligned with the other
 * retriever, so those chunks then count as single-list hits (still useful, just
 * not fused). The chunker (`buildChunkDocuments`) sets both `source` and
 * `chunkIndex` for every chunk it emits, so the fallback is defense-in-depth.
 */
export function chunkIdFromMetadata(meta: Record<string, unknown>): string {
  const source = typeof meta.source === 'string' ? meta.source : null;
  const chunkIndex = typeof meta.chunkIndex === 'number' ? meta.chunkIndex : null;
  if (source !== null && chunkIndex !== null) return `${source}#${chunkIndex}`;
  return `meta:${JSON.stringify(meta)}`;
}

/**
 * Reciprocal Rank Fusion. Pure function — no I/O, no clock, no globals.
 *
 * Implementation notes:
 *
 * - Empty `lists` returns `[]`.
 * - Each `RankedList.results` is consumed in array order; if `rank` is
 *   missing it is assigned from the array index (1-based). The explicit
 *   `rank` field wins when present so callers that have already computed
 *   ranks (e.g. after deduping or re-ranking) keep their authority.
 * - Documents that appear multiple times within a single ranked list are
 *   credited with the BEST (lowest) rank from that list — a defensive
 *   choice for callers that pass un-deduped chunk lists. Within-list
 *   duplicates do not double-count.
 * - Tie-break on equal `fusedScore` is **insertion order from the
 *   iteration over `lists`**. This is deterministic and stable across
 *   runs given the same inputs, which is important for the eval-fixture
 *   path (#206 §validation gate "no regression on natural-language
 *   queries").
 * - Throws on negative `c`, non-finite weights, or non-positive `rank`
 *   values — these are programmer errors at the caller seam.
 */
export function reciprocalRankFusion(
  lists: RankedList[],
  options: RRFOptions = {},
): FusedResult[] {
  const c = options.c ?? DEFAULT_C;
  if (!Number.isFinite(c) || c < 0) {
    throw new Error(`RRF: invalid c=${c}; expected a finite non-negative number`);
  }
  const weights = options.weights ?? {};
  for (const [name, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`RRF: invalid weight for retriever "${name}": ${weight}`);
    }
  }

  // Order of first appearance across lists drives the tie-break.
  const order: string[] = [];
  const accum: Map<string, FusedResult> = new Map();

  for (const list of lists) {
    const w = weights[list.retriever] ?? 1;
    if (w === 0) continue;

    // Within-list dedupe: keep the smallest rank we see for each id.
    const bestRankForId = new Map<string, number>();
    list.results.forEach((doc, idx) => {
      const explicit = doc.rank;
      if (explicit !== undefined && (!Number.isFinite(explicit) || explicit < 1)) {
        throw new Error(
          `RRF: invalid rank=${explicit} for id="${doc.id}" in list "${list.retriever}"; expected ≥ 1`,
        );
      }
      const rank = explicit ?? idx + 1;
      const prior = bestRankForId.get(doc.id);
      if (prior === undefined || rank < prior) {
        bestRankForId.set(doc.id, rank);
      }
    });

    for (const [id, rank] of bestRankForId.entries()) {
      const contribution = w * (1 / (c + rank));
      let entry = accum.get(id);
      if (entry === undefined) {
        entry = { id, fusedScore: 0, contributions: {} };
        accum.set(id, entry);
        order.push(id);
      }
      entry.fusedScore += contribution;
      entry.contributions[list.retriever] = (entry.contributions[list.retriever] ?? 0) + contribution;
    }
  }

  const out = order.map((id) => accum.get(id) as FusedResult);
  // Stable sort: V8's Array.prototype.sort is guaranteed stable since 2018,
  // which gives us the insertion-order tie-break for free.
  out.sort((a, b) => b.fusedScore - a.fusedScore);
  return out;
}
