# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.155659
- precision@10: 0.0786
- MAP@100: 0.10242
- Recall@10: 0.1597
- Recall@100: 0.353867
- Query latency: p50 503.308065 ms, p95 721.848151 ms, p99 1201.542601 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scidocs-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scidocs-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
