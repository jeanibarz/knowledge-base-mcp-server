# Testing

- [Retrieval eval command](retrieval-eval.md)

## Indexing

### TS-INDEX-358: Default Text-First Ingest Filter
**Requirement:** NFR-INDEX-358

**Test Cases:**
- `filterIngestablePaths` shall exclude `.pdf` files by default while accepting markdown notes.
- `filterIngestablePaths` shall accept `.pdf` files when `.pdf` is supplied through `extraExtensions`.
- `filterIngestablePaths` shall let `excludePaths` suppress PDF files even after PDF extension opt-in.
- `FaissIndexManager.updateIndex` shall let `INGEST_EXCLUDE_PATHS` suppress PDFs after `.pdf` extension opt-in.
- `FaissIndexManager.updateIndex` shall rebuild from current ingestable files when the freshness manifest records an older base allowlist that admitted PDFs.
- `RecursiveFsWatcher` shall honor ingest exclusion globs for otherwise ingestable markdown paths.

### TS-INDEX-236: Batched Changed-File Embeddings
**Requirement:** NFR-INDEX-236

**Test Cases:**
- `resolveIndexingBatchSize` shall use provider defaults and validate `INDEXING_BATCH_SIZE`.
- `FaissIndexManager.updateIndex` shall batch multiple changed files into a single seed call when they fit the configured batch size.
- `FaissIndexManager.updateIndex` shall split changed-file documents into bounded append batches when the configured batch size is exceeded.
- `FaissIndexManager.updateIndex` shall keep the one-save-at-end invariant and write sidecar hashes only after a successful save.
- `FaissIndexManager` shall resolve unset batch defaults from an explicitly configured manager provider.

### TS-INDEX-281: Duplicate Chunk Embedding Compaction
**Requirement:** NFR-INDEX-281

**Test Cases:**
- `normalizeChunkTextForEmbedding` shall collapse insignificant Unicode and whitespace differences before indexing dedupe.
- `FaissIndexManager.updateIndex` shall call the embedding provider with unique normalized changed-file chunk text while preserving every duplicate source metadata entry in the FAISS insertion path.

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

### TS-OBS-316: Refresh Progress Heartbeats
**Requirement:** FR-OBS-316

**Test Cases:**
- `FaissIndexManager.updateIndex` shall emit one `embed` progress event for each bounded embedding batch.
- `formatRefreshProgressLine` shall format embedding batch progress as concise operator-facing stderr text.
- `createRefreshProgressReporter` shall write progress through the stderr writer and shall not write to stdout.
- `recordRefreshProgressTiming` shall copy refresh batch counters and completed phase elapsed times into the flat timing payload.

## Search

### TS-ASK-382: Cited Ask Transcript Records
**Requirement:** FR-ASK-382

**Test Cases:**
- `parseAskArgs` shall parse `--save-transcript`, `--title=<title>`, and `--yes`.
- `parseAskArgs` shall reject transcript saves without `--yes` or without a target `--kb=<name>`.
- `buildAskTranscriptMarkdown` shall include the question, answer, citation paths, source chunk ids, LLM provenance, retrieval metadata, and timing metadata when present.
- `createAskTranscriptNote` shall create a new slugged markdown note and shall refuse to overwrite an existing transcript note.

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
