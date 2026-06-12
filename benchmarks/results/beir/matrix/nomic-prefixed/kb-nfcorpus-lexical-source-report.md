# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: lexical (source)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.302477
- precision@10: 0.212384
- MAP@100: 0.137795
- Recall@10: 0.143751
- Recall@100: 0.237567
- Query latency: p50 1.428966 ms, p95 15.596919 ms, p99 18.668378 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-nfcorpus-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-nfcorpus-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
