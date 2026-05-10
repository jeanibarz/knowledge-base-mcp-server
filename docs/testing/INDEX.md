# Testing

- [Retrieval eval command](retrieval-eval.md)

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
