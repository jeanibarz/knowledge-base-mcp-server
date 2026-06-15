# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.705375
- precision@10: 0.094
- MAP@100: 0.662649
- Recall@10: 0.835778
- Recall@100: 0.953333
- Query latency: p50 2637.581448 ms, p95 3604.776173 ms, p99 5996.33873 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scifact-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scifact-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
