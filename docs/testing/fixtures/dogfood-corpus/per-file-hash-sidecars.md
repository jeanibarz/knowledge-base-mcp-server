---
fixture_owner: retrieval-eval
status: stable
topic: indexing
---

# Per-File Hash Sidecars

The indexer decides whether to re-embed a file by comparing the stored content
hash, parser version, and chunking settings against the current source file.
Modification time alone is not the source of truth because copied files and
checkout operations can preserve or rewrite timestamps without changing text.

When the content hash and parser metadata match, the existing chunks can be
reused. When either value changes, only that file's chunks are replaced in the
docstore and vector index.

