# Testing

- [Retrieval eval command](retrieval-eval.md)

## Search

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
