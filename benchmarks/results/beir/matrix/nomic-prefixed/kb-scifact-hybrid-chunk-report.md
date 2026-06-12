# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.615787
- precision@10: 0.084667
- MAP@100: 0.571983
- Recall@10: 0.762944
- Recall@100: 0.924
- Query latency: p50 784.021196 ms, p95 899.136445 ms, p99 949.752639 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-scifact-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-scifact-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
