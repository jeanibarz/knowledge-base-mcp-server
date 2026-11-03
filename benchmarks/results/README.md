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

### Small-model committed runs (nomic / qwen3)

This section lists the committed dense small-model runs (RFC 020). All are local
reproducible runs, not official leaderboard submissions; every number is copied
verbatim from the cited artifact, and higher is better. The ranking metrics are
nDCG@10 (how well the top 10 results are ranked, 0–1), precision@10 (fraction of
the top 10 that are relevant) and recall@10 (fraction of relevant docs found in
the top 10).

**BEIR full matrix** — per-mode multi-domain mean nDCG@10 (and mean precision@10 /
recall@10) over the BEIR datasets each mode actually evaluated. The "Datasets"
column is `evaluated / requested`. Rows below `5 / 5` were averaged over a
different, smaller set of datasets, so **do not rank them against the
full-coverage rows** — here the `late` (2/5) and `hybrid+rerank+contextual` (3/5)
rows are the partial ones.

| Model | Mode | Datasets | mean nDCG@10 | mean P@10 | mean Recall@10 | Git SHA | Artifact |
| --- | --- | :---: | ---: | ---: | ---: | --- | --- |
| nomic-embed-text | lexical | 5 / 5 | 0.337237 | 0.102282 | 0.418372 | `04f3eb8` | [nomic/beir-matrix.json](beir/matrix/nomic/beir-matrix.json) |
| nomic-embed-text | dense | 5 / 5 | 0.254749 | 0.071497 | 0.342451 | `04f3eb8` | [nomic/beir-matrix.json](beir/matrix/nomic/beir-matrix.json) |
| nomic-embed-text | hybrid | 5 / 5 | 0.320355 | 0.095259 | 0.424606 | `04f3eb8` | [nomic/beir-matrix.json](beir/matrix/nomic/beir-matrix.json) |
| nomic-embed-text | hybrid+rerank | 5 / 5 | 0.376205 | 0.113552 | 0.455496 | `04f3eb8` | [nomic/beir-matrix.json](beir/matrix/nomic/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | lexical | 5 / 5 | 0.337237 | 0.102282 | 0.418372 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | dense | 5 / 5 | 0.373419 | 0.109534 | 0.473097 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | hybrid | 5 / 5 | 0.389288 | 0.118051 | 0.485382 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | hybrid+rerank | 5 / 5 | 0.386762 | 0.121001 | 0.468413 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | late | 2 / 5 | 0.422609 | 0.130450 | 0.419207 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | hybrid+late | 5 / 5 | 0.285347 | 0.086219 | 0.352187 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |
| Qwen3-Embedding-0.6B:Q8_0 | hybrid+rerank+contextual | 3 / 5 | 0.473401 | 0.143410 | 0.581220 | `869d527` | [qwen3/beir-matrix.json](beir/matrix/qwen3/beir-matrix.json) |

Lexical mode is model-independent (shared lexical index, no embedding model), so
both models report the same lexical row. Per-dataset cells, latency percentiles,
the generalization gap Δ_g, and the exact env (model IDs, RRF `c`, rerank
model/topN, chunk size/overlap) are in each `beir-matrix.json` and its sibling
`beir-matrix.md`.

**MTEB** — mean main score over the committed tasks (SciFact, NFCorpus), `mteb`
version 1.19.10. The MTEB "main score" for these two retrieval tasks is nDCG@10;
a 2-task mean is not comparable to published MTEB averages over dozens of tasks.
No run-embedded git SHA is recorded in these artifacts, so the column below is
the commit that added the artifact rather than a run revision.

| Model | mean (2 tasks) | SciFact | NFCorpus | Added in commit | Artifact |
| --- | ---: | ---: | ---: | --- | --- |
| nomic-embed-text | 0.353055 | 0.52408 | 0.18203 | `8cb4aa9` | [mteb/nomic.json](mteb/nomic.json) |
| Qwen3-Embedding-0.6B:Q8_0 | 0.487265 | 0.67752 | 0.29701 | `774d4be` | [mteb/qwen3.json](mteb/qwen3.json) |

**BRIGHT** — reasoning-intensive retrieval, mean nDCG@10 over 2 tasks (biology,
economics), test split.

| Model | dense | hybrid+rerank | Git SHA | Artifact |
| --- | ---: | ---: | --- | --- |
| nomic-embed-text | 0.1476 | 0.1293 | `abe8012` | [bright/nomic/bright-report.md](bright/nomic/bright-report.md) |
| Qwen3-Embedding-0.6B:Q8_0 | 0.1586 | 0.1309 | `ee23284` | [bright/qwen3/bright-report.md](bright/qwen3/bright-report.md) |

BRIGHT numbers carry an extra caveat recorded in each report: per-query
`excluded_ids` are kept for provenance but not subtracted from the ranking
(doc-level scoring is global), so they may run slightly optimistic versus the
official harness.

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
