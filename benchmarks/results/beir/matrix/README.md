# BEIR full-matrix sweep (RFC 020 §2/§6/§7, milestone M2)

This directory holds the output of `bench:beir:matrix` — the full BEIR
`(dataset × mode)` sweep whose **headline metric is the per-mode multi-domain
mean nDCG@10** (RFC 020 §2). Averaging across domains is the anti-overfitting
metric by construction: anything tuned to a single corpus *lowers* the mean.

Two artifacts are produced (gitignored until a maintainer commits a real run):

```
beir-matrix.json   full report — one cell per (dataset × mode), per-mode means,
                   per-domain breakdown, Δ_g, contamination notes, and the env
                   that produced it (git SHA + model IDs + RRF c + rerank
                   model/topN + chunk size/overlap + contextual on/off)
beir-matrix.md     human-readable headline + per-domain + Δ_g tables
```

## What the matrix reports

- **Headline** — `perMode[].multiDomainMeanNdcgAt10`, the mean across the
  datasets that actually ran (the mean is labelled with its denominator, e.g.
  `mean over 3 of 14 datasets`, so a partial sweep is self-describing).
- **Per-domain breakdown** (§6) — mean nDCG@10 / precision@10 per registry
  domain bucket, so a domain-localized regression a single mean would bury is
  visible.
- **Δ_g = (seen − unseen) / seen** (§6.5) — the generalization gap between the
  tuned/dev datasets (`scifact`, `nfcorpus`, `fiqa`) and a **reserved
  unseen-generality set** that is never tuned on (`arguana`, `scidocs`,
  `webis-touche2020`). A widening Δ_g is the overfitting alarm a multi-domain
  mean alone hides. `significance.ts` is the companion arbiter: Δ_g flags the
  suspect, the paired bootstrap convicts it.
- **Contamination notes** (§6.6) — per-dataset known-in-pretraining flag and
  qrels provenance, carried from `benchmarks/beir/registry.ts`. Dataset names
  are recorded here for provenance only and are excluded from any LLM-grader
  prompt.

Every run is wired into the MLflow ledger (`bench:beir:matrix` calls
`logBeirRunToMlflow` per cell and `logBeirMatrixToMlflow` for the headline; both
no-op unless `BENCH_MLFLOW_*` is configured). The cross-run **leaderboard view**
(`bench:beir:leaderboard`) ranks recorded `beir-matrix.json` runs side by side.

## Status of the as-shipped headline ⚠️ — full sweep pending

The full-matrix headline for the shipped pipeline (`hybrid+rerank+contextual`)
requires **every BEIR dataset downloaded** *and* a **real embedding model**
(Ollama) plus the cross-encoder. None of those is available in the CI/build
sandbox used to land this milestone (no dataset host egress, no Ollama daemon),
so **no real full-matrix number is committed here yet** — and, per the RFC's
"honestly-measured" principle, none is fabricated.

What *is* landed and verified:

- The full machinery — dataset registry, matrix runner, per-domain breakdown,
  Δ_g, MLflow ledger wiring, and the cross-run leaderboard view — with unit
  tests that exercise the aggregation, the Δ_g math, the ledger payloads, and
  the leaderboard render from deterministic stub inputs.
- The per-(dataset × mode) BEIR runner itself produces real, committed,
  reproducible numbers (see `../baseline/README.md` for the recorded SciFact
  lexical/dense/hybrid baselines on `ollama / nomic-embed-text`).

To produce the real headline (maintainer, with Ollama running and dataset host
reachable):

```bash
# Full auto-downloadable matrix, all shipped modes:
npm run bench:beir:matrix -- --provider=ollama --model=nomic-embed-text \
  --modes=lexical,dense,hybrid,hybrid+rerank,hybrid+rerank+contextual

# A faster tuned+unseen slice that still yields a real Δ_g:
npm run bench:beir:matrix -- --provider=ollama --model=nomic-embed-text \
  --datasets=scifact,nfcorpus,fiqa,arguana,scidocs,webis-touche2020 \
  --modes=lexical,hybrid

# Then render the leaderboard across runs:
npm run bench:beir:leaderboard -- \
  --inputs=benchmarks/results/beir/matrix/beir-matrix.json \
  --output=benchmarks/results/beir/leaderboard.html
```

When the host is unreachable, supply each dataset via `--dataset-dir` from the
Hugging Face `BeIR` mirror (the same workaround used for the baselines), then
re-run the matrix per dataset and merge.
