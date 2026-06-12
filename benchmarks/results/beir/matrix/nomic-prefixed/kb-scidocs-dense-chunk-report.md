# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.054317
- precision@10: 0.027
- MAP@100: 0.036802
- Recall@10: 0.0554
- Recall@100: 0.131467
- Query latency: p50 258.598533 ms, p95 343.878025 ms, p99 401.584995 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-scidocs-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-scidocs-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
