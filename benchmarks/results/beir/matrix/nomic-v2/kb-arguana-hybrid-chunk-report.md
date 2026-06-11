# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.378284
- precision@10: 0.078094
- MAP@100: 0.261959
- Recall@10: 0.780939
- Recall@100: 0.975818
- Query latency: p50 1166.76419 ms, p95 1412.896399 ms, p99 1541.840714 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
