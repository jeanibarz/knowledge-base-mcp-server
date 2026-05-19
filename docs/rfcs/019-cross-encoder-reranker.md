# RFC 019 — Cross-Encoder Reranker

**Status:** Accepted; M0a/M0b complete; `KB_RERANK=off` remains the default
**Depends on:** #206 (hybrid RRF), #313 (query-embedding cache pattern), RFC 009 (error taxonomy), RFC 010 (MCP surface)
**Composes with:** RFC 017 (contextual retrieval — improves *what* is embedded), RFC 018 (relevance gating — decides *whether* to inject)
**Tracks:** retrieval precision — first-stage fusion produces a rank ordering, not a calibrated relevance score

## Problem

Hybrid retrieval (#206) fuses a dense (FAISS) leg and a lexical (BM25) leg with Reciprocal Rank Fusion. RRF is rank-based: the fused score is `Σ 1/(c + rank)` and carries **no calibrated relevance meaning** — the per-rank contribution at `c=60` is ≈ 0.016 and inter-rank spacing is ~0.00026. Two consequences:

1. **Ordering is fusion-rank, not relevance.** A chunk ranks high because *both* legs ranked it reasonably, not because a model judged it actually answers the query. First-stage retrievers (dense bi-encoder, BM25) embed query and document *independently* — they never see the pair together, so they cannot model term-level interaction ("does this passage actually answer *this* question").

2. **Downstream stages inherit an uncalibrated signal.** RFC 018's relevance gate explicitly notes its statistical stages (A1 absolute floor, A2 knee) are weak *because* the underlying scores are not calibrated relevance. A reranker that emits a real per-pair relevance score fixes that signal at its root.

A **cross-encoder reranker** re-scores each `(query, candidate)` pair jointly — the query and the chunk go through the model *together*, with full cross-attention — and recovers the precision a bi-encoder structurally cannot. Anthropic's *Contextual Retrieval* measured the stack effect directly: contextual embeddings cut top-20 retrieval failures by 35%, contextual embeddings + contextual BM25 by 49%, and **+ a reranking step by 67%** — reranking contributed the final, largest increment. The reranker is the single highest-precision-per-unit-compute stage the pipeline does not yet have.

## Goal

Add an optional **reranker stage** between fusion and result assembly: re-score the top-`N` fused candidates with a local cross-encoder, reorder by the cross-encoder score, and expose that score to downstream consumers (`kb search`, MCP `retrieve_knowledge`, and the RFC 018 gate).

Concretely:

- Re-score the top-`N` fused candidates (`N` default 40 — the pipeline already overfetches: `hybridFetchK = min(k×4, 200)`, so the candidates exist at no extra retrieval cost).
- Run a **local, CPU-feasible cross-encoder** in-process — no GPU, no network, consistent with the local-first design.
- Reorder the returned `k` results by cross-encoder score; attach the score to each result.
- Feature-gate behind `KB_RERANK=off|on` (off by default — behavior identical to today).
- Compose cleanly: the reranker runs **after** fusion and **before** the RFC 018 gate, so the gate's A1/A2 stages consume a calibrated score.

**Non-goals:**

- **Replacing dense or lexical retrieval.** The reranker is a second-stage *re-scorer* over first-stage candidates; it does not retrieve.
- **ColBERT / late-interaction indexing.** Per-token multi-vector storage is a different ingest architecture and a poor fit at this corpus scale — a cross-encoder over ~40 candidates gives most of the precision at none of the storage cost.
- **LLM listwise reranking** (RankGPT-style). Too slow locally and overlaps RFC 018's LLM judge; out of scope.
- **Changing fusion.** RRF (#206) still produces the candidate set the reranker re-scores.
- **The relevance keep/drop decision.** That is RFC 018's gate. The reranker reorders; it does not suppress. (It *improves the gate's inputs*.)

## Design

### 1. Pipeline placement

```
dense ‖ lexical  →  RRF fuse (#206)  →  rerank (RFC 019)  →  [relevance gate (RFC 018)]  →  assemble
```

The reranker re-scores and reorders the fused candidate set. It runs before the RFC 018 gate so the gate sees a calibrated relevance score (the reranker's score becomes a far better A1 floor / A2 knee input than a raw FAISS distance or an RRF rank). When `KB_RERANK=off`, the stage is a pass-through and the pipeline is byte-identical to today.

### 2. The reranker provider

A new `src/reranker.ts` module with a provider interface mirroring `embedding-provider.ts`:

```ts
export interface Reranker {
  /** Returns one relevance score per candidate, higher = more relevant. */
  rerank(query: string, candidates: string[]): Promise<number[]>;
}
```

**Default implementation: in-process ONNX cross-encoder** via `transformers.js` (`@huggingface/transformers`), which runs HuggingFace cross-encoder models as quantized ONNX on CPU with no Python and no network at inference time. Candidate models (`KB_RERANK_MODEL`):

- `Xenova/ms-marco-MiniLM-L-6-v2` — ~23 MB quantized, ~55 ms p95 for a 40-candidate batch on CPU. The fast default.
- `Xenova/bge-reranker-base` — larger, stronger, ~90 ms p95. The accuracy option.

The model is downloaded once and cached under the HF cache dir; an offline run with a warm cache needs no network. A first run with no cache needs one download — surfaced as a `kb doctor` check, not a silent stall.

(A second provider — an Ollama- or endpoint-hosted reranker — is left as a follow-up; the interface is provider-shaped so it slots in without touching callers.)

### 3. The rerank stage

`rerankFusedResults({ query, fused, k, topN })`:

1. Take the top-`topN` fused candidates (`KB_RERANK_TOP_N`, default 40, capped at the fused set size).
2. Call `reranker.rerank(query, candidates.map(c => c.text))` — one batched call.
3. Attach each cross-encoder score to its candidate as `rerank_score`.
4. Sort the `topN` by `rerank_score` descending; candidates beyond `topN` keep their fused order and sort *after* the reranked block (they were never re-scored — they are not promoted above a reranked candidate).
5. Return the top-`k`.

The stage is pure given the provider — no I/O beyond the provider call — so it is unit-testable with a stub reranker.

### 4. Reranked text — composition with RFC 017

The reranker scores the **text the consumer will see**. If RFC 017 (contextual retrieval) is enabled, the embedding input is preface-augmented but the *stored / returned* chunk is the original verbatim text. The reranker re-scores the **original chunk text** (what the model is being asked "does this answer the query") — not the contextual preface. This keeps the reranker's judgment about the passage the consumer actually gets, and keeps RFC 017 and RFC 019 independent.

### 5. Score caching

Cross-encoder scores are cacheable. Reuse the #313 query-cache pattern: an in-memory LRU keyed on `sha256(rerank_model_id | normalize(query) | candidate_content_sha256)`. A repeated `(query, chunk)` pair within a process is a free hit. No disk tier — like RFC 018's verdict cache, the cross-session hit rate does not justify one.

### 6. Configuration surface

Operator defaults, rollout status, and validation commands are summarized in
[`docs/feature-flags.md`](../feature-flags.md#reranker).

| env var | default | effect |
|---|---|---|
| `KB_RERANK` | `off` | `off` (identical to today) \| `on` (rerank the top-`N` fused candidates). |
| `KB_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | the cross-encoder model id. |
| `KB_RERANK_TOP_N` | `40` | how many fused candidates to re-score. |

CLI: `kb search --rerank` / `--no-rerank` per-call override; `--timing` reports the rerank stage latency; `--format=json` results carry `rerank_score`.

### 7. Observability

- A `rerank.stage` canonical-log line: `query_sha256`, `model`, `candidates_in`, `took_ms`, `cache_hits`, and `degraded`.
- `kb search --timing` reports rerank stage latency, candidates, and cache hits; `--format=json` adds the `rerank` status object and per-hit `rerank_score` when reranking ran.
- MCP `retrieve_knowledge` hybrid output annotates the header when reranking ran.
- `kb doctor` reports reranker config and whether the Transformers.js model appears to be cached when `KB_RERANK=on`.
- Follow-up observability before default-on: `kb stats` p50/p95/cache-hit summaries and a `kb search --explain` rank-audit view that shows fused rank vs. reranked rank side by side.

## Failure modes

| failure | detection | response |
|---|---|---|
| Reranker model not in cache, no network | provider load throws | `KB_RERANK=on` degrades to the fused order with a one-time `WARN`; `kb doctor` flags it. Retrieval never breaks. |
| Reranker call is too slow for interactive use | `kb search --timing`, M0b report | keep `KB_RERANK=off` by default; add a timeout/abort guard before reconsidering default-on. |
| ONNX runtime unavailable on the platform | provider init throws | degrade to fused order; `kb doctor` reports the platform gap. |
| `topN` larger than the fused set | length check | re-score whatever exists; no error. |
| Reranker returns a wrong-length score array | length mismatch | discard the rerank pass for that query, fall back to fused order, log. |

Provider load/scoring errors and malformed score arrays fail soft to today's fused ordering. M0a does not include a timeout/abort guard, so a hung provider call can still hang that query; this is one reason M0b kept reranking opt-in. The stage never empties a result set by itself (that is RFC 018's concern, not this stage's).

## Migration / rollout

- **M0a — Reranker provider + stage** (one PR). `src/reranker.ts` (provider interface + the `transformers.js` ONNX implementation), `rerankFusedResults`, `KB_RERANK*` config, wire into the shared retrieval path behind the flag, `rerank_score` in JSON output, score cache, canonical log + `kb doctor` check. Default `off`. Unit tests with a stub reranker; an integration test with the real model on a small fixture. **Implemented for hybrid retrieval and eval.**
- **M0b — Eval** (one PR / operator run). The `retrieval-eval` harness already computes nDCG@10 / MRR@10 / recall@k — run it with `KB_RERANK` off vs. on over the existing fixtures and report the precision lift. This is the reranker's natural validation: unlike RFC 018's gate, the reranker is *not* recall-negative (it reorders, never drops), so the bar is simply "nDCG/MRR improve, latency acceptable." **Completed 2026-05-19; see [`019-m0b-reranker-report.md`](019-m0b-reranker-report.md).**
- **M0c — Default on** (separate PR, conditional on M0b). If M0b shows a clear nDCG/MRR lift at acceptable latency, flip the default to `on`. Otherwise keep `KB_RERANK=off`. **Decision: no-go for default-on on the 2026-05-19 operating-environment canary. The corrected cross-encoder path produced a small nDCG@10/MRR@10 lift, but cold CLI latency was too high for default-on. Keep opt-in.**

**Composition note.** RFC 019 and RFC 018 are concurrent tracks. When both land, the order is fusion → rerank → gate; the gate's A1/A2 thresholds are re-tuned against the reranker's calibrated score (which is a far better floor signal than a raw distance). RFC 017 is independent of both.

**Rollback:** clear `KB_RERANK`. The stage is a pure pass-through when off; no on-disk artifacts beyond the model cache.

## Open questions

- **Latency under the MCP path.** The probe figures (~55–90 ms) are for a warm in-process model; first-call model load is slower. Whether to warm the reranker at server start or lazily is an M0a detail.
- **`transformers.js` as a dependency.** It pulls an ONNX runtime. The size and platform-support implications (it must work on the Linux/WSL2 target and in the Docker image) need an M0a check; a subprocess-based provider is the fallback if in-process ONNX is problematic.
- **Interaction with RFC 018's `KB_GATE_JUDGE_INPUT` cap.** With the reranker on, the top-`k` handed to the gate is already precision-ordered — the gate's judge may need fewer candidates. A tuning question for when both land.
- **Reranking the contextual-preface text vs. the original** (§4 picks the original) — worth an A/B in M0b if RFC 017 is also enabled.

_This RFC has moved from draft to implementation. M0b did not justify a default-on flip; reranking remains available as an opt-in hybrid retrieval stage._
