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
- Query latency: p50 338.491735 ms, p95 694.078928 ms, p99 932.247619 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-arguana-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-arguana-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/nomic
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
