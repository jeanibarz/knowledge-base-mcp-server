# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.165492
- precision@10: 0.0856
- MAP@100: 0.107504
- Recall@10: 0.173667
- Recall@100: 0.322517
- Query latency: p50 7521.021484 ms, p95 9338.405225 ms, p99 10282.267859 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scidocs-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scidocs-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
