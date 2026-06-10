# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.332185
- precision@10: 0.070413
- MAP@100: 0.231102
- Recall@10: 0.704125
- Recall@100: 0.975818
- Query latency: p50 3429.996934 ms, p95 4230.424125 ms, p99 4464.489785 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
