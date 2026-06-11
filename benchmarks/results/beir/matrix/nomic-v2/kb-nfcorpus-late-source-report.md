# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: late (source)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.255994
- precision@10: 0.183901
- MAP@100: 0.116536
- Recall@10: 0.130358
- Recall@100: 0.227522
- Late interaction: standalone, model=hashed-token-maxsim-v1, vectors=873966, index~223735296 bytes, build 2114.401 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 446.516633 ms, p95 1433.688252 ms, p99 2107.812469 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-late-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-late-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=late --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Late mode requires no provider credentials. The runner builds a temporary KB corpus, indexes per-document token vectors in the benchmark adapter, and maps MaxSim hits to BEIR document IDs for scoring.
