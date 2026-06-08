# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: lexical (source)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.668981
- precision@10: 0.087
- MAP@100: 0.630274
- Recall@10: 0.792333
- Recall@100: 0.895889
- Query latency: p50 28.578336 ms, p95 53.561746 ms, p99 67.22877 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scifact-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scifact-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/nomic
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
