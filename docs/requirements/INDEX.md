# Requirements

- [Retrieval eval command](retrieval-eval.md)

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
