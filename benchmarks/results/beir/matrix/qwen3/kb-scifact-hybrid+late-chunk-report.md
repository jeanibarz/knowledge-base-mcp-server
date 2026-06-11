# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid+late (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.59552
- precision@10: 0.078333
- MAP@100: 0.560047
- Recall@10: 0.716667
- Recall@100: 0.871
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=1154898, index~295653888 bytes, build 4679.528 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 1904.615265 ms, p95 3153.718062 ms, p99 3725.795739 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scifact-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scifact-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid+late --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
