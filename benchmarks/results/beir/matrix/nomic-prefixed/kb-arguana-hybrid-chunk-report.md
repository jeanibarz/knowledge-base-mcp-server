# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.366064
- precision@10: 0.07596
- MAP@100: 0.253524
- Recall@10: 0.759602
- Recall@100: 0.972973
- Query latency: p50 1410.19964 ms, p95 1788.454446 ms, p99 2064.187613 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-arguana-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-arguana-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
