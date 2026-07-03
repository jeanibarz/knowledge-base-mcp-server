# Reranker Requirements

## Search

### FR-SEARCH-374: Cross-Encoder Reranker
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall optionally rerank first-stage retrieval candidates with a local cross-encoder before result assembly and relevance gating.
**Rationale:** Hybrid dense/BM25 fusion produces a rank-based score rather than a calibrated query-passage relevance score. A cross-encoder re-scores each query/candidate pair jointly and improves precision without replacing the existing retrievers.

**Acceptance Criteria:**
- [x] Given `KB_RERANK=off`, when hybrid retrieval runs, then result ordering and output remain the fused baseline.
- [x] Given `KB_RERANK=on` or `kb search --rerank`, when hybrid retrieval produces candidates, then the system shall re-score the top `KB_RERANK_TOP_N` candidates, sort that block by descending reranker score, and leave unscored tail candidates after the reranked block.
- [x] Given a reranked JSON search result, when the result is serialized, then the payload shall include `rerank_score` without replacing the original retrieval `score`.
- [x] Given the reranker provider fails or returns an invalid score array, when retrieval runs, then the system shall degrade to the original fused order and shall not fail retrieval.
- [x] Given repeated query/candidate pairs in a process, when reranking runs, then an in-memory score cache shall avoid duplicate provider calls.
- [x] Given `KB_RERANK_BATCH_SIZE=N` with `N > 0`, when the reranker scores `M` cache-miss candidates, then it shall issue `ceil(M / N)` model calls over fixed-size sub-batches and return scores in the original candidate order; `0`/unset preserves the single-call behavior. This bounds peak tokenizer/activation memory to the batch size (useful on CPU/memory-constrained hosts) without changing the resulting ranking. (#746)

**Linked Tests:** TS-SEARCH-374
**Dependencies:** RFC019, FR-SEARCH-206, FR-SEARCH-313, RFC018
