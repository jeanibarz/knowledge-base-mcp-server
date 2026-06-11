# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid+late (provider: ollama, model: nomic-embed-text)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.117902
- precision@10: 0.0598
- MAP@100: 0.080268
- Recall@10: 0.12155
- Recall@100: 0.3164
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=4650921, index~1190635776 bytes, build 13566.174 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 4019.86149 ms, p95 4603.380555 ms, p99 4916.319228 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-scidocs-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-scidocs-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid+late --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
