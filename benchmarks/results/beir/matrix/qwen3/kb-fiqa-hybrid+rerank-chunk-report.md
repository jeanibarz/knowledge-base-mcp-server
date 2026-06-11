# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.371084
- precision@10: 0.103241
- MAP@100: 0.312119
- Recall@10: 0.447203
- Recall@100: 0.702286
- Query latency: p50 12790.591069 ms, p95 15252.627786 ms, p99 16174.032084 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-fiqa-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-fiqa-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
