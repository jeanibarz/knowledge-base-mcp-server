# Query Decomposition Evaluation (#577)

Generated: 2026-06-08

## Scope

This note records the evaluation status for the opt-in query decomposition
retrieval mode added for #577. It does not fabricate benchmark numbers.

## Implemented

- CLI opt-in: `kb search --mode=hybrid --decompose`.
- Bounded budgets: `--decompose-max-subqueries`,
  `--decompose-max-iterations`, `--decompose-max-candidates`, and
  `--decompose-timeout-ms`.
- Providers: deterministic `rule`, plus `llm` using
  `KB_DECOMPOSE_LLM_ENDPOINT` or `KB_LLM_ENDPOINT` with rule fallback.
- JSON trace: `query_decomposition` with subqueries, evidence groups,
  missing aspects, retrieval calls, and stop reason.
- BEIR benchmark mode: `hybrid+decompose`, with per-query decomposition traces
  persisted as `*-query-decomposition-traces.json` and summarized in the BEIR
  report.

## Verification Run Here

Hermetic verification was limited to unit/integration tests using deterministic
fixtures:

- `src/query-decomposition.test.ts`: decomposition loop, canonical evidence
  dedupe, sufficiency stop, and budget stop trace.
- `src/cli-search.test.ts`: CLI parsing and unchanged hybrid error ordering.
- `benchmarks/beir/run.dense.test.ts`: `hybrid+decompose` delegates to the
  hybrid backend and persists trace artifacts.

## Pending Real Metrics

Real quality numbers remain pending on #573 benchmark outputs and local dataset
availability:

- HotpotQA gold sample from the RAG eval harness: pending.
- BRIGHT biology/economics sample: pending BRIGHT task data.
- BEIR HotpotQA: supported by the BEIR registry, pending real provider run.
- SciFact non-multi-hop regression: pending real provider run.

Required metrics to record when #573 baselines are available:

- Supporting-fact context recall/precision or another context-aware set-level
  judgment for multi-hop samples.
- RAG eval Tier 1 answer EM/F1.
- nDCG@10 and Recall@100 where qrels exist.
- Query latency and total retrieval calls per user query.

The deterministic fake provider can smoke-test artifact plumbing, but its
scores are not semantic quality baselines.
