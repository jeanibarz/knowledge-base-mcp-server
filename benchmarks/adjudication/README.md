# Tier-1 technique adjudication (RFC 020 M5 · issue #565)

The final milestone of RFC 020: take **one** Tier-1 retrieval technique through
the full harness (M0–M4) and produce a documented **ship / no-ship** decision
backed by evidence — not a single-run eyeballed delta.

The technique adjudicated here is the **reranker upgrade**: the default
cross-encoder `Xenova/ms-marco-MiniLM-L-6-v2` → a stronger model such as
`BAAI/bge-reranker-v2-m3` / `Qwen3-Reranker`, selectable through the existing
`KB_RERANK_MODEL` plug point. Per RFC §9 the upgrade is **not a universal win**
(the KB survey found cross-encoders *degrade* high-precision/lexical domains like
code and skills), so it ships only behind:

- a **per-domain measurement gate** — measure nDCG@10 per domain (not just the
  BEIR mean) and enable rerank only where it is a *significant* improvement; and
- a **skip-rerank fallback** — `KB_RERANK_SKIP_DOMAINS` keeps the cheaper,
  un-reranked path for domains where the cross-encoder regresses or shows no
  significant gain.

## What this module does

`adjudicate.ts` consumes:

1. **Per-domain BEIR evidence** — paired per-query nDCG@10 vectors (baseline
   reranker vs candidate reranker), compared with the §3 significance machinery
   in `benchmarks/significance.ts` (paired bootstrap + t-test, Bonferroni/Holm
   family correction, wild-cluster bootstrap when queries cluster by dataset).
2. **The §5 e2e RAG veto** — faithfulness / answer-correctness numbers from the
   human-label-free cascade (`benchmarks/rag-eval/`). A regression past tolerance
   hard-vetoes the ship even when BEIR improves.

and emits a structured decision plus the per-domain policy and the recommended
`KB_RERANK_MODEL` + `KB_RERANK_SKIP_DOMAINS` config to realize it.

### Decision rule

| Decision | When |
|---|---|
| **NO-SHIP** | the §5 e2e veto fires, **or** no domain shows a significant nDCG@10 gain (incl. "no per-domain evidence supplied") |
| **SHIP-GATED** | some domains improve and others are gated out via the skip-rerank fallback; e2e veto passes |
| **SHIP** | every measured domain improves significantly and the e2e veto passes (empty skip list) |

## Running it

```bash
npm run bench:adjudicate -- --manifest <manifest.json> \
    --output-dir benchmarks/results/adjudication \
    --report-name reranker-bge-v2-m3-adjudication
```

The manifest declares the candidate/baseline models, the per-domain BEIR run
files to compare, and the e2e veto inputs (inline numbers or rag-eval scorecard
paths). See `adjudicate.ts` `--help` for the full schema.

## Honesty contract

This module **never fabricates a benchmark number**. A real run needs BEIR
datasets + a real embedding model + the candidate cross-encoder + (for the e2e
leg) ≥3 live judge families. Where any of those is missing the adjudication is
marked **provisional** and the missing evidence is listed in `pending`; the
decision machinery + unit tests still ship, and the report self-describes what is
outstanding. See `../results/adjudication/` for the produced (provisional)
report and the hermetic e2e self-test.
