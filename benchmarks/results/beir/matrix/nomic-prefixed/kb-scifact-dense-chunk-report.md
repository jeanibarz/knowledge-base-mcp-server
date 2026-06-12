# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.479258
- precision@10: 0.069
- MAP@100: 0.44337
- Recall@10: 0.604056
- Recall@100: 0.794333
- Query latency: p50 231.604251 ms, p95 372.484514 ms, p99 7966.44337 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-scifact-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-scifact-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
