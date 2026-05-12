# 0008 - Ingest quarantine JSONL over SQLite

- **Status:** Accepted (#213)
- **Date:** 2026-05-12
- **Deciders:** Repo owner

## Context and Problem Statement

Per-file ingest failures used to be logged and retried on every refresh. A
single poison file could therefore repeatedly spend loader, embedding, or index
work without giving the operator a durable list of files to fix.

The project already keeps per-KB ingest sidecars under `<kb>/.index/` and
serializes those writes with `withSidecarLock`. The quarantine manifest needs to
live in that same content-owned boundary, be readable by humans, and avoid a new
runtime service or migration.

## Decision

Store quarantine state in `<kb>/.index/quarantine.jsonl`.

Each line is a schema-versioned `ingest-quarantine.v1` record with the
KB-relative path, source file hash when available, error category/code,
fingerprint, first/last attempt timestamps, retry count, next retry timestamp,
ack flag, dead-letter timestamp, and a short message. Writers rewrite the file
atomically under the existing sidecar lock.

JSONL is deliberately chosen over SQLite for v1:

- it stays inside the existing `.index` content sidecar layout;
- it is grep-friendly and easy to inspect in broken local environments;
- it needs no schema migration machinery;
- the existing sidecar lock is sufficient for the short read-modify-write
  critical section.

## Consequences

- Normal retrieval output is unchanged when no file is quarantined.
- A corrupted line can be ignored without making the whole KB unreadable.
- Concurrent updates remain serialized by the same cross-model sidecar lock as
  hash sidecars.
- Large installations are bounded by a 1000-entry cap per KB; the manifest is
  operational signal, not authoritative source content.

SQLite may become attractive if quarantine grows into a query-heavy operator
database. That would require a migration plan and a separate integrity story;
it is intentionally out of scope for #213.

## Validation

The validation gate for #213 is:

1. Loader failures create `ingest-quarantine.v1` records.
2. Backoff/dead-letter entries are skipped until retry policy allows another
   attempt.
3. File content changes or successful indexing remove the entry.
4. `kb_stats`, `kb doctor`, and `kb quarantine` expose the same manifest state.
