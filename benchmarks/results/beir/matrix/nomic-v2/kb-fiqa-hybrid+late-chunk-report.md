# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid+late (provider: ollama, model: nomic-embed-text)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.173053
- precision@10: 0.04784
- MAP@100: 0.138105
- Recall@10: 0.223717
- Recall@100: 0.455085
- Late interaction: rerank, model=hashed-token-maxsim-v1, vectors=7534829, index~1928916224 bytes, build 26047.74 ms
- Late interaction resources: CPU=CPU-only JavaScript prototype; no native ANN index; GPU=None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time
- Query latency: p50 6563.015339 ms, p95 8636.179065 ms, p99 9714.921359 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-fiqa-hybrid+late-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-fiqa-hybrid+late-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid+late --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
