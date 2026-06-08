# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.610915
- precision@10: 0.085
- MAP@100: 0.566212
- Recall@10: 0.762944
- Recall@100: 0.921333
- Query latency: p50 1016.822507 ms, p95 1175.897199 ms, p99 1261.515167 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scifact-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scifact-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
