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

### TS-OBS-315: Persisted Last Index Update Summary
**Requirement:** FR-OBS-315

**Test Cases:**
- `FaissIndexManager.updateIndex` shall atomically persist the completed summary under the active model directory.
- `FaissIndexManager.updateIndex` shall persist failed and partial summaries with capped sanitized failure details.
- `computeKbStats` shall use the persisted summary when the manager summary is `never_run`.
- `computeKbStats` shall ignore missing or malformed persisted summaries and keep the manager summary.
- `buildDoctorReport` shall use the persisted summary for the active model when no explicit in-process summary is supplied.

## Search

### TS-SUPERSEDED-232: Superseded Memory Review
**Requirement:** FR-SUPERSEDED-232

**Test Cases:**
- `parseSupersededArgs` shall validate `--kb=<name>`, `--format=md|json`, `--k=<int>`, and `--include-clean`.
- `supersededCheck` shall flag explicit contradiction, deprecated lifecycle status, stale verification dates, and low-confidence active notes.
- `supersededCheck` shall add `newer_near_neighbor` evidence only for same-KB semantic hits that are not the candidate file and are newer, higher-confidence, or active.
- `formatSupersededJson` and `formatSupersededMarkdown` shall include candidate paths, reasons, evidence, and totals without writing to the knowledge base.

### TS-SEARCH-192: Scoped Search Staleness
**Requirement:** FR-SEARCH-192

**Test Cases:**
- `computeStaleness` shall count modified and new files in the selected KB separately from other KBs.
- `computeStaleness` shall preserve global modified and new file counts for unscoped searches.
- `formatFreshnessFooter` and JSON payload tests shall verify scoped fields remain distinct from global fields.

## Stats

### TS-STATS-230: Local Stats CLI
**Requirement:** FR-STATS-230

**Test Cases:**
- `runStats` shall print the `computeKbStats` payload unchanged for `--format=json`.
- `runStats` shall pass `--kb=<name>` through as `knowledgeBaseName`.
- `runStats` shall load the active model read-only and shall not call `updateIndex`.
- `runStats` shall print markdown table output with per-KB rows and index metadata.
- `runStats` shall reject unknown flags with exit code 2.
- `runStats` shall emit structured JSON errors for missing knowledge bases when JSON output is requested.
