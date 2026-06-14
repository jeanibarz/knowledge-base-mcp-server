# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid+rerank+contextual (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.35925
- precision@10: 0.258204
- MAP@100: 0.171016
- Recall@10: 0.170705
- Recall@100: 0.31925
- Query latency: p50 1263.611333 ms, p95 5525.104464 ms, p99 6077.542085 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3-q4preface/kb-nfcorpus-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3-q4preface/kb-nfcorpus-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3-q4preface --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache-q4/nfcorpus-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
