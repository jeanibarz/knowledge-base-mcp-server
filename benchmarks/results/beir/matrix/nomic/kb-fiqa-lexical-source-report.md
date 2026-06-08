# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: lexical (source)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.228174
- precision@10: 0.063117
- MAP@100: 0.18273
- Recall@10: 0.288506
- Recall@100: 0.504729
- Query latency: p50 382.070991 ms, p95 685.639289 ms, p99 932.806629 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-fiqa-lexical-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-fiqa-lexical-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=lexical --lexical-unit=source --output-dir=benchmarks/results/beir/matrix/nomic
```

Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.
