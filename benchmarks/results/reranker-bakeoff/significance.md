# Reranker significance (paired bootstrap, per dataset, Holm within each family)

### Each reranker vs plain hybrid

#### Retrieval significance comparison (family)

Correction: holm across 14 comparison(s) at α=0.05

| Comparison | n | Mean Δ | raw p | adj p | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| minilm-l6 vs hybrid (scifact) | 300 | +0.0159 | 0.2604 | 0.5208 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| minilm-l6 vs hybrid (nfcorpus) | 323 | +0.0416 | <0.0001 | <0.0001 | IMPROVEMENT |
| minilm-l6 vs hybrid (arguana) | 300 | -0.0694 | <0.0001 | <0.0001 | REGRESSION |
| mxbai-xsmall-v1 vs hybrid (nfcorpus) | 323 | +0.0351 | <0.0001 | 0.0001 | IMPROVEMENT |
| jina-v1-turbo-en vs hybrid (nfcorpus) | 323 | +0.0263 | 0.0012 | 0.0087 | IMPROVEMENT |
| bge-base vs hybrid (scifact) | 300 | -0.0094 | 0.4968 | 0.5208 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| bge-base vs hybrid (nfcorpus) | 323 | +0.0194 | 0.0100 | 0.0502 | NO-SIGNIFICANT-CHANGE |
| bge-base vs hybrid (arguana) | 300 | -0.1573 | <0.0001 | <0.0001 | REGRESSION |
| mxbai-base-v1 vs hybrid (scifact) | 300 | +0.0212 | 0.1412 | 0.4236 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| mxbai-base-v1 vs hybrid (nfcorpus) | 323 | +0.0475 | <0.0001 | <0.0001 | IMPROVEMENT |
| mxbai-base-v1 vs hybrid (arguana) | 300 | -0.2070 | <0.0001 | <0.0001 | REGRESSION |
| bge-v2-m3-fp16 vs hybrid (scifact) | 300 | +0.0423 | 0.0060 | 0.0360 | IMPROVEMENT |
| bge-v2-m3-fp16 vs hybrid (nfcorpus) | 323 | +0.0387 | <0.0001 | <0.0001 | IMPROVEMENT |
| bge-v2-m3-fp16 vs hybrid (arguana) | 300 | -0.0405 | 0.0145 | 0.0581 | NO-SIGNIFICANT-CHANGE |

Non-significant rows are reported, not failed (RFC 020 §3/§4).

### Each reranker vs the MiniLM-L6 baseline reranker

#### Retrieval significance comparison (family)

Correction: holm across 11 comparison(s) at α=0.05

| Comparison | n | Mean Δ | raw p | adj p | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| mxbai-xsmall-v1 vs minilm-l6 (nfcorpus) | 323 | -0.0066 | 0.2734 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| jina-v1-turbo-en vs minilm-l6 (nfcorpus) | 323 | -0.0153 | 0.0031 | 0.0247 | REGRESSION |
| bge-base vs minilm-l6 (scifact) | 300 | -0.0253 | 0.0207 | 0.1450 | NO-SIGNIFICANT-CHANGE |
| bge-base vs minilm-l6 (nfcorpus) | 323 | -0.0223 | 0.0001 | 0.0013 | REGRESSION |
| bge-base vs minilm-l6 (arguana) | 300 | -0.0878 | <0.0001 | <0.0001 | REGRESSION |
| mxbai-base-v1 vs minilm-l6 (scifact) | 300 | +0.0053 | 0.6830 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| mxbai-base-v1 vs minilm-l6 (nfcorpus) | 323 | +0.0059 | 0.2746 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| mxbai-base-v1 vs minilm-l6 (arguana) | 300 | -0.1376 | <0.0001 | <0.0001 | REGRESSION |
| bge-v2-m3-fp16 vs minilm-l6 (scifact) | 300 | +0.0264 | 0.0290 | 0.1742 | NO-SIGNIFICANT-CHANGE |
| bge-v2-m3-fp16 vs minilm-l6 (nfcorpus) | 323 | -0.0029 | 0.5944 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| bge-v2-m3-fp16 vs minilm-l6 (arguana) | 300 | +0.0289 | 0.1052 | 0.5259 | INCONCLUSIVE-BELOW-NOISE-FLOOR |

Non-significant rows are reported, not failed (RFC 020 §3/§4).
