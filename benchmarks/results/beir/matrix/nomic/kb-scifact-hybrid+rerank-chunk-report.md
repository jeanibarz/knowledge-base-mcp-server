# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.705177
- precision@10: 0.093
- MAP@100: 0.662243
- Recall@10: 0.835278
- Recall@100: 0.921333
- Query latency: p50 2540.056224 ms, p95 3017.677501 ms, p99 3462.885951 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scifact-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scifact-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
