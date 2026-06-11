# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid+late (provider: ollama, model: nomic-embed-text)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.260913
- precision@10: 0.187926
- MAP@100: 0.118441
- Recall@10: 0.126499
- Recall@100: 0.246055
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=873966, index~223735296 bytes, build 2056.261 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 740.85132 ms, p95 922.988734 ms, p99 1017.439258 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid+late --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
