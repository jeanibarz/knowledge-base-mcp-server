# Requirements

- [Retrieval eval command](retrieval-eval.md)

## Observability

### FR-OBS-237: Last Index Update Summary
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall expose the latest in-process `updateIndex` run summary through `kb_stats` and `kb doctor`.

**Acceptance Criteria:**
- [x] Given no update has run in the current process, when stats or doctor output is requested, then the latest update status is `never_run`.
- [x] Given an index update runs, when stats are requested, then the payload reports the run scope, model id, timestamps, duration, file counters, chunk counters, save outcome, sidecar outcome, and capped failure summaries.
- [x] Given an index update completes with recoverable loader failures, when stats are requested, then the status is `partial` and failure summaries do not expose absolute paths.
- [x] Given an index update throws, when stats are requested after the failure, then the latest update status is `failed`.

**Linked Tests:** TS-OBS-237
**Dependencies:** FR-SEARCH-192

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

## Stats

### FR-STATS-230: Local Stats CLI
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall expose a read-only `kb stats` CLI command that reports the active index statistics available through the MCP `kb_stats` tool.

**Acceptance Criteria:**
- [x] Given an active model index, when a user runs `kb stats --format=json`, then the CLI emits the shared `computeKbStats` payload without refreshing the index.
- [x] Given `kb stats --kb=<name>`, when the knowledge base exists, then the CLI reports only that knowledge base.
- [x] Given markdown output, when stats are available, then the CLI prints a compact per-KB table plus embedding, index path, version, and uptime metadata.
- [x] Given an unknown flag or invalid format, when the user runs `kb stats`, then the CLI exits with code 2.

**Linked Tests:** TS-STATS-230
**Dependencies:** kb_stats MCP tool, multi-model active index resolution
