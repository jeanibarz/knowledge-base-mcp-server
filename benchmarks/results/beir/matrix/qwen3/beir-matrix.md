# BEIR full-matrix sweep

Local BEIR matrix run, not an official leaderboard submission. The headline
is the per-mode **multi-domain mean nDCG@10** — averaging across domains is
the anti-overfitting metric (RFC 020 §2/§6).

- Generated: 2026-06-09T06:13:19.630Z
- Commit: `9d07388`
- Embedding: ollama / dengcao/Qwen3-Embedding-0.6B:Q8_0
- RRF c=60, rerank=Xenova/ms-marco-MiniLM-L-6-v2 topN=40, chunk=1000/200, contextual=off

## Headline — multi-domain mean nDCG@10

| Mode | datasets | mean nDCG@10 | mean P@10 | mean R@10 |
| --- | ---: | ---: | ---: | ---: |
| lexical | 4/4 | 0.3645 | 0.1121 | 0.4508 |
| dense | 4/4 | 0.3764 | 0.1121 | 0.4859 |
| hybrid | 4/4 | 0.4004 | 0.1235 | 0.5020 |
| hybrid+rerank | 4/4 | 0.3907 | 0.1254 | 0.4737 |

## Per-(dataset × mode) nDCG@10

| dataset | lexical | dense | hybrid | hybrid+rerank |
| --- | --- | --- | --- | --- |
| scifact | 0.6690 | 0.6413 | 0.6897 | 0.7054 |
| nfcorpus | 0.3025 | 0.2457 | 0.3167 | 0.3528 |
| arguana | 0.3329 | 0.4630 | 0.4294 | 0.3325 |
| scidocs | 0.1537 | 0.1557 | 0.1659 | 0.1721 |

## Per-domain breakdown & Δ_g (generalization, §6)

Δ_g = (seen − unseen) / seen. Seen (tuned): scifact, nfcorpus, fiqa. Unseen (reserved): arguana, scidocs, webis-touche2020.

| Mode | seen mean nDCG@10 | unseen mean nDCG@10 | Δ_g |
| --- | ---: | ---: | ---: |
| lexical | 0.4857 | 0.2433 | +49.92% |
| dense | 0.4435 | 0.3093 | +30.26% |
| hybrid | 0.5032 | 0.2977 | +40.85% |
| hybrid+rerank | 0.5291 | 0.2523 | +52.32% |

### lexical — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3329 | 0.0709 |
| bio-medical | nfcorpus | 0.3025 | 0.2124 |
| scientific citation | scidocs | 0.1537 | 0.0780 |
| scientific fact-checking | scifact | 0.6690 | 0.0870 |

### dense — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.4630 | 0.0893 |
| bio-medical | nfcorpus | 0.2457 | 0.1913 |
| scientific citation | scidocs | 0.1557 | 0.0786 |
| scientific fact-checking | scifact | 0.6413 | 0.0893 |

### hybrid — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.4294 | 0.0851 |
| bio-medical | nfcorpus | 0.3167 | 0.2291 |
| scientific citation | scidocs | 0.1659 | 0.0869 |
| scientific fact-checking | scifact | 0.6897 | 0.0927 |

### hybrid+rerank — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3325 | 0.0707 |
| bio-medical | nfcorpus | 0.3528 | 0.2474 |
| scientific citation | scidocs | 0.1721 | 0.0897 |
| scientific fact-checking | scifact | 0.7054 | 0.0940 |

## Contamination notes (§6.6)

| Dataset | known-in-pretraining | qrels | note |
| --- | --- | --- | --- |
| scifact | no | expert | Expert (scientist) claim↔evidence annotations; small corpus, low pretraining-leakage risk. |
| nfcorpus | no | expert | Medical nutrition queries with expert/relevance-graded links; niche corpus, low leakage risk. |
| arguana | no | crowdsourced | Counter-argument retrieval; query IS a full argument. Distinct task shape from QA — held out for Δ_g. |
| scidocs | no | automatic | Citation/co-read prediction; relevance derived from citation graph (automatic). Held out for Δ_g. |
