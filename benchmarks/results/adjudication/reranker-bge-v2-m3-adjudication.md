# Reranker upgrade adjudication — RFC 020 M5 (issue #565)

**Decision: NO-SHIP** _(provisional)_

PROVISIONAL NO-SHIP — no per-domain BEIR evidence was supplied — the load-bearing runs are pending; stay on the baseline reranker.

| Field | Value |
| --- | --- |
| Candidate reranker | `BAAI/bge-reranker-v2-m3` |
| Baseline reranker | `Xenova/ms-marco-MiniLM-L-6-v2` |
| Multiple-comparison correction | holm (α=0.05) |
| Domains measured | 0 |
| e2e veto | not measured |

## Per-domain gate (§3 significance + §9 per-domain measurement)

_No per-domain BEIR evidence supplied — see pending evidence below._

## End-to-end RAG veto (§5)

_No e2e metrics supplied — the §5 veto is PENDING (needs gold-QA answers + the judge panel)._

## Recommended configuration

To realize this decision through the production plug points:

```bash
export KB_RERANK=on
export KB_RERANK_MODEL=Xenova/ms-marco-MiniLM-L-6-v2
# KB_RERANK_SKIP_DOMAINS: (none — no domain was gated out)
```

## Pending evidence (decision is provisional)

- BEIR per-domain runs: hybrid+rerank with the baseline cross-encoder (Xenova/ms-marco-MiniLM-L-6-v2) vs the candidate (BAAI/bge-reranker-v2-m3) across SciFact / NFCorpus / FiQA and at least one high-precision/lexical domain (code or skills), using a real embedding provider (Ollama) and the candidate reranker downloaded. Not runnable in this offline, model-free environment.
- Per-domain §3 significance needs the per-query nDCG@10 vectors produced by the BEIR runs above (paired baseline-vs-candidate over the same query set).
- e2e RAG veto (§5): baseline-vs-candidate rag-eval scorecards over gold-bearing QA with >=3 live judge families. The hermetic --fake scorecard under ./e2e-selftest proves the leg runs end-to-end but echoes gold answers (a plumbing self-test, accuracy=1.0), so it is NOT a quality measurement and supplies no veto delta.

---

Decision rule: **NO-SHIP** if the §5 e2e veto fires or no domain shows a
significant nDCG@10 gain; **SHIP-GATED** if some domains improve and others
are gated out via the skip-rerank fallback; **SHIP** only if every measured
domain improves and the e2e veto passes. No benchmark number is fabricated —
a provisional decision lists its outstanding evidence above (issue #565).
