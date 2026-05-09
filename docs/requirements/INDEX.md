# Requirements

- [Retrieval eval command](retrieval-eval.md)

## Indexing

### NFR-INDEX-236: Batched Changed-File Embeddings
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall embed changed-file chunks during `updateIndex` in bounded document batches before saving the FAISS index.
**Rationale:** Batching amortizes embedding-provider round trips for refreshes and cold rebuilds while preserving the existing save-once durability boundary.

**Acceptance Criteria:**
- [x] Given multiple changed files, when their chunks fit within `INDEXING_BATCH_SIZE`, then `updateIndex` shall seed an empty FAISS store with one `fromTexts` call and shall not call `addDocuments` per file.
- [x] Given changed-file chunks exceeding `INDEXING_BATCH_SIZE`, then `updateIndex` shall append the remaining chunks with one `addDocuments` call per bounded batch.
- [x] Given a successful batched update, then `updateIndex` shall persist the FAISS store once and shall write hash sidecars only after that save succeeds.
- [x] Given an invalid or unset `INDEXING_BATCH_SIZE`, then the system shall use conservative provider defaults.

**Linked Tests:** TS-INDEX-236
**Dependencies:** RFC007

## Search

### FR-SEARCH-192: Scoped Search Staleness
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall report staleness for the selected knowledge base when `kb search --kb=<name>` scopes a query.

**Acceptance Criteria:**
- [x] Given a scoped search, when files in the selected knowledge base are stale, then the stale counts reflect that selected knowledge base.
- [x] Given an unscoped search, when files across knowledge bases are stale, then the stale counts reflect global drift.
- [x] Given JSON output for a scoped search, when scoped and global stale counts differ, then the payload distinguishes scoped fields from global fields.

**Linked Tests:** TS-SEARCH-192
**Dependencies:** RFC005
