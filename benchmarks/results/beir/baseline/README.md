# BEIR CI-subset baselines (RFC 020 §4, milestone M0)

This directory holds the committed BEIR baselines for the CI subset
(**SciFact, NFCorpus, FiQA-2018**), one JSON report per `(dataset × mode)`:

```
<dataset>-<mode>.json     e.g. scifact-hybrid.json, scifact-lexical.json
```

Each file is the full `benchmarks/beir/run.ts` report, which is self-describing:
it carries the commit (`git_sha`), the runtime (`runtime`), the embedding
provider/model (`embedding`), and the chunking (`chunking`) that produced it, so
any third party can reproduce the number from commit + env (the RFC §7
reproducibility contract). Baseline updates are an **explicit, reviewed commit**
(`chore(bench): update BEIR baseline`), never automatic — the same discipline as
the latency budget baselines.

## Acceptance metric (M0)

> SciFact `hybrid` nDCG@10 recorded and **> lexical 0.669** by a significant
> margin; chunk-size sensitivity curve recorded on ≥2 CI datasets.

The only baseline recorded before this milestone was pure BM25
(`../scifact-lexical-source-2026-05-28/`, SciFact nDCG@10 = **0.669**).

## Status: real-corpus baseline run is PENDING ⚠️

The harness (dense + hybrid modes via the production `src/` paths, the
chunk-size sweep, and this baseline recorder) is landed and unit-tested with the
deterministic `fake` provider. **The real-corpus numbers are not yet recorded**
because the environment this was implemented in had no network access to the
BEIR dataset host (`public.ukp.informatik.tu-darmstadt.de` did not resolve), so
the SciFact / NFCorpus / FiQA corpora could not be downloaded.

No benchmark number has been fabricated or hardcoded. The `fake` provider is a
deterministic hash-bag with **no semantic geometry**, so its scores are plumbing
smoke only and are deliberately NOT committed here as a baseline.

## How to record the real baselines

On a machine with a local Ollama daemon (the project's default embedding model
is `nomic-embed-text`) and network access to the BEIR datasets:

```bash
# Lexical + hybrid baselines for the CI subset (downloads datasets on first run):
npm run bench:beir:baseline -- \
  --provider=ollama --model=nomic-embed-text --modes=lexical,hybrid

# Chunk-size / overlap sensitivity sweep (Tier-0), CI subset, real model:
npm run bench:beir:sweep -- \
  --provider=ollama --model=nomic-embed-text --datasets=scifact,nfcorpus,fiqa
```

The sweep writes its curve (nDCG@10 **and** precision@10, rows = chunk size,
columns = overlap) to `../chunk-sweep/`. Then review the resulting JSON/MD,
confirm SciFact `hybrid` nDCG@10 clears the 0.669 BM25 bar, and commit the
updated baseline files here.
