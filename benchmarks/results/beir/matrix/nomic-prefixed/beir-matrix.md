# BEIR full-matrix sweep

Local BEIR matrix run, not an official leaderboard submission. The headline
is the per-mode **multi-domain mean nDCG@10** — averaging across domains is
the anti-overfitting metric (RFC 020 §2/§6).

- Generated: 2026-06-12T02:48:12.423Z
- Commit: `726a4cb`
- Embedding: ollama / nomic-embed-text
- RRF c=60, rerank=Xenova/ms-marco-MiniLM-L-6-v2 topN=40, chunk=1000/200, contextual=off

## Headline — multi-domain mean nDCG@10

| Mode | datasets | mean nDCG@10 | mean P@10 | mean R@10 |
| --- | ---: | ---: | ---: | ---: |
| lexical | 5/5 | 0.3372 | 0.1023 | 0.4184 |
| dense | 5/5 | 0.2478 | 0.0705 | 0.3293 |
| hybrid | 5/5 | 0.3188 | 0.0943 | 0.4200 |

## Per-(dataset × mode) nDCG@10

| dataset | lexical | dense | hybrid |
| --- | --- | --- | --- |
| scifact | 0.6690 | 0.4793 | 0.6158 |
| nfcorpus | 0.3025 | 0.1834 | 0.2474 |
| arguana | 0.3329 | 0.2981 | 0.3661 |
| scidocs | 0.1537 | 0.0543 | 0.1059 |
| fiqa | 0.2282 | 0.2240 | 0.2586 |

## Per-domain breakdown & Δ_g (generalization, §6)

Δ_g = (seen − unseen) / seen. Seen (tuned): scifact, nfcorpus, fiqa. Unseen (reserved): arguana, scidocs, webis-touche2020.

| Mode | seen mean nDCG@10 | unseen mean nDCG@10 | Δ_g |
| --- | ---: | ---: | ---: |
| lexical | 0.3999 | 0.2433 | +39.16% |
| dense | 0.2955 | 0.1762 | +40.37% |
| hybrid | 0.3739 | 0.2360 | +36.89% |

### lexical — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3329 | 0.0709 |
| bio-medical | nfcorpus | 0.3025 | 0.2124 |
| finance | fiqa | 0.2282 | 0.0631 |
| scientific citation | scidocs | 0.1537 | 0.0780 |
| scientific fact-checking | scifact | 0.6690 | 0.0870 |

### dense — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.2981 | 0.0629 |
| bio-medical | nfcorpus | 0.1834 | 0.1300 |
| finance | fiqa | 0.2240 | 0.0636 |
| scientific citation | scidocs | 0.0543 | 0.0270 |
| scientific fact-checking | scifact | 0.4793 | 0.0690 |

### hybrid — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3661 | 0.0760 |
| bio-medical | nfcorpus | 0.2474 | 0.1777 |
| finance | fiqa | 0.2586 | 0.0741 |
| scientific citation | scidocs | 0.1059 | 0.0592 |
| scientific fact-checking | scifact | 0.6158 | 0.0847 |

## Contamination notes (§6.6)

| Dataset | known-in-pretraining | qrels | note |
| --- | --- | --- | --- |
| scifact | no | expert | Expert (scientist) claim↔evidence annotations; small corpus, low pretraining-leakage risk. |
| nfcorpus | no | expert | Medical nutrition queries with expert/relevance-graded links; niche corpus, low leakage risk. |
| arguana | no | crowdsourced | Counter-argument retrieval; query IS a full argument. Distinct task shape from QA — held out for Δ_g. |
| scidocs | no | automatic | Citation/co-read prediction; relevance derived from citation graph (automatic). Held out for Δ_g. |
| fiqa | no | crowdsourced | Financial opinion QA over StackExchange/forum text; crowdsourced relevance. |
