# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.361382
- precision@10: 0.099074
- MAP@100: 0.30693
- Recall@10: 0.421974
- Recall@100: 0.709422
- Query latency: p50 508.716291 ms, p95 650.55002 ms, p99 760.544794 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-fiqa-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-fiqa-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
