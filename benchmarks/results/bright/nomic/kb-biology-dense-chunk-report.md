# BEIR/biology local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: biology test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 57359
- Queries evaluated: 103
- nDCG@10: 0.176666
- precision@10: 0.078641
- MAP@100: 0.153651
- Recall@10: 0.225285
- Recall@100: 0.609022
- Query latency: p50 226.891518 ms, p95 320.995662 ms, p99 400.144466 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/nomic/kb-biology-dense-chunk-results.json
- TREC run: benchmarks/results/bright/nomic/kb-biology-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=biology --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/bright/nomic --dataset-dir=/tmp/kb-bright-datasets-3657609/biology
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
