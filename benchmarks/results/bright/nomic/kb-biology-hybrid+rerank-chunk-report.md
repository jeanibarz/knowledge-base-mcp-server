# BEIR/biology local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: biology test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 57359
- Queries evaluated: 103
- nDCG@10: 0.132179
- precision@10: 0.063107
- MAP@100: 0.117805
- Recall@10: 0.168004
- Recall@100: 0.642038
- Query latency: p50 4339.989682 ms, p95 6392.51332 ms, p99 6911.390183 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/nomic/kb-biology-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/bright/nomic/kb-biology-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=biology --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/bright/nomic --dataset-dir=/tmp/kb-bright-datasets-3657609/biology
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
