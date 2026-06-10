# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.111325
- precision@10: 0.0625
- MAP@100: 0.074194
- Recall@10: 0.1271
- Recall@100: 0.322517
- Query latency: p50 2965.150593 ms, p95 3468.975468 ms, p99 3890.974038 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-scidocs-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-scidocs-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
