# BEIR/economics local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: economics test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 50220
- Queries evaluated: 103
- nDCG@10: 0.130916
- precision@10: 0.065049
- MAP@100: 0.124919
- Recall@10: 0.138796
- Recall@100: 0.566398
- Query latency: p50 5660.383103 ms, p95 6772.801446 ms, p99 7006.155441 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/qwen3/kb-economics-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/bright/qwen3/kb-economics-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=economics --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/bright/qwen3 --dataset-dir=/tmp/kb-bright-datasets-119039/economics
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
