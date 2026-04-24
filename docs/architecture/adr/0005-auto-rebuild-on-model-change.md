# 0005 — Auto-rebuild on model change (probably wrong)

- **Status:** Accepted with reservations — see "More Information" and RFC 007 follow-ups
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

Vectors from one embedding model are not comparable to vectors from another. If the user changes `EMBEDDING_PROVIDER` or their provider's model env var with an existing `faiss.index` on disk, the server has to decide what to do:

- Silently continue (returns nonsense).
- Error out until the user manually resolves it.
- Rebuild automatically, incurring one full re-embedding pass.

The current code picks option 3, guarded by a `model_name.txt` tag. Whether this is the right call is debatable.

## Decision Drivers

- **Correctness over speed.** Never mix incompatible vectors in one index.
- **Surprise minimization.** A user flipping `OLLAMA_MODEL` expects *something* to happen that eventually produces correct results.
- **Data cost.** Real-provider embedding calls for hundreds of files can cost real money (OpenAI) or real time (HuggingFace).
- **Failure-mode visibility.** A silent 10-minute rebuild on startup is worse than a loud error that prompts the user to confirm.

## Considered Options

1. **Auto-rebuild on mismatch** — current. `src/FaissIndexManager.ts:153-164` deletes `faiss.index`, sets `faissIndex = null`, writes the new model name.
2. **Refuse to start** with an error message telling the user to `rm -rf $FAISS_INDEX_PATH` (or similar) and restart.
3. **Rebuild only on `FORCE_REINDEX=1`**, otherwise refuse.
4. **Two indexes side-by-side**, keyed by model name; never delete the old.

## Decision Outcome

**Option 1** is in production. The fallback branch at `src/FaissIndexManager.ts:302-346` handles the rebuild on the next `retrieve_knowledge` call.

## Pros and Cons

**Pros:**
- Zero configuration recovery — flipping the env var eventually "just works".
- No orphan on-disk state to clean up later.
- Cost is local and bounded (one full rebuild, then back to normal warm-query cost).

**Cons (the "probably wrong" part):**
- **Silently expensive.** The rebuild can cost real dollars (OpenAI) or real minutes (HuggingFace) the user didn't explicitly authorize. The log line at `src/FaissIndexManager.ts:154` is the only signal.
- **Silently destructive.** `unlink(faiss.index)` (`:157`) throws away work the user paid to produce. If the env change was an accident (shell oops, wrong `OLLAMA_MODEL` pulled), there is no undo.
- **Sidecar mismatch.** The hash sidecars survive the rebuild because they hash source content, not embeddings — which is correct, but confusing: a user inspecting `.index/` sidecars after a model switch sees identical hashes and might assume nothing happened.

## More Information

- RFC 007 follow-ups discuss making this loud: log a `warn` with the estimated rebuild cost, or gate it behind an explicit flag. That conversation is still open.
- The error-out-and-require-manual-reset path (option 2) is not obviously worse — it's just more friction. A reasonable future change is to flip the default to option 2 and require `AUTO_REBUILD_ON_MODEL_CHANGE=1` to opt into current behaviour.
- See [`../sequence-reindex.md`](../sequence-reindex.md) for the full flow this ADR describes.
