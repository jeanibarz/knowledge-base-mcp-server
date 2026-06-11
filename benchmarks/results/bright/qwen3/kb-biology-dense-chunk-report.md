# BEIR/biology local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: biology test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 57359
- Queries evaluated: 103
- nDCG@10: 0.159365
- precision@10: 0.079612
- MAP@100: 0.131578
- Recall@10: 0.187313
- Recall@100: 0.520997
- Query latency: p50 463.169141 ms, p95 626.534669 ms, p99 637.036229 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/qwen3/kb-biology-dense-chunk-results.json
- TREC run: benchmarks/results/bright/qwen3/kb-biology-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=biology --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/bright/qwen3 --dataset-dir=/tmp/kb-bright-datasets-119039/biology
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
