# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid+late (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.278218
- precision@10: 0.056899
- MAP@100: 0.196807
- Recall@10: 0.56899
- Recall@100: 0.815789
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=1441639, index~369059584 bytes, build 4106.665 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 6143.859967 ms, p95 13216.515608 ms, p99 21773.106406 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-arguana-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-arguana-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid+late --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
