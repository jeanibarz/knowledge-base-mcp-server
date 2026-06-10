# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.429398
- precision@10: 0.085135
- MAP@100: 0.302257
- Recall@10: 0.851351
- Recall@100: 0.991465
- Query latency: p50 1404.726092 ms, p95 1883.254413 ms, p99 2989.567868 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-arguana-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-arguana-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
