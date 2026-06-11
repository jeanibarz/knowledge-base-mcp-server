# BEIR/economics local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: economics test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 50220
- Queries evaluated: 103
- nDCG@10: 0.118458
- precision@10: 0.061165
- MAP@100: 0.096225
- Recall@10: 0.135734
- Recall@100: 0.515307
- Query latency: p50 233.734262 ms, p95 284.980648 ms, p99 365.482011 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/nomic/kb-economics-dense-chunk-results.json
- TREC run: benchmarks/results/bright/nomic/kb-economics-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=economics --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/bright/nomic --dataset-dir=/tmp/kb-bright-datasets-3657609/economics
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
