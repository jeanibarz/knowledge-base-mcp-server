# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.179858
- precision@10: 0.126935
- MAP@100: 0.086521
- Recall@10: 0.094631
- Recall@100: 0.16559
- Query latency: p50 191.614698 ms, p95 570.347523 ms, p99 783.283503 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-nfcorpus-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-nfcorpus-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
