# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.323098
- precision@10: 0.067283
- MAP@100: 0.226301
- Recall@10: 0.672831
- Recall@100: 0.950925
- Query latency: p50 267.893143 ms, p95 632.434012 ms, p99 809.603675 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-arguana-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-arguana-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
