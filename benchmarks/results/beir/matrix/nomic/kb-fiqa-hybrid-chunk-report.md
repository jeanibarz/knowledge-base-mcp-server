# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.252554
- precision@10: 0.074228
- MAP@100: 0.206244
- Recall@10: 0.317238
- Recall@100: 0.587858
- Query latency: p50 5818.227322 ms, p95 6512.443521 ms, p99 6710.634725 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-fiqa-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-fiqa-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
