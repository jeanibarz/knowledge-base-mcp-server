# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.349213
- precision@10: 0.094599
- MAP@100: 0.288163
- Recall@10: 0.412808
- Recall@100: 0.587858
- Query latency: p50 8151.282326 ms, p95 14274.328977 ms, p99 25747.581822 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-fiqa-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-fiqa-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
