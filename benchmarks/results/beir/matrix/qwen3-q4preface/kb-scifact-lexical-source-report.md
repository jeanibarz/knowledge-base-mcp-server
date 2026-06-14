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
- Query latency: p50 28.489056 ms, p95 51.185721 ms, p99 60.888389 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scifact-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scifact-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/qwen3
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
