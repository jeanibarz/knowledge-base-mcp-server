# MTEB submission — embedding-model rank

RFC 020 §8 (milestone M4). MTEB ranks the **embedding model**, not the kb
retrieval pipeline (the BEIR matrix is the pipeline result). The path is to run
the official `mteb` package against the active embedding model and, if the
result is competitive, open the leaderboard PR.

## Pieces

- `mteb_submit.py` (in `benchmarks/`) — the runner. Imports `mteb` only when
  invoked (same discipline as `optuna_tune.py`), resolves the embedding model id
  from the kb provider env (mirrors `src/config/provider.ts`), runs the tasks,
  and folds the per-task results into one JSON record.
- `registry.ts` — maps the kb provider+model to the canonical MTEB/HF model id.
  The default is the Ollama `dengcao/Qwen3-Embedding-0.6B:Q8_0` build, ranked as
  upstream `Qwen/Qwen3-Embedding-0.6B` (RFC 013 default).
- `result.ts` — parses the `mteb` JSON into the canonical record + markdown.
- `run.ts` — records the result, renders the report, and logs the §7 MLflow
  ledger entry.

## Running

```bash
# 1. Run the official mteb package against the served embedding model.
python3 benchmarks/mteb_submit.py \
  --provider=ollama \
  --tasks=SciFact,NFCorpus \
  --source=kb-endpoint \
  --embedding-endpoint=http://localhost:11434/v1 \
  --output=benchmarks/results/mteb/qwen3-embedding-0.6b.json

# 2. Record the report + ledger entry.
npm run bench:mteb -- --result=benchmarks/results/mteb/qwen3-embedding-0.6b.json --provider=ollama
```

`--source=kb-endpoint` ranks the exact served model the product ships (faithful
to §8); `--source=sentence-transformers` loads the HF checkpoint via the `mteb`
loader instead.

## Honesty contract

No score is fabricated. With no `mteb` package or no served model, the recorder
produces a *pending* record that says so. A real result needs the `mteb` package
and the active embedding model served (Ollama).

## Scope of the committed records

The committed records under `benchmarks/results/mteb/` (`nomic.json`,
`qwen3.json`) cover a **two-task subset of MTEB — `SciFact` and `NFCorpus`
only** — not the full MTEB benchmark. Their `tasks` arrays list exactly those
two entries, and `mean_main_score` is the mean over just those two tasks. **They
are not a full-MTEB result and must not be read as an MTEB leaderboard rank.**

Why these two tasks: both are small BEIR retrieval datasets, so a run is quick
against a served model. `SciFact` (scientific claim verification) is also the
dataset the pipeline baseline uses (see
`benchmarks/results/beir/baseline/README.md`, where it is described as a
BM25-friendly domain), which keeps the embedding-model number anchored to a
domain the pipeline already reports. `NFCorpus` (medical information retrieval)
adds a second, distinct domain that the pipeline baseline does not cover.
Together they are a quick sanity signal on the served model, **not** a coverage
claim.

How to interpret: `mean_main_score` is the mean of MTEB's `main_score` (nDCG@10
for these two retrieval tasks) over `SciFact` and `NFCorpus`. Use it to compare
embedding models on these same two tasks — **not** as a position in the
published MTEB ranking, which aggregates dozens of tasks across several task
types. Only compare records that share the same `tasks` list: because the mean
mixes every task in the record, adding a task changes the mean and breaks
comparison with older records.

How to extend coverage: pass more tasks to the runner's `--tasks` flag on
`benchmarks/mteb_submit.py` (comma separated, e.g. illustratively
`--tasks=SciFact,NFCorpus,FiQA2018,ArguAna`; see the **Running** section above
for the full invocation) and re-record. The recorder folds **every** per-task
result JSON it finds under `--results-dir` into the record's `tasks` array and
recomputes `mean_main_score` over all of them — it does not filter by the
`--tasks` you just requested. So run against a clean/isolated `--results-dir`:
stale results left in that directory from an earlier run are folded in too and
would silently widen the record's scope beyond the current `--tasks`. After
re-recording, confirm the record's `tasks` array is exactly the set you
intended, and if task coverage grows, update this note to match.
