# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.172109
- precision@10: 0.0897
- MAP@100: 0.119318
- Recall@10: 0.181967
- Recall@100: 0.413933
- Query latency: p50 5256.18211 ms, p95 6150.951688 ms, p99 6841.125789 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scidocs-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scidocs-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
