# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: lexical (source)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.332901
- precision@10: 0.07091
- MAP@100: 0.226969
- Recall@10: 0.709104
- Recall@100: 0.945235
- Query latency: p50 263.311337 ms, p95 580.65441 ms, p99 812.712322 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
