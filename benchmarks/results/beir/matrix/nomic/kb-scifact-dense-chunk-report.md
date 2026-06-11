# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.491414
- precision@10: 0.069333
- MAP@100: 0.456433
- Recall@10: 0.610722
- Recall@100: 0.808333
- Query latency: p50 181.68816 ms, p95 209.37243 ms, p99 253.729882 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-scifact-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-scifact-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
