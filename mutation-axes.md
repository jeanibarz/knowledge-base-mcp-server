# KB CLI evolution mutation axes

Candidate axes currently seeded in `state.json`:

- `chunking` — `KB_CHUNK_SIZE` / `KB_CHUNK_OVERLAP` retrieval-layout levers.
- `indexing-batch` — `INDEXING_BATCH_SIZE` provider-call and memory tradeoff.

When adding candidate arms, append the new axis here with the reason it is worth
testing and any closed forms that should not be reopened.
