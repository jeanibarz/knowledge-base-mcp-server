# BEIR/biology local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: biology test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 57359
- Queries evaluated: 103
- nDCG@10: 0.130812
- precision@10: 0.064078
- MAP@100: 0.114272
- Recall@10: 0.153299
- Recall@100: 0.610778
- Query latency: p50 4569.897794 ms, p95 6415.55582 ms, p99 7070.103181 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/qwen3/kb-biology-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/bright/qwen3/kb-biology-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=biology --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/bright/qwen3 --dataset-dir=/tmp/kb-bright-datasets-119039/biology
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
