# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid+late (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.260626
- precision@10: 0.187616
- MAP@100: 0.119122
- Recall@10: 0.126272
- Recall@100: 0.251564
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=873966, index~223735296 bytes, build 2434.8 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 1117.456327 ms, p95 2191.364157 ms, p99 2757.970177 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid+late --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
