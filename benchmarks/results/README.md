# Benchmark Results

This directory contains public-facing benchmark summaries and selected archived
artifacts for `kb`. These are local reproducible benchmark runs, not official
leaderboard submissions.

## Current Matrix

| Dataset | Split | Mode | Ranking unit | Branch/run | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | p50 / p95 latency |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| BEIR/SciFact | test | lexical | document BM25 | `issue-508-beir-suite` at `c8fe767` | 0.667810 | 0.628277 | 0.790111 | 0.881889 | 6.55 / 11.44 ms |

Artifacts for the SciFact run:

- [metrics JSON](beir/scifact-lexical-document-2026-05-28/results.json)
- [TREC run file](beir/scifact-lexical-document-2026-05-28/run.trec)
- [per-run Markdown report](beir/scifact-lexical-document-2026-05-28/run-report.md)

Reproduce the run:

```bash
npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --lexical-unit=document --output-dir=benchmarks/results/beir/scifact-lexical-document-2026-05-28
```

The archived run used Node `v24.11.1`, Python `3.10.12`, Linux x64, and the
BEIR SciFact zip checksum recorded in the JSON artifact. Lexical document mode
requires no provider credentials.

## Public Baselines

The BEIR paper introduced the heterogeneous retrieval benchmark and reports
all scores as nDCG@10 across datasets: <https://arxiv.org/abs/2104.08663>.
The SciFact dataset card lists the corpus and query shape used by this runner:
<https://huggingface.co/datasets/BeIR/scifact>.

For SciFact BM25, published references commonly report about `0.665` nDCG@10:

- MedCPT's biomedical BEIR table lists BM25 on SciFact at `0.665`:
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC12478430/>
- Vespa's BEIR BM25 comparison lists SciFact BM25 at `0.665` and a tuned
  Vespa BM25 run at `0.673`:
  <https://blog.vespa.ai/improving-zero-shot-ranking-with-vespa-part-two/>

The local `kb` document-BM25 run is therefore competitive with the public BM25
reference band on SciFact, but it should still be described as a local run
until the runner is validated against the official BEIR tooling and submission
workflow.

## Caveats

- The current reported lexical result is from the stacked #508 branch, not from
  `main` yet. PR #512 must land before this can be treated as the main-branch
  lexical report.
- The `document` lexical unit is benchmark-only BM25 over BEIR title and text
  fields. It does not change normal `kb search --mode=lexical`, which returns
  chunks.
- The `chunk` lexical unit remains available for CLI-path parity; its document
  scores collapse chunk hits by BEIR document id, so chunk-vs-document claims
  must stay explicit.
- Latency is measured in-process inside the benchmark runner. It excludes
  `kb` CLI process startup, argument parsing, and stdout formatting overhead.
- The TREC file is suitable for external scoring tools, but this repository has
  not yet claimed an official BEIR leaderboard submission.

## Highest-Impact Next Work

1. Land [#508](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/508)
   so the competitive document-level lexical path is available from `main`.
2. Replay [#509](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/509)
   tuning on SciFact and add the best replayable config to this report.
3. Extend the matrix beyond SciFact with NFCorpus and a credentialed hybrid
   run after the BEIR runner and optional observability path from
   [#507](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/507)
   are stable on `main`.
