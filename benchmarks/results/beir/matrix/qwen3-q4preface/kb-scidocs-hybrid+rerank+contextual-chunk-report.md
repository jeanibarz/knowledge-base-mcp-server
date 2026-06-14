# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid+rerank+contextual (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.1778
- precision@10: 0.0943
- MAP@100: 0.123599
- Recall@10: 0.191067
- Recall@100: 0.432583
- Query latency: p50 6784.665365 ms, p95 18818.671763 ms, p99 26618.649932 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3-q4preface/kb-scidocs-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3-q4preface/kb-scidocs-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3-q4preface --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache-q4/scidocs-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
