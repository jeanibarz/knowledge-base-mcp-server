# BEIR/economics local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: economics test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 50220
- Queries evaluated: 103
- nDCG@10: 0.126332
- precision@10: 0.06699
- MAP@100: 0.117791
- Recall@10: 0.121169
- Recall@100: 0.551728
- Query latency: p50 5892.73568 ms, p95 7175.52093 ms, p99 7329.476653 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/nomic/kb-economics-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/bright/nomic/kb-economics-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=economics --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/bright/nomic --dataset-dir=/tmp/kb-bright-datasets-3657609/economics
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
