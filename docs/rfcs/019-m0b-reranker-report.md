# RFC 019 M0b Reranker Report

**Date:** 2026-05-19
**Fixture:** [`docs/testing/fixtures/rfc-019-reranker-eval.yml`](../testing/fixtures/rfc-019-reranker-eval.yml)
**Shelf:** `operating-environment`
**Embedding model:** `ollama__nomic-embed-text-latest`
**Reranker model:** `Xenova/ms-marco-MiniLM-L-6-v2`
**Retrieval mode:** `hybrid`

## Commands

```bash
KB_RERANK=off node build/cli.js eval docs/testing/fixtures/rfc-019-reranker-eval.yml --format=json > /tmp/rfc019-ranked-off.json
KB_RERANK=on node build/cli.js eval docs/testing/fixtures/rfc-019-reranker-eval.yml --format=json > /tmp/rfc019-ranked-on.json
KB_RERANK=on node build/cli.js search "where does the kookr task-spawning daemon store its registry state" \
  --kb=operating-environment --mode=hybrid --format=json --timing --no-freshness \
  > /tmp/rfc019-search-smoke.json
```

## Results

| metric | `KB_RERANK=off` | `KB_RERANK=on` | delta |
|---|---:|---:|---:|
| passed cases | 8 | 8 | 0 |
| failed cases | 0 | 0 | 0 |
| nDCG@10 | 0.8772228201007499 | 0.8827007889556063 | 0.005477968854856408 |
| MRR@10 | 0.8375 | 0.84375 | 0.006249999999999978 |
| recall@k | 1 | 1 | 0 |
| precision@k | 0.09999999999999999 | 0.09999999999999999 | 0 |
| MAP@k | 0.8375 | 0.84375 | 0.006249999999999978 |
| hit rate | 1 | 1 | 0 |

Live search smoke with `KB_RERANK=on`:

- Canonical `rerank.stage` emitted with `candidates_in=40`, `degraded=false`, `cache_hits=0`.
- JSON output exposed `rerank.enabled=true`, `rerank.candidates=40`, and per-result `rerank_score`.
- Smoke timing reported `fusion_ms=1`, `rerank_ms=3294`, and `total_ms=4285` for a cold CLI process.
- Top result remained `~/knowledge_bases/operating-environment/kookr-task-spawning-daemon-oss-registry-state-paths.md`.

## Decision

M0b is a **no-go for default-on**. The corrected cross-encoder path produced a small precision lift on this canary (`nDCG@10 +0.00548`, `MRR@10 +0.00625`) without recall loss, but the cold CLI latency is too high to enable by default. Keep `KB_RERANK=off` by default and treat reranking as an opt-in hybrid retrieval feature until a broader or harder fixture demonstrates a larger precision improvement or the reranker is warmed/accelerated.
