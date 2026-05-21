# Ingest Chaos Test Suite

This suite exercises deterministic ingest fault classes that are too broad or
too timing-sensitive for the default per-PR Jest run.

Run it locally with:

```bash
npm run test:chaos
```

The nightly workflow runs the suite on a small fixture KB and asserts that
faults leave the dense index recoverable:

| Scenario | Fault class | Recovery assertion |
| --- | --- | --- |
| save-complete interruption | process death after FAISS commit but before sidecar commit | `initialize()` replays the pending manifest and writes missing sidecars |
| disk-full during save | `ENOSPC` while saving the versioned FAISS directory | no active index symlink is published and retry can clear orphan staging |
| embedding timeout | provider timeout during `embedDocuments` | ingest summary fails in `indexing`, the file is quarantined, and canonical classification maps to provider recovery |
| malformed embedding response | provider returns the wrong vector count | ingest fails before persistence and quarantines the source file |
| contextual-preface timeout storm | repeated LLM timeout | per-file circuit breaker stops after five chunk-level timeouts and records failed sidecar entries |

Keep this suite opt-in. New scenarios should prefer deterministic injection
points over wall-clock sleeps or real signals.
