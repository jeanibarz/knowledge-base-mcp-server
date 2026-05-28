# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.668981
- MAP@100: 0.630274
- Recall@10: 0.792333
- Recall@100: 0.895889
- Query latency: p50 19.899256 ms, p95 33.248942 ms, p99 39.542351 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/scifact-lexical-source-2026-05-28/kb-scifact-lexical-source-results.json
- TREC run: benchmarks/results/beir/scifact-lexical-source-2026-05-28/kb-scifact-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/scifact-lexical-source-2026-05-28
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
