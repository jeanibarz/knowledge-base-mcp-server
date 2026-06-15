# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.64135
- precision@10: 0.089333
- MAP@100: 0.59661
- Recall@10: 0.786444
- Recall@100: 0.918333
- Query latency: p50 448.16384 ms, p95 544.691582 ms, p99 578.918325 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scifact-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scifact-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
