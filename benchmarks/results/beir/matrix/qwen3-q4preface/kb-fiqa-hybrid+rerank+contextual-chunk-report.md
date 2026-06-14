# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid+rerank+contextual (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.374004
- precision@10: 0.104321
- MAP@100: 0.314798
- Recall@10: 0.450471
- Recall@100: 0.703244
- Query latency: p50 9814.528377 ms, p95 16687.003493 ms, p99 29755.114213 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3-q4preface/kb-fiqa-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3-q4preface/kb-fiqa-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3-q4preface --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache-q4/fiqa-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
