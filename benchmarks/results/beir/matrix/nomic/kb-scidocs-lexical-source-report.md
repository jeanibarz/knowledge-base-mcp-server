# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: lexical (source)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.153652
- precision@10: 0.078
- MAP@100: 0.10612
- Recall@10: 0.158167
- Recall@100: 0.349333
- Query latency: p50 140.736026 ms, p95 224.704713 ms, p99 273.627924 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scidocs-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scidocs-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/nomic
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
