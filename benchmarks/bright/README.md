# BRIGHT — reasoning-intensive retrieval (RFC 020 §8, M3)

BRIGHT (Su et al., 2024) is a *reasoning-intensive* retrieval benchmark: the
query is a real, multi-sentence problem and the relevant documents are the ones
whose knowledge is **needed to reason to the answer**, not the ones that share
surface terms. Pure dense retrievers underperform on it and rerank / LLM-in-the-
loop helps — exactly the pipeline this project ships, so BRIGHT is where
`hybrid+rerank` should pull clearly ahead of a `dense` baseline.

This adapter runs BRIGHT through the **same runner seam** as BEIR. The only
BRIGHT-specific code is the format adapter (`adapter.ts`); retrieval, scoring,
and provenance are shared with BEIR by construction.

## Files

- `registry.ts` — the 12 official BRIGHT tasks grouped by domain + contamination notes.
- `adapter.ts` — converts BRIGHT (`documents` + `examples` with inline `gold_ids`)
  into a BEIR `--dataset-dir` (`corpus.jsonl` / `queries.jsonl` / `qrels/<split>.tsv`).
- `run.ts` — for each `(task × mode)`, materialises the task and runs `runBeirBenchmark`.
- `report.ts` — assembles per-`(task × mode)` nDCG@10, the per-mode mean, and the
  headline `hybrid+rerank − dense` Δ.

## BRIGHT vs BEIR format

| | BEIR | BRIGHT |
|---|---|---|
| corpus | `corpus.jsonl` `{_id, text}` | `documents` `{id, content}` |
| queries | `queries.jsonl` `{_id, text}` | `examples` `{id, query}` |
| qrels | separate `qrels/<split>.tsv` | inline `gold_ids[]` per example |
| extras | — | per-query `excluded_ids[]` |

The adapter turns each example's `gold_ids` into binary qrels (relevance 1).

### Scope note — `excluded_ids`

BRIGHT carries per-query `excluded_ids` (documents to drop from *that query's*
ranking before scoring — typically the query's own source page). Doc-level
scoring in `metrics.ts` is global, so the adapter **records** `excluded_ids` as
provenance but does **not** subtract them from the ranking. Reported numbers are
therefore a faithful local reproduction that can run slightly optimistic versus
the official BRIGHT harness on tasks where a query's own page would be excluded.
This is surfaced in the run report's caveats.

## Getting the data

A real BRIGHT run needs the BRIGHT task data and a real embedding model
(Ollama/OpenAI) — the deterministic `fake` provider has no semantic geometry and
is plumbing-only. BRIGHT is published on Hugging Face (`xlangai/BRIGHT`). Export
each task into the layout the loader expects:

```
<bright-dir>/<task>/documents.jsonl   # {"id": "...", "content": "..."}
<bright-dir>/<task>/examples.jsonl    # {"id": "...", "query": "...", "gold_ids": [...], "excluded_ids": [...]}
```

For example, with the `datasets` library:

```python
from datasets import load_dataset
import json, os

task = "biology"
out = f"bright-data/{task}"
os.makedirs(out, exist_ok=True)
docs = load_dataset("xlangai/BRIGHT", "documents", split=task)
exs  = load_dataset("xlangai/BRIGHT", "examples",  split=task)
with open(f"{out}/documents.jsonl", "w") as f:
    for r in docs:
        f.write(json.dumps({"id": r["id"], "content": r["content"]}) + "\n")
with open(f"{out}/examples.jsonl", "w") as f:
    for r in exs:
        f.write(json.dumps({
            "id": r["id"], "query": r["query"],
            "gold_ids": r["gold_ids"], "excluded_ids": r.get("excluded_ids", []),
        }) + "\n")
```

## Run

```bash
# dense vs hybrid+rerank on two tasks (the headline BRIGHT comparison):
npm run bench:bright -- --bright-dir=bright-data --tasks=biology,economics \
    --modes=dense,hybrid+rerank --provider=ollama --model=nomic-embed-text
```

Outputs `benchmarks/results/bright/bright-report.{json,md}`. A task that cannot
be loaded or whose run errors is recorded as a failed point and **excluded from
the mean** — the report never fabricates a number for a task that did not run.

## Status

The adapter, registry, runner, and report are landed and unit-tested (the seam is
verified end-to-end against the real BEIR runner on a fixture task). A real
BRIGHT run on the full task set with a production embedding model — recording
`hybrid+rerank` vs `dense` nDCG@10 per task — is **pending** the BRIGHT data +
an embedding model in an environment that has both. No BRIGHT numbers are
committed until that run; the report scaffold prints "No BRIGHT runs recorded
yet" until then.
