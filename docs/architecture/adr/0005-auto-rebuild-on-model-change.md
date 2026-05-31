# 0005 — Auto-rebuild on model change (probably wrong)

- **Status:** Superseded by RFC 013 multi-model layout
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

Vectors from one embedding model are not comparable to vectors from another. If the user changes `EMBEDDING_PROVIDER` or their provider's model env var with an existing `faiss.index` on disk, the server has to decide what to do:

- Silently continue (returns nonsense).
- Error out until the user manually resolves it.
- Rebuild automatically, incurring one full re-embedding pass.

The original code picked option 3, guarded by a root-level `model_name.txt` tag.
That behavior is now historical.

## Decision Drivers

- **Correctness over speed.** Never mix incompatible vectors in one index.
- **Surprise minimization.** A user flipping `OLLAMA_MODEL` expects *something* to happen that eventually produces correct results.
- **Data cost.** Real-provider embedding calls for hundreds of files can cost real money (OpenAI) or real time (HuggingFace).
- **Failure-mode visibility.** A silent 10-minute rebuild on startup is worse than a loud error that prompts the user to confirm.

## Considered Options

1. **Auto-rebuild on mismatch** — historical. The old implementation deleted
   the single FAISS store when `model_name.txt` did not match the current env.
2. **Refuse to start** with an error message telling the user to `rm -rf $FAISS_INDEX_PATH` (or similar) and restart.
3. **Rebuild only on `FORCE_REINDEX=1`**, otherwise refuse.
4. **Two indexes side-by-side**, keyed by model name; never delete the old.

## Decision Outcome

**Current outcome: option 4.** RFC 013 made model state side-by-side under
`$FAISS_INDEX_PATH/models/<model_id>/`. `active.txt` selects the default model,
and `KB_ACTIVE_MODEL` or per-call overrides can select another registered model.
Changing provider/model env vars no longer destroys an existing model directory.

## Pros and Cons

**Pros:**
- Existing model indexes remain available after registering or activating another
  model.
- Operators can compare models and switch back without re-embedding.
- Paid-provider rebuilds are explicit through `kb models add` or refresh/reindex
  commands rather than a silent destructive startup side effect.

**Cons (the "probably wrong" part):**
- Side-by-side model directories use more disk than a single overwritten store.
- Operators must manage inactive models with `kb models remove` when they no
  longer want to keep them.

## More Information

- See [`../sequence-reindex.md`](../sequence-reindex.md) for the current
  model-add, activation, and forced-rebuild flows.
