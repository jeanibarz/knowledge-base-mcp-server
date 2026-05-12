---
fixture_owner: retrieval-eval
status: stable
topic: storage
---

# Atomic FAISS Save

FAISS persistence writes a replacement index to a temporary path, verifies that
the write completed, and then renames it into place. The rename step keeps
readers from observing a partially written index.

The docstore metadata is saved alongside the vector index so a restored pair
represents the same chunk set.

