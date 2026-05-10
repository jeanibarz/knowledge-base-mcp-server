# Requirements

- [Retrieval eval command](retrieval-eval.md)

## Search

### FR-SUPERSEDED-232: Superseded Memory Review
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall provide a read-only `kb superseded` command that scans markdown notes in a selected knowledge base and reports notes that are candidates for manual supersession or contradiction review.

**Acceptance Criteria:**
- [x] Given notes with lifecycle frontmatter such as `contradicted_by`, deprecated-like `status` or `review_status`, stale `last_verified_at`, or low active `confidence`, when `kb superseded --kb=<name>` runs, then the report includes reason codes and relevant frontmatter for each candidate.
- [x] Given a semantically similar newer note from the same knowledge base, when it is newer, higher-confidence, or active while the candidate is older or lower-confidence, then the report includes `newer_near_neighbor` evidence with the evidence path and score.
- [x] Given clean notes, when `--include-clean` is omitted, then the report excludes them; when `--include-clean` is present, then the report includes them without mutation.
- [x] Given `--format=json`, when candidates are found, then the output is machine-readable and includes totals, candidates, reason codes, evidence, and suggested manual actions.

**Linked Tests:** TS-SUPERSEDED-232
**Dependencies:** RFC005, FR-SEARCH-192

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
