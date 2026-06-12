# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.29814
- precision@10: 0.062873
- MAP@100: 0.207997
- Recall@10: 0.628734
- Recall@100: 0.928876
- Query latency: p50 234.484198 ms, p95 317.692709 ms, p99 363.417603 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-arguana-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-arguana-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
