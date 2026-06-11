# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.689659
- precision@10: 0.092667
- MAP@100: 0.648101
- Recall@10: 0.820611
- Recall@100: 0.953333
- Query latency: p50 1125.93005 ms, p95 2291.597959 ms, p99 3193.470997 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scifact-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scifact-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
