# Reranker upgrade and listwise reranking bakeoff (#579)

## Scope

This is a benchmark-first implementation report for the retrieval frontier
roadmap. It adds experimental reranker bakeoff modes, but does not change the
default production search behavior.

## Implemented benchmark surface

- `hybrid+listwise-rerank`: production hybrid candidates reordered by a
  QRRanker-style token-attention scorer over the top candidate set.
- `hybrid+hard-negative-rerank`: production hybrid candidates reordered by a
  lightweight simulated hard-negative boundary head over query/document
  features.
- `hybrid+adaptive-rerank`: same listwise scorer, but routed through a
  confidence/ambiguity gate that can skip rerank for low-ambiguity queries.
- `bench:beir:reranker-bakeoff`: diagnostic runner that compares hybrid
  baseline, current cross-encoder, optional Qwen3/Prism model overrides, and
  the benchmark-only rerankers. Qwen3/Prism rows are skipped unless
  `KB_RERANK_QWEN3_MODEL` or `KB_RERANK_PRISM_MODEL` is set to a locally
  available transformers.js-compatible reranker.

## #573 baseline availability

Committed #573 BEIR baselines are present only for SciFact plus the hermetic
gate fixture:

| Dataset | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Source |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| SciFact | lexical | 0.6690 | see JSON | 0.7923 | 0.8959 | `benchmarks/results/beir/baseline/scifact-lexical.json` |
| SciFact | dense | 0.4914 | see JSON | 0.6107 | 0.8083 | `benchmarks/results/beir/baseline/scifact-dense.json` |
| SciFact | hybrid | 0.6109 | see JSON | 0.7629 | 0.9213 | `benchmarks/results/beir/baseline/scifact-hybrid.json` |

No committed #573 no-rerank/hybrid baselines were found for ArguAna, SciDocs,
or HotpotQA/BRIGHT in this worktree. Cached BEIR-shaped datasets are available
locally under `$HOME/.cache/kb-beir-cache` for ArguAna and SciDocs, but a
real reranker bakeoff over those corpora would require rebuilding or reusing
real embedding indexes and, for cross-encoder/Qwen/Prism, locally cached or
downloadable reranker models. This report does not fabricate those rows.

## Diagnostic smoke run

The hermetic gate fixture is not quality evidence because it uses the `fake`
embedding provider, but it proves the report path, candidate accounting, and
reranker latency fields without network or model downloads.

Commands:

```bash
node build/benchmarks/beir/run.js --dataset=gate-fixture --dataset-dir=benchmarks/beir/fixtures/gate/gate-fixture --split=test --mode=hybrid --provider=fake --output-dir=/tmp/kb-beir-issue579-gate-hybrid --workspace-root=/tmp/kb-beir-issue579-gate-hybrid-ws --k=10 --chunk-k=40 --candidate-pool-k=40
node build/benchmarks/beir/run.js --dataset=gate-fixture --dataset-dir=benchmarks/beir/fixtures/gate/gate-fixture --split=test --mode=hybrid+listwise-rerank --provider=fake --output-dir=/tmp/kb-beir-issue579-gate-listwise --workspace-root=/tmp/kb-beir-issue579-gate-listwise-ws --k=10 --chunk-k=40 --candidate-pool-k=40
node build/benchmarks/beir/run.js --dataset=gate-fixture --dataset-dir=benchmarks/beir/fixtures/gate/gate-fixture --split=test --mode=hybrid+hard-negative-rerank --provider=fake --output-dir=/tmp/kb-beir-issue579-gate-hard --workspace-root=/tmp/kb-beir-issue579-gate-hard-ws --k=10 --chunk-k=40 --candidate-pool-k=40
node build/benchmarks/beir/run.js --dataset=gate-fixture --dataset-dir=benchmarks/beir/fixtures/gate/gate-fixture --split=test --mode=hybrid+adaptive-rerank --provider=fake --output-dir=/tmp/kb-beir-issue579-gate-adaptive --workspace-root=/tmp/kb-beir-issue579-gate-adaptive-ws --k=10 --chunk-k=40 --candidate-pool-k=40
```

Measured fixture results:

| Variant | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | p50 ms | p95 ms | Mean candidates in | Mean candidates reranked | Mean rerank latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid baseline | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 11.717 | 28.609 | n/a | n/a | n/a |
| listwise attention | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 10.815 | 31.895 | 12 | 12 | 3.236 |
| hard-negative head | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 7.654 | 33.833 | 12 | 12 | 0.540 |
| adaptive listwise | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 10.869 | 31.954 | 12 | 12 | 3.139 |

## Recommendation

No default reranker change should ship from this PR. The benchmark surface is
ready to run the diagnostic sample before any full matrix, but the only real
committed baseline currently available here is SciFact hybrid from #573. The
next real bakeoff should run:

```bash
npm run bench:beir:reranker-bakeoff -- --datasets=scifact,arguana,scidocs --provider=ollama --model=nomic-embed-text:latest --cache-dir=$HOME/.cache/kb-beir-cache --max-queries=<time-boxed sample>
```

For Qwen3/Prism reranker rows, set `KB_RERANK_QWEN3_MODEL` and/or
`KB_RERANK_PRISM_MODEL` to locally available reranker model ids first. Treat
model quality and latency/resource feasibility separately: deterministic
listwise/head rows are CPU-only prototypes, while cross-encoder/Qwen/Prism rows
must include model-load/cache state and per-candidate latency before promotion.
