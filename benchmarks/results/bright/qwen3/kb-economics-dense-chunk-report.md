# BEIR/economics local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: economics test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 50220
- Queries evaluated: 103
- nDCG@10: 0.157842
- precision@10: 0.072816
- MAP@100: 0.127646
- Recall@10: 0.166213
- Recall@100: 0.469201
- Query latency: p50 481.508213 ms, p95 612.680342 ms, p99 734.127276 ms

## Artifacts

- Metrics JSON: benchmarks/results/bright/qwen3/kb-economics-dense-chunk-results.json
- TREC run: benchmarks/results/bright/qwen3/kb-economics-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=economics --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/bright/qwen3 --dataset-dir=/tmp/kb-bright-datasets-119039/economics
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
