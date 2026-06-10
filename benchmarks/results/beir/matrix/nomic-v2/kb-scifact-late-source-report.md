# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: late (source)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.589224
- precision@10: 0.077
- MAP@100: 0.552659
- Recall@10: 0.708056
- Recall@100: 0.841556
- Late interaction: standalone, model=hashed-token-maxsim-v1, vectors=1154898, index~295653888 bytes, build 2896.496 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 2165.964255 ms, p95 4271.19452 ms, p99 4981.864512 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-scifact-late-source-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-scifact-late-source-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=late --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Late mode requires no provider credentials. The runner builds a temporary KB corpus, indexes per-document token vectors in the benchmark adapter, and maps MaxSim hits to BEIR document IDs for scoring.
