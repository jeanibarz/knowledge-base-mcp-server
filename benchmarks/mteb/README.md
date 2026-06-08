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
