# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.055911
- precision@10: 0.0285
- MAP@100: 0.038421
- Recall@10: 0.058633
- Recall@100: 0.1402
- Query latency: p50 231.730271 ms, p95 683.449566 ms, p99 1194.628189 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scidocs-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scidocs-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
