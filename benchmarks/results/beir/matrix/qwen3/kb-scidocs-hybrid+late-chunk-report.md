# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid+late (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.11823
- precision@10: 0.0601
- MAP@100: 0.08061
- Recall@10: 0.12215
- Recall@100: 0.320983
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=4650921, index~1190635776 bytes, build 14351.121 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 4096.709972 ms, p95 6203.154233 ms, p99 6917.594485 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scidocs-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scidocs-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid+late --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
