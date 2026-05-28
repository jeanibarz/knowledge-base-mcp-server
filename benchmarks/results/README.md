# Benchmark Results

This directory contains public-facing benchmark summaries and selected archived
artifacts for `kb`. These are local reproducible benchmark runs, not official
leaderboard submissions.

## Current Matrix

| Dataset | Split | Mode | Ranking unit | Git SHA | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | p50 / p95 latency |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| BEIR/SciFact | test | lexical | source | `fc3d45d` + this branch | 0.668981 | 0.630274 | 0.792333 | 0.895889 | 19.90 / 33.25 ms |

Artifacts for the SciFact run:

- [metrics JSON](beir/scifact-lexical-source-2026-05-28/kb-scifact-lexical-source-results.json)
- [TREC run file](beir/scifact-lexical-source-2026-05-28/kb-scifact-lexical-source-run.trec)
- [per-run Markdown report](beir/scifact-lexical-source-2026-05-28/kb-scifact-lexical-source-report.md)

Reproduce the run:

```bash
npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/scifact-lexical-source-2026-05-28
```

The archived run used the built `kb` lexical index implementation, Node
`v24.11.1`, Python `3.10.12`, Linux x64, and the BEIR SciFact zip checksum
recorded in the JSON artifact. Lexical source mode requires no provider
credentials and is also exposed by the CLI as:

```bash
kb search "query" --mode=lexical --lexical-unit=source
```

## Public Baselines

The BEIR paper defines BEIR as a heterogeneous benchmark spanning 18 datasets
and reports nDCG@10 as its headline retrieval metric:
<https://arxiv.org/abs/2104.08663>.

The SciFact dataset card describes the corpus/query/qrels shape used by this
runner: <https://huggingface.co/datasets/BeIR/scifact-qrels>.

For SciFact BM25, published references commonly report about `0.665` nDCG@10:

- Vespa's BEIR BM25 comparison lists SciFact BM25 at `0.665` and a tuned Vespa
  BM25 run at `0.673`:
  <https://blog.vespa.ai/improving-zero-shot-ranking-with-vespa-part-two/>
- The BEIR OpenReview paper table also lists SciFact BM25 at `0.665`:
  <https://openreview.net/pdf?id=wCu6T5xFjeJ>

The local `kb` lexical-source run is therefore competitive with the public BM25
reference band on SciFact, but it should still be described as a local run until
the runner is validated against official BEIR tooling and submission workflow.

## Caveats

- Scores are BEIR document-level metrics. `--lexical-unit=source` ranks whole
  source files and returns the best representative chunk per source; plain
  chunk ranking remains available with `--lexical-unit=chunk`.
- Latency is measured in-process inside the benchmark runner. It excludes
  `kb` CLI process startup, argument parsing, pager handling, and stdout
  formatting overhead.
- The TREC file is suitable for external scoring tools, but this repository has
  not claimed an official BEIR leaderboard submission.
- The benchmark corpus is BEIR-shaped Markdown generated into a temporary KB.
  It exercises the same lexical index code as the CLI, but not dense provider
  setup, daemon mode, or human-authored KB frontmatter diversity.

## Highest-Impact Next Work

1. Extend the matrix beyond SciFact with NFCorpus and FiQA using the same
   `--lexical-unit=source` path.
2. Replay Optuna chunking/tuning on source mode and commit only portable replay
   configs that improve multiple datasets or explain dataset-specific tradeoffs.
3. Add credentialed hybrid runs once dense model setup is scripted, then compare
   lexical, dense, hybrid, and reranked modes under the same report format.
