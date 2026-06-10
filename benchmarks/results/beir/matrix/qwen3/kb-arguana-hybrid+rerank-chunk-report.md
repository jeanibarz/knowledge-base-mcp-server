# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.332458
- precision@10: 0.070697
- MAP@100: 0.231793
- Recall@10: 0.70697
- Recall@100: 0.991465
- Query latency: p50 3954.312271 ms, p95 4803.01142 ms, p99 5050.277476 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-arguana-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-arguana-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
