# BEIR chunk-size sweep (dense, ollama/nomic-embed-text)

Real sweep over the CI subset, overlap fixed at 200, dense mode. nDCG@10 AND
precision@10 are reported — precision exposes the chunk-boundary <-> qrel-span
mismatch (an oversized chunk can hit the qrel doc while diluting the relevant
fraction of the top-10).

- git: 199f352  |  provider/model: ollama / nomic-embed-text  |  overlap: 200

## scifact (300 queries)

| chunk_size | nDCG@10 | precision@10 | Recall@10 |
|---|---|---|---|
| 500 | 0.4997 | 0.0727 | 0.6374 |
| 1000 | 0.4914 | 0.0693 | 0.6107 |
| 2000 | 0.5202 | 0.0733 | 0.6524 |

## nfcorpus (323 queries)

| chunk_size | nDCG@10 | precision@10 | Recall@10 |
|---|---|---|---|
| 500 | 0.1842 | 0.1310 | 0.0948 |
| 1000 | 0.1799 | 0.1269 | 0.0946 |
| 2000 | 0.1822 | 0.1254 | 0.0923 |

