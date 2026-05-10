# Testing

- [Retrieval eval command](retrieval-eval.md)

## Indexing

### TS-INDEX-236: Batched Changed-File Embeddings
**Requirement:** NFR-INDEX-236

**Test Cases:**
- `resolveIndexingBatchSize` shall use provider defaults and validate `INDEXING_BATCH_SIZE`.
- `FaissIndexManager.updateIndex` shall batch multiple changed files into a single seed call when they fit the configured batch size.
- `FaissIndexManager.updateIndex` shall split changed-file documents into bounded append batches when the configured batch size is exceeded.
- `FaissIndexManager.updateIndex` shall keep the one-save-at-end invariant and write sidecar hashes only after a successful save.
- `FaissIndexManager` shall resolve unset batch defaults from an explicitly configured manager provider.

## Observability

### TS-OBS-237: Last Index Update Summary
**Requirement:** FR-OBS-237

**Test Cases:**
- `FaissIndexManager` shall initialize the latest update summary as `never_run`.
- `FaissIndexManager.updateIndex` shall record success counters for changed and unchanged files.
- `FaissIndexManager.updateIndex` shall retain a failed summary when save persistence throws.
- `computeKbStats` shall include the manager's latest update summary in the payload.
- `buildDoctorReport` and `formatDoctorMarkdown` shall include the latest update summary.

## Search

### TS-SEARCH-192: Scoped Search Staleness
**Requirement:** FR-SEARCH-192

**Test Cases:**
- `computeStaleness` shall count modified and new files in the selected KB separately from other KBs.
- `computeStaleness` shall preserve global modified and new file counts for unscoped searches.
- `formatFreshnessFooter` and JSON payload tests shall verify scoped fields remain distinct from global fields.
