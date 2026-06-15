# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid+late (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.174139
- precision@10: 0.048148
- MAP@100: 0.138802
- Recall@10: 0.226855
- Recall@100: 0.463564
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=7534829, index~1928916224 bytes, build 24589.642 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 7481.238524 ms, p95 17836.134296 ms, p99 25422.859305 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-fiqa-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-fiqa-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid+late --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
