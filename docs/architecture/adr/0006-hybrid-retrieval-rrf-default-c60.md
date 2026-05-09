# 0006 — Hybrid retrieval via Reciprocal Rank Fusion with c=60

- **Status:** Accepted (#206 stage 2)
- **Date:** 2026-05-09
- **Deciders:** Repo owner

## Context and Problem Statement

Pure dense retrieval (FAISS over an embedding model) has well-documented blind spots on **exact-token queries**: filenames, RFC/ADR numbers, error codes, env var names, model ids, code identifiers. RFC 006 §4 named sparse+dense hybrid retrieval as a non-goal and explicitly deferred it to a follow-up sparse-hybrid RFC; issue #206 is that follow-up. Stage 1 (#206 stage 1, PR #223) shipped the per-KB BM25 lexical index and a `kb search --mode=lexical` debug surface. Stage 2 (this ADR) wires the two ranked lists together.

Two combiner families were considered:

1. **Linear interpolation.** `score(d) = α · norm(dense_score(d)) + (1-α) · norm(lexical_score(d))`. Requires a score-normalization step per retriever and a parameter sweep over `α`. Highly sensitive to score-distribution drift across embedding models, BM25 corpus size, and retriever weighting.
2. **Reciprocal Rank Fusion (RRF, Cormack et al. 2009).** `score(d) = Σ_r w_r · 1/(c + rank_r(d))`. Operates only on **rank**, not raw score, so it is invariant under any monotonic transform of either retriever's scoring. Has one knob (`c`) which Cormack found near-optimal at `60` across TREC topics; LangChain's `EnsembleRetriever` ships with the same default.

## Decision

Use **RRF with `c = 60`** as the default and only fuser for `--mode=hybrid` and the MCP `retrieve_knowledge` `search_mode: "hybrid"` arg.

## Decision Drivers

- **Score-distribution invariance.** Dense scores are FAISS L2 distances on float vectors; BM25 scores are TF-IDF aggregates over token frequencies. There is no principled normalization between them. RRF sidesteps the question entirely.
- **Cross-model stability.** When users add a second embedding model (RFC 013 multi-model support), the dense score distribution shifts; RRF keeps fusion stable.
- **One-knob simplicity.** Cormack's `c=60` choice has held up empirically across TREC corpora and inside LangChain's production retriever stack. We start from the same default and let operators tune via per-retriever weights (`KB_HYBRID_DENSE_WEIGHT`, `KB_HYBRID_LEXICAL_WEIGHT`) when their workload warrants it.
- **Existing convention.** RFC 006 §5.4 already chose RRF for the dense-multi-provider fusion path. Reusing the same combinator for sparse+dense keeps the codebase coherent and lets the eventual three-way (dense_A + dense_B + lexical) fusion in RFC 006's `deep` tier be a one-line extension instead of a redesign.
- **Per-retriever weight headroom.** RRF accepts `w_r` weights without changing the math, so future ablations on `α` can land as `weights = { dense: α, lexical: 1-α }` without reworking the combinator.

## Considered and Rejected

- **Linear interpolation with score normalization.** Scores from different retrievers normalize differently; min-max normalization makes the fusion sensitive to outliers; z-score normalization is ill-defined for BM25 corpora with one or two documents. The op-cost of "what α should I use?" lands on every operator. Rejected.
- **Cross-encoder rerank** (RFC 006's `deep` tier) **as the fuser.** Cross-encoder rerank is a separate concern (re-rank a top-N candidate set with a transformer model) — it's *complementary* to RRF, not a replacement. Out of scope for #206; RFC 006 §5 keeps it.
- **Higher c (e.g. `100`).** Reduces the gap between rank-1 and rank-50 contributions, which over-weights deep-tail matches. Net regression on the exact-token cases that motivate hybrid in the first place.
- **Lower c (e.g. `10`).** Over-amplifies rank-1 contributions; one strong-rank-1 in a single retriever dominates the fused score; loses the cross-confirmation effect that hybrid is meant to provide.

## Implementation Notes

- `src/rrf.ts` is the only place the RRF math lives. Pure function; unit-tested.
- `c` is hard-coded to `60` at the call sites today. Surfacing it as `KB_HYBRID_RRF_C` is a small follow-up if operator demand surfaces.
- Per-retriever weights are wired through `RRFOptions.weights` but not exposed via env var in v1. Default `dense: 1, lexical: 1`.
- Tie-break on equal `fusedScore` is **stable insertion order** of the contributing lists — dense first, then lexical. Documented in the unit tests.

## Validation

The validation gate per #206 §M2 is:

1. **Byte-equality of dense-only callers.** Any `retrieve_knowledge` call that omits `search_mode` or passes `search_mode: "dense"` produces output identical to the 0.x dense-only behavior. Verified by the existing dense-path test suite (583 tests retained).
2. **Lift on exact-token cases.** The `docs/testing/fixtures/hybrid-vs-dense.yml` pack contains gated cases like `INDEX_NOT_INITIALIZED`, `RFC 006`, `pickleparser`, `MCP_AUTH_TOKEN`, `ollama__nomic-embed-text-latest` where dense alone misses; hybrid is expected to pass.
3. **No regression on natural-language cases.** Same fixture pack contains paraphrased doc-heading queries where dense should win; hybrid must keep passing them.

## More Information

- Cormack, G. V., Clarke, C. L. A., & Büttcher, S. (2009). *Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods.*
- RFC 006 (`docs/rfcs/006-multi-provider-tiered-retrieval.md`) §4–§5.
- Issue #206; issue #214 (cross-process query-embedding cache, separate concern).
